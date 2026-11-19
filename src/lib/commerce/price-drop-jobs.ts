/**
 * Store plan Phase 8, batch 5: the wishlist price-drop nudge (job commerce.price_drop, queued by a trigger on shop_variants in the
 * transaction that lowers a wishlisted variant's price; rules in price-drops.ts).
 *
 * One run handles one drop: it records the drop (found again on a replay by the job's key), then for each contact who saved the
 * variant before the drop decides, sends or refuses. A contact is never messaged when: the shop has the nudges off, the drop is
 * under 5% or no longer holds (the price went back up), the variant is not on sale or has no published shop link, the contact is
 * blocked or has opted out (consentRefusal, any time), an agent has taken over the chat (agentHoldRefusal), the contact was nudged
 * about this variant in the last 7 days, or no free text (inside the 23 h customer window) and no approved MARKETING template of
 * the 'price_drop' notice kind (outside it) can carry the message. Every refusal is decided before dispatchOnce and recorded on the
 * contact's nudge row for this drop (one row per drop and contact is the dedupe). The send goes through dispatchOnce with the stable
 * key price_drop:<drop>:<contact>; an uncertain outcome closes the row as outcome_unknown and is never sent again. Logs carry ids and
 * codes only: no phone numbers, message text or prices.
 */
import { createAdminClient } from '@/lib/data/admin';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import { appOrigin } from '@/lib/auth/csrf';
import { isSuspended } from '@/lib/billing/suspension';
import { engineSendTemplate, engineSendText } from '@/lib/automations/meta-send';
import type { TenantTransaction } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { dispatchOnce, UncertainDispatchError } from '@/lib/jobs/dispatch';
import { assertWhatsAppConversation, getNumberConfig, isNumberDisconnected, NoNumberError } from '@/lib/whatsapp/numbers';
import { extractVariableIndices } from '@/lib/whatsapp/template-validators';
import { resolveContactSendTarget } from '@/lib/whatsapp/wa-identity';
import { loadBuyerSettingsTx } from './buyer-settings';
import { pickConversation, rejectedByProvider, windowOpen, type ContactRow } from './cart-followup-jobs';
import { minorToDecimalString } from './money';
import {
  agentHoldRefusal, consentRefusal, followupBodyValues, loadTemplate, noticeTemplate, NOTICE_TEMPLATE_CATEGORY, orderTemplateOutcome, worker,
  type TemplateRow,
} from './order-followup';
import { dropStillHolds, inCooldown, isNudgeWorthyDrop, PRICE_DROP_BATCH, PRICE_DROP_JOB, priceNudgeIntentKey, type PriceDropPayload } from './price-drops';
import { PUBLIC_SHOP_PATH } from './shop-templates';
import { linkMessageText } from './storefront';

interface Facts { productId: string; name: string; handle: string; currency: string; priceMinor: number }

/** The variant, when the shop can sell it now and a published shop links to it; else null. */
function loadFacts(accountId: string, variantId: string): Promise<Facts | null> {
  return worker(accountId, async (tx) => {
    const [row] = await tx.$queryRaw<{ product_id: string; name: string; option_values: Record<string, string> | null; handle: string;
      currency: string | null; price_minor: bigint }[]>`
      SELECT p.id::text AS product_id, p.name, v.option_values, s.handle, c.currency, v.price_minor
      FROM shop_variants v JOIN shop_products p ON p.account_id=v.account_id AND p.id=v.product_id
      JOIN shop_storefronts s ON s.account_id=v.account_id AND s.published
      JOIN commerce_settings c ON c.account_id=v.account_id
      WHERE v.account_id=${accountId}::uuid AND v.id=${variantId}::uuid AND shop_product_live(p.status, p.publish_at, p.hide_at)
        AND v.archived_at IS NULL AND v.price_minor IS NOT NULL AND COALESCE(shop_variant_availability(v.account_id, v.id), 1) > 0
        AND NOT p.is_digital`;
    if (!row || !row.currency) return null;
    const options = Object.values(row.option_values ?? {}).filter(Boolean).join(', ');
    return { productId: row.product_id, name: options ? `${row.name} (${options})` : row.name, handle: row.handle, currency: row.currency, priceMinor: Number(row.price_minor) };
  });
}

type Plan =
  | { kind: 'close'; reason: string }
  | { kind: 'sent' }
  | { kind: 'send'; contactId: string; conversationId: string; text: string | null; template: TemplateRow | null; values: string[] };

const priceText = (minor: number, currency: string) => `${currency} ${minorToDecimalString(minor, currency)}`;

function plan(accountId: string, dropId: string, contactId: string, variantId: string, facts: Facts, payload: PriceDropPayload, now: Date): Promise<Plan> {
  return worker(accountId, async (tx): Promise<Plan> => {
    // An earlier attempt already claimed the send: its intent decides, never a fresh plan.
    const [intent] = await tx.$queryRaw<{ status: string }[]>`
      SELECT status FROM outbound_intents WHERE account_id=${accountId}::uuid AND idempotency_key=${`${accountId}:${priceNudgeIntentKey(dropId, contactId)}`}`;
    if (intent?.status === 'accepted') return { kind: 'sent' };
    if (intent?.status === 'failed') return { kind: 'close', reason: 'provider_rejected' };
    if (intent) return { kind: 'close', reason: 'outcome_unknown' };
    const [contact] = await tx.$queryRaw<ContactRow[]>`
      SELECT id::text AS id, name, phone, wa_user_id, blocked_at, opted_out_at FROM contacts
      WHERE account_id=${accountId}::uuid AND id=${contactId}::uuid`;
    if (!contact) return { kind: 'close', reason: 'contact_missing' };
    // A marketing message: a block, and an opt-out at any time, refuse it for good.
    const consent = consentRefusal(contact, new Date(0));
    if (consent) return { kind: 'close', reason: consent };
    const [recent] = await tx.$queryRaw<{ at: Date | null }[]>`
      SELECT max(created_at) AS at FROM shop_price_nudges WHERE account_id=${accountId}::uuid AND contact_id=${contactId}::uuid
        AND variant_id=${variantId}::uuid AND drop_id<>${dropId}::uuid AND status IN ('pending','sent')`;
    if (inCooldown(recent?.at ?? null, now)) return { kind: 'close', reason: 'cooldown' };
    if (await isSuspended(tx, accountId)) return { kind: 'close', reason: 'workspace_suspended' };
    if (!resolveContactSendTarget(contact)) return { kind: 'close', reason: 'no_address' };
    const conversation = await pickConversation(tx, accountId, contact.id, null);
    if (!conversation) return { kind: 'close', reason: 'no_conversation' };
    const held = agentHoldRefusal('price_drop', conversation.bot_paused);
    if (held) return { kind: 'close', reason: held };
    let config;
    try {
      assertWhatsAppConversation(conversation);
      config = await getNumberConfig(tx, accountId, conversation.whatsapp_config_id);
    } catch (error) {
      if (error instanceof NoNumberError) return { kind: 'close', reason: 'number_unavailable' };
      throw error;
    }
    if (isNumberDisconnected(config)) return { kind: 'close', reason: 'number_unavailable' };
    const url = `${appOrigin()}${PUBLIC_SHOP_PATH}${facts.handle}/p/${facts.productId}`;
    const priceNow = priceText(facts.priceMinor, facts.currency);
    if (windowOpen(conversation, now))
      return { kind: 'send', contactId: contact.id, conversationId: conversation.id, template: null, values: [],
        text: linkMessageText(getT('ShopPublic.priceDrop')('text', { product: facts.name, price: priceNow, was: priceText(payload.fromMinor, facts.currency) }), url) };
    const setting = await noticeTemplate(tx, accountId, 'price_drop');
    if (!setting) return { kind: 'close', reason: 'no_template' };
    const template = await loadTemplate(tx, accountId, setting.name, setting.language);
    const refusal = orderTemplateOutcome(template, config, NOTICE_TEMPLATE_CATEGORY.price_drop);
    if (refusal || !template) return { kind: 'close', reason: refusal?.reason ?? 'template_not_found' };
    // {{1}} customer name, {{2}} product (with its options), {{3}} the new price, {{4}} the product link (a variable URL button is not supported).
    return { kind: 'send', contactId: contact.id, conversationId: conversation.id, template, text: null, values: [contact.name || '-', facts.name, priceNow, url] };
  });
}

/** Write the nudge row's end state; a row already settled is left alone. */
function settle(accountId: string, dropId: string, contactId: string, variantId: string, status: 'sent' | 'closed', reason: string | null) {
  return worker(accountId, (tx) => tx.$executeRaw`
    INSERT INTO shop_price_nudges(account_id, drop_id, contact_id, variant_id, status, reason, settled_at)
    VALUES(${accountId}::uuid, ${dropId}::uuid, ${contactId}::uuid, ${variantId}::uuid, ${status}, ${reason}, now())
    ON CONFLICT (account_id, drop_id, contact_id) DO UPDATE SET status=EXCLUDED.status, reason=EXCLUDED.reason, settled_at=EXCLUDED.settled_at
      WHERE shop_price_nudges.status='pending'`);
}

type Result = 'sent' | 'closed' | 'skipped';

async function nudgeOne(accountId: string, dropId: string, contactId: string, variantId: string, facts: Facts, payload: PriceDropPayload, now: Date): Promise<Result> {
  // One row per drop and contact: a settled one means this contact is done (a replay of the job, or a duplicate wishlist row).
  const [existing] = await worker(accountId, (tx) => tx.$queryRaw<{ status: string }[]>`
    SELECT status FROM shop_price_nudges WHERE account_id=${accountId}::uuid AND drop_id=${dropId}::uuid AND contact_id=${contactId}::uuid`);
  if (existing && existing.status !== 'pending') return 'skipped';
  const p = await plan(accountId, dropId, contactId, variantId, facts, payload, now);
  if (p.kind === 'close') { await settle(accountId, dropId, contactId, variantId, 'closed', p.reason); return 'closed'; }
  if (p.kind === 'sent') { await settle(accountId, dropId, contactId, variantId, 'sent', null); return 'sent'; }
  // Claim the row before anything leaves; a crash after this leaves it pending and the next run asks dispatchOnce again (never a second message).
  await worker(accountId, (tx) => tx.$executeRaw`INSERT INTO shop_price_nudges(account_id, drop_id, contact_id, variant_id)
    VALUES(${accountId}::uuid, ${dropId}::uuid, ${contactId}::uuid, ${variantId}::uuid) ON CONFLICT (account_id, drop_id, contact_id) DO NOTHING`);
  const db = createAdminClient({ accountId, role: 'owner' });
  const userId = await resolveAuditUserId(db, accountId);
  const base = { accountId, userId, conversationId: p.conversationId, contactId: p.contactId };
  const key = priceNudgeIntentKey(dropId, contactId);
  try {
    if (p.text !== null) {
      const text = p.text;
      await dispatchOnce(accountId, key, () => engineSendText({ ...base, text }));
    } else {
      const template = p.template!;
      const body = followupBodyValues(template, p.values);
      const headerVar = template.header_type === 'text' && extractVariableIndices(template.header_content ?? '').length > 0;
      await dispatchOnce(accountId, key, () => engineSendTemplate({
        ...base, templateName: template.name, language: template.language ?? undefined, params: body, bodyValuesOnly: false,
        messageParams: { body, ...(headerVar ? { headerText: (p.values[1] ?? '-').slice(0, 60) } : {}) },
      }));
    }
  } catch (error) {
    // An uncertain send is closed for staff to see and never sent again.
    if (error instanceof UncertainDispatchError) { await settle(accountId, dropId, contactId, variantId, 'closed', 'outcome_unknown'); return 'closed'; }
    if (rejectedByProvider(error)) { await settle(accountId, dropId, contactId, variantId, 'closed', 'provider_rejected'); return 'closed'; }
    throw error;
  }
  await settle(accountId, dropId, contactId, variantId, 'sent', null);
  return 'sent';
}

/** Run one price drop (see the module comment). Returns counts; a drop that does not qualify returns zeros. */
export async function handlePriceDropJob(accountId: string, payload: PriceDropPayload, now = new Date()): Promise<{ sent: number; closed: number; skipped: number }> {
  const result = { sent: 0, closed: 0, skipped: 0 };
  const { variantId, fromMinor, toMinor, key } = payload;
  if (!isNudgeWorthyDrop(fromMinor, toMinor)) return result;
  const enabled = await worker(accountId, async (tx) => (await loadBuyerSettingsTx(tx, accountId)).price_drop_nudges_enabled);
  if (!enabled) return result;
  const facts = await loadFacts(accountId, variantId);
  if (!facts || !dropStillHolds(facts.priceMinor, toMinor)) return result;
  const drop = await worker(accountId, async (tx) => {
    const [row] = await tx.$queryRaw<{ id: string; created_at: Date }[]>`
      INSERT INTO shop_price_drops(account_id, variant_id, from_minor, to_minor, source_key)
      VALUES(${accountId}::uuid, ${variantId}::uuid, ${BigInt(fromMinor)}, ${BigInt(toMinor)}, ${key})
      ON CONFLICT (account_id, source_key) DO UPDATE SET source_key=EXCLUDED.source_key RETURNING id::text AS id, created_at`;
    return row;
  });
  const afterId = payload.afterId ?? null;
  // Only contacts who had saved it by the time the drop was first seen.
  const items = await worker(accountId, (tx: TenantTransaction) => tx.$queryRaw<{ id: string; contact_id: string }[]>`
    SELECT id::text AS id, contact_id::text AS contact_id FROM shop_wishlist_items
    WHERE account_id=${accountId}::uuid AND variant_id=${variantId}::uuid AND created_at <= ${drop.created_at}
      AND (${afterId}::uuid IS NULL OR id > ${afterId}::uuid)
    ORDER BY id LIMIT ${PRICE_DROP_BATCH}`);
  for (const item of items) {
    const done = await nudgeOne(accountId, drop.id, item.contact_id, variantId, facts, payload, now);
    result[done]++;
  }
  if (items.length === PRICE_DROP_BATCH) {
    const last = items[items.length - 1].id;
    await worker(accountId, (tx) => tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key)
      VALUES(${PRICE_DROP_JOB},${accountId}::uuid,${JSON.stringify({ ...payload, afterId: last })}::jsonb,${`${key}:next:${last}`.slice(0, 250)})
      ON CONFLICT(dedupe_key) DO NOTHING`);
  }
  return result;
}
