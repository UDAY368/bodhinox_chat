/**
 * Store plan Phase 3, package 3: the inbound "NOTIFY <CODE>" claim and the
 * commerce.back_in_stock job (rules and queueing are in stock-alerts.ts).
 *
 * Claim: the first sender of an unexpired code of this workspace's shop number
 * owns it; a code of another workspace, another number, someone else or an
 * unknown one is ordinary text and counts against the sender's miss limit (the
 * same counter as "ORDER <CODE>"). Only the one acknowledgement runs inside the
 * inbound job's stage checkpoint.
 *
 * Job: for each claimed, open alert of the restocked variant, re-check that it
 * is still on sale, then send once through dispatchOnce (stock_alert:<id>:notify):
 * free text with the product link inside the customer window, else the
 * workspace's approved MARKETING template of notice kind back_in_stock; none set
 * -> not sent, the reason is recorded and the alert waits for the next restock.
 * Blocked or opted-out contacts are closed for good; an uncertain send is closed
 * as outcome_unknown and never repeated. Logs carry ids and codes only.
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
import { pickConversation, rejectedByProvider, windowOpen, type ContactRow } from './cart-followup-jobs';
import {
  consentRefusal, followupBodyValues, loadTemplate, noticeTemplate, NOTICE_TEMPLATE_CATEGORY, orderTemplateOutcome, worker, type TemplateRow,
} from './order-followup';
import { CART_CODE, codeLimitReached, countMiss } from './public-shop';
import { PUBLIC_SHOP_PATH } from './shop-templates';
import { BACK_IN_STOCK_BATCH, BACK_IN_STOCK_JOB, queueBackInStockTx, STOCK_ALERT_CLAIM_DAYS } from './stock-alerts';
import { linkMessageText, sendStorefrontText } from './storefront';
import { StoreError } from './store-settings';

export const stockAlertAckKey = (alertId: string) => `stock_alert:${alertId}:ack`;
export const stockAlertNotifyKey = (alertId: string) => `stock_alert:${alertId}:notify`;

// ---------------------------------------------------------------------------
// The buyer's "NOTIFY <CODE>"

export interface StockAlertClaimInput {
  accountId: string;
  contactId: string;
  conversationId: string;
  /** whatsapp_config.id the message arrived on (null for legacy single-number payloads). */
  whatsappConfigId: string | null;
  code: string;
}

export interface StockAlertClaimResult {
  /** True when the code was ours: flows, automations, AI and the away message then stay silent. */
  handled: boolean;
  outcome: 'acked' | 'not_shop' | 'code_unknown' | 'rate_limited';
}

type Claimed = { kind: 'miss' } | { kind: 'claimed'; alertId: string };

async function queueIfInStock(tx: TenantTransaction, accountId: string, variantId: string, alertId: string) {
  const [row] = await tx.$queryRaw<{ in_stock: boolean }[]>`
    SELECT (NOT v.track_inventory OR COALESCE(l.on_hand - l.reserved, 0) > 0) AS in_stock
    FROM shop_variants v LEFT JOIN inventory_levels l ON l.account_id=v.account_id AND l.variant_id=v.id
    WHERE v.account_id=${accountId}::uuid AND v.id=${variantId}::uuid`;
  if (row?.in_stock) await queueBackInStockTx(tx, accountId, variantId, `claim:${alertId}`);
}

/**
 * Called from processInboundActions. The claim is replay-safe on its own (the
 * same sender finds their claim again); only the acknowledgement runs in
 * `runSend`. A second code of the same contact and variant is closed as a
 * duplicate and acknowledged the same way.
 */
export async function handleStockAlertCode(
  input: StockAlertClaimInput,
  runSend: (send: () => Promise<unknown>) => Promise<unknown> = (send) => send(),
  now = new Date(),
): Promise<StockAlertClaimResult> {
  const { accountId, contactId } = input;
  if (!CART_CODE.test(input.code)) return { handled: false, outcome: 'code_unknown' };
  const [shop] = await worker(accountId, (tx) => tx.$queryRaw<{ whatsapp_config_id: string | null }[]>`
    SELECT whatsapp_config_id::text AS whatsapp_config_id FROM shop_storefronts WHERE account_id=${accountId}::uuid`);
  if (!shop) return { handled: false, outcome: 'not_shop' };
  if (await codeLimitReached(contactId)) return { handled: false, outcome: 'rate_limited' };
  // A message to another number of the workspace is not this shop's.
  const otherNumber = input.whatsappConfigId && shop.whatsapp_config_id && input.whatsappConfigId !== shop.whatsapp_config_id;
  const claim: Claimed = otherNumber ? { kind: 'miss' } : await worker(accountId, async (tx): Promise<Claimed> => {
    // The row lock makes "first sender wins" exact: a second claimant waits, then sees the owner.
    const [hit] = await tx.$queryRaw<{ id: string; variant_id: string; contact_id: string | null; expires_at: Date }[]>`
      SELECT id::text AS id, variant_id::text AS variant_id, contact_id::text AS contact_id, expires_at FROM shop_stock_alerts
      WHERE account_id=${accountId}::uuid AND code=${input.code} FOR UPDATE`;
    if (!hit) return { kind: 'miss' };
    if (hit.contact_id) return hit.contact_id === contactId ? { kind: 'claimed', alertId: hit.id } : { kind: 'miss' };
    if (hit.expires_at.getTime() <= now.getTime()) return { kind: 'miss' };
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`stock-alert:${accountId}:${contactId}:${hit.variant_id}`}, 0))`;
    const [open] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM shop_stock_alerts WHERE account_id=${accountId}::uuid AND contact_id=${contactId}::uuid
        AND variant_id=${hit.variant_id}::uuid AND closed_at IS NULL LIMIT 1`;
    const claimExpires = new Date(now.getTime() + STOCK_ALERT_CLAIM_DAYS * 86_400_000);
    await tx.$executeRaw`UPDATE shop_stock_alerts SET contact_id=${contactId}::uuid, conversation_id=${input.conversationId}::uuid,
        claimed_at=${now}, claim_expires_at=${claimExpires}, closed_at=${open ? now : null}, skip_reason=${open ? 'duplicate' : null}
      WHERE account_id=${accountId}::uuid AND id=${hit.id}::uuid AND contact_id IS NULL`;
    // The variant came back while the code was unclaimed: no later restock will wake it, so queue the job now.
    if (!open) await queueIfInStock(tx, accountId, hit.variant_id, hit.id);
    return { kind: 'claimed', alertId: hit.id };
  });
  if (claim.kind === 'miss') {
    await countMiss(contactId);
    return { handled: false, outcome: 'code_unknown' };
  }
  const text = getT('ShopPublic.stockAlert')('ack');
  await runSend(async () => {
    try {
      await sendStorefrontText({
        accountId, contactId, conversationId: input.conversationId, intentKey: stockAlertAckKey(claim.alertId), text,
        sender: { kind: 'bot', service: true },
      });
    } catch (error) {
      // A refusal decided before the send or a provider rejection sent nothing and is not retried; an uncertain send propagates.
      if (!(error instanceof StoreError || rejectedByProvider(error))) throw error;
      console.warn('[stock-alert] ack not sent', error instanceof StoreError ? error.code : 'provider_rejected');
    }
  });
  return { handled: true, outcome: 'acked' };
}

// ---------------------------------------------------------------------------
// The restock job

export interface BackInStockJobPayload {
  variantId: string;
  /** Continue after this alert id (a long list runs in batches). */
  afterId?: string;
}

interface VariantFacts { productId: string; productName: string; options: Record<string, string>; handle: string }

type AlertPlan =
  | { kind: 'close'; reason: string }
  | { kind: 'defer'; reason: string }
  | { kind: 'sent' }
  | { kind: 'send'; contactId: string; conversationId: string; text: string | null; template: TemplateRow | null; values: string[] };

interface AlertRow { id: string; contact_id: string; conversation_id: string | null; claim_expires_at: Date }

const optionText = (options: Record<string, string>) => Object.values(options).filter(Boolean).join(', ');

/** The variant's product, when the shop can sell it right now and a published shop links to it; else null. */
function loadSellable(accountId: string, variantId: string): Promise<VariantFacts | null> {
  return worker(accountId, async (tx) => {
    const [row] = await tx.$queryRaw<{ product_id: string; name: string; option_values: Record<string, string> | null; handle: string }[]>`
      SELECT p.id::text AS product_id, p.name, v.option_values, s.handle
      FROM shop_variants v JOIN shop_products p ON p.account_id=v.account_id AND p.id=v.product_id
      JOIN shop_storefronts s ON s.account_id=v.account_id AND s.published
      LEFT JOIN inventory_levels l ON l.account_id=v.account_id AND l.variant_id=v.id
      WHERE v.account_id=${accountId}::uuid AND v.id=${variantId}::uuid AND p.status='published' AND v.archived_at IS NULL
        AND v.price_minor IS NOT NULL AND (NOT v.track_inventory OR COALESCE(l.on_hand - l.reserved, 0) > 0)`;
    return row ? { productId: row.product_id, productName: row.name, options: row.option_values ?? {}, handle: row.handle } : null;
  });
}

function planAlert(accountId: string, alert: AlertRow, facts: VariantFacts, now: Date): Promise<AlertPlan> {
  return worker(accountId, async (tx): Promise<AlertPlan> => {
    if (alert.claim_expires_at.getTime() <= now.getTime()) return { kind: 'close', reason: 'claim_expired' };
    // An earlier attempt already claimed the send: its intent decides, never a fresh plan.
    const [intent] = await tx.$queryRaw<{ status: string }[]>`
      SELECT status FROM outbound_intents WHERE account_id=${accountId}::uuid AND idempotency_key=${`${accountId}:${stockAlertNotifyKey(alert.id)}`}`;
    if (intent?.status === 'accepted') return { kind: 'sent' };
    if (intent?.status === 'failed') return { kind: 'close', reason: 'provider_rejected' };
    if (intent) return { kind: 'close', reason: 'outcome_unknown' };
    const [contact] = await tx.$queryRaw<ContactRow[]>`
      SELECT id::text AS id, name, phone, wa_user_id, blocked_at, opted_out_at FROM contacts
      WHERE account_id=${accountId}::uuid AND id=${alert.contact_id}::uuid`;
    if (!contact) return { kind: 'close', reason: 'contact_missing' };
    // A marketing message: any opt-out and a block refuse it for good.
    const consent = consentRefusal(contact, new Date(0));
    if (consent) return { kind: 'close', reason: consent };
    if (await isSuspended(tx, accountId)) return { kind: 'defer', reason: 'workspace_suspended' };
    if (!resolveContactSendTarget(contact)) return { kind: 'close', reason: 'no_address' };
    const conversation = await pickConversation(tx, accountId, contact.id, alert.conversation_id);
    if (!conversation) return { kind: 'close', reason: 'no_conversation' };
    // Not a service message: an agent's takeover of the chat holds it back until the next restock.
    if (conversation.bot_paused) return { kind: 'defer', reason: 'bot_paused' };
    let config;
    try {
      assertWhatsAppConversation(conversation);
      config = await getNumberConfig(tx, accountId, conversation.whatsapp_config_id);
    } catch (error) {
      if (error instanceof NoNumberError) return { kind: 'defer', reason: 'number_unavailable' };
      throw error;
    }
    if (isNumberDisconnected(config)) return { kind: 'defer', reason: 'number_unavailable' };

    const options = optionText(facts.options);
    const name = options ? `${facts.productName} (${options})` : facts.productName;
    const url = `${appOrigin()}${PUBLIC_SHOP_PATH}${facts.handle}/p/${facts.productId}`;
    if (windowOpen(conversation, now))
      return { kind: 'send', contactId: contact.id, conversationId: conversation.id, template: null, values: [],
        text: linkMessageText(getT('ShopPublic.stockAlert')('back', { product: name }), url) };
    const setting = await noticeTemplate(tx, accountId, 'back_in_stock');
    if (!setting) return { kind: 'defer', reason: 'no_template' };
    const template = await loadTemplate(tx, accountId, setting.name, setting.language);
    const refusal = orderTemplateOutcome(template, config, NOTICE_TEMPLATE_CATEGORY.back_in_stock);
    if (refusal || !template) return { kind: 'defer', reason: refusal?.reason ?? 'template_not_found' };
    // {{1}} customer name, {{2}} product (with its options), {{3}} the product link (a variable URL button is not supported).
    return { kind: 'send', contactId: contact.id, conversationId: conversation.id, template, text: null, values: [contact.name || '-', name, url] };
  });
}

type Settled = { sent: true } | { close: string } | { defer: string };

function record(accountId: string, alertId: string, state: Settled, now: Date) {
  return worker(accountId, (tx) => {
    if ('sent' in state) return tx.$executeRaw`UPDATE shop_stock_alerts SET notified_at=${now}, closed_at=${now}, skip_reason=NULL
      WHERE account_id=${accountId}::uuid AND id=${alertId}::uuid AND closed_at IS NULL`;
    if ('close' in state) return tx.$executeRaw`UPDATE shop_stock_alerts SET closed_at=${now}, skip_reason=${state.close}
      WHERE account_id=${accountId}::uuid AND id=${alertId}::uuid AND closed_at IS NULL`;
    return tx.$executeRaw`UPDATE shop_stock_alerts SET skip_reason=${state.defer}
      WHERE account_id=${accountId}::uuid AND id=${alertId}::uuid AND closed_at IS NULL`;
  });
}

type Result = 'sent' | 'closed' | 'deferred';

async function notifyOne(accountId: string, alert: AlertRow, facts: VariantFacts, now: Date): Promise<Result> {
  const p = await planAlert(accountId, alert, facts, now);
  if (p.kind === 'close') { await record(accountId, alert.id, { close: p.reason }, now); return 'closed'; }
  if (p.kind === 'defer') { await record(accountId, alert.id, { defer: p.reason }, now); return 'deferred'; }
  if (p.kind === 'sent') { await record(accountId, alert.id, { sent: true }, now); return 'sent'; }
  const db = createAdminClient({ accountId, role: 'owner' });
  const userId = await resolveAuditUserId(db, accountId);
  const base = { accountId, userId, conversationId: p.conversationId, contactId: p.contactId };
  try {
    if (p.text !== null) {
      const text = p.text;
      await dispatchOnce(accountId, stockAlertNotifyKey(alert.id), () => engineSendText({ ...base, text }));
    } else {
      const template = p.template!;
      const body = followupBodyValues(template, p.values);
      const headerVar = template.header_type === 'text' && extractVariableIndices(template.header_content ?? '').length > 0;
      await dispatchOnce(accountId, stockAlertNotifyKey(alert.id), () => engineSendTemplate({
        ...base, templateName: template.name, language: template.language ?? undefined, params: body, bodyValuesOnly: false,
        messageParams: { body, ...(headerVar ? { headerText: (p.values[1] ?? '-').slice(0, 60) } : {}) },
      }));
    }
  } catch (error) {
    // An uncertain send is closed for staff to reconcile and never sent again.
    if (error instanceof UncertainDispatchError) { await record(accountId, alert.id, { close: 'outcome_unknown' }, now); return 'closed'; }
    if (rejectedByProvider(error)) { await record(accountId, alert.id, { close: 'provider_rejected' }, now); return 'closed'; }
    throw error;
  }
  await record(accountId, alert.id, { sent: true }, now);
  return 'sent';
}

/**
 * One restock of a variant: message its claimed, open alerts (at most
 * BACK_IN_STOCK_BATCH per run; the rest is queued as the next run). A variant
 * that is not on sale any more leaves every alert waiting.
 */
export async function handleBackInStockJob(
  accountId: string, payload: BackInStockJobPayload, now = new Date(),
): Promise<{ sent: number; closed: number; deferred: number }> {
  const result = { sent: 0, closed: 0, deferred: 0 };
  const { variantId } = payload;
  const facts = await loadSellable(accountId, variantId);
  if (!facts) return result;
  const afterId = payload.afterId ?? null;
  const alerts = await worker(accountId, (tx) => tx.$queryRaw<AlertRow[]>`
    SELECT id::text AS id, contact_id::text AS contact_id, conversation_id::text AS conversation_id, claim_expires_at FROM shop_stock_alerts
    WHERE account_id=${accountId}::uuid AND variant_id=${variantId}::uuid AND claimed_at IS NOT NULL AND closed_at IS NULL
      AND (${afterId}::uuid IS NULL OR id > ${afterId}::uuid)
    ORDER BY id LIMIT ${BACK_IN_STOCK_BATCH}`);
  for (const alert of alerts) {
    const done = await notifyOne(accountId, alert, facts, now);
    result[done === 'sent' ? 'sent' : done === 'closed' ? 'closed' : 'deferred']++;
  }
  if (alerts.length === BACK_IN_STOCK_BATCH) {
    const last = alerts[alerts.length - 1].id;
    await worker(accountId, (tx) => tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key)
      VALUES(${BACK_IN_STOCK_JOB},${accountId}::uuid,${JSON.stringify({ variantId, afterId: last })}::jsonb,${`bis:${variantId}:next:${last}:${Math.floor(now.getTime() / 1000)}`})
      ON CONFLICT(dedupe_key) DO NOTHING`);
  }
  return result;
}
