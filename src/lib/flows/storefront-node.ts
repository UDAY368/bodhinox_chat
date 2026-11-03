/**
 * Runtime of the send_storefront_link flow node (design §3 Journeys, E12).
 * Issues a storefront session bound to the run's contact (shop, or status of
 * the contact's latest order) and sends the link as a text inside the 24-hour
 * window. Every refusal is decided before the send (Phase 7 D14). Never throws
 * for an expected refusal: the engine continues on failed_next.
 *
 * Replay-safe: the session id and the send intent are both derived from
 * (run, node, transition), so a re-run of the same step finds the same
 * session and never sends a second link. The link is never logged or stored
 * in run variables.
 */
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { PlanLimitError } from '@/lib/billing/entitlements';
import { WorkspaceSuspendedError } from '@/lib/billing/suspension';
import { UncertainDispatchError } from '@/lib/jobs/dispatch';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { assertStoreOpenTx, issueSessionTx, latestOrderId, linkMessageText, seededUuid, sendStorefrontText, STOREFRONT_TTL } from '@/lib/commerce/storefront';
import { StoreError } from '@/lib/commerce/store-settings';
import { STOREFRONT_LINK_LIMITS, type SendStorefrontLinkNodeConfig } from './types';

export interface StorefrontNodeInput {
  accountId: string;
  runId: string;
  nodeKey: string;
  /** flow_runs.transition_seq: with runId and nodeKey, the send's idempotency key. */
  transitionSeq: number;
  contactId: string | null;
  conversationId: string | null;
  vars: Record<string, unknown>;
  config: SendStorefrontLinkNodeConfig;
}

export type StorefrontNodeResult =
  | { ok: true; sessionId: string; whatsappMessageId: string | null }
  /** reason: a lower-case code (storefront_disabled, no_contact, no_order, outside_window, send_failed, ...). */
  | { ok: false; reason: string; uncertain?: boolean };

/** `{{vars.x}}` only (captured values are customer input and never expand further). */
export function fillVars(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{vars\.([a-zA-Z0-9_]+)\}\}/g, (_, key: string) => {
    const v = vars[key];
    return v === undefined || v === null ? '' : String(v);
  });
}

const REASON: Partial<Record<string, string>> = {
  checkout_disabled: 'storefront_disabled', store_not_configured: 'storefront_disabled', feature_unavailable: 'storefront_disabled',
  no_order: 'no_order', contact_not_found: 'no_contact', contact_blocked: 'contact_blocked', outside_window: 'outside_window',
  number_unavailable: 'number_unavailable', send_failed: 'send_failed',
};

export async function runStorefrontLinkNode(input: StorefrontNodeInput): Promise<StorefrontNodeResult> {
  const { accountId, config } = input;
  if (!input.contactId) return { ok: false, reason: 'no_contact' };
  const purpose = config.purpose === 'status' ? 'status' : config.purpose === 'shop' ? 'shop' : null;
  if (!purpose) return { ok: false, reason: 'invalid_config' };
  const ttl = config.ttl_hours ?? STOREFRONT_LINK_LIMITS.ttlDefaultHours;
  if (!Number.isInteger(ttl) || ttl < STOREFRONT_TTL.minHours || ttl > STOREFRONT_TTL.maxHours) return { ok: false, reason: 'invalid_config' };
  const message = fillVars(config.message ?? '', input.vars).trim().slice(0, STOREFRONT_LINK_LIMITS.messageMax);
  const step = `${input.runId}:${input.nodeKey}:${input.transitionSeq}`;
  const contactId = input.contactId;

  try {
    const session = await withTenant({ accountId, role: 'owner' }, async (tx) => {
      await assertStoreOpenTx(tx, accountId, purpose);
      const [contact] = await tx.$queryRaw<{ blocked_at: Date | null }[]>`SELECT blocked_at FROM contacts
        WHERE account_id=${accountId}::uuid AND id=${contactId}::uuid`;
      if (!contact) throw new StoreError('contact_not_found');
      if (contact.blocked_at) throw new StoreError('contact_blocked');
      const orderId = purpose === 'status' ? await latestOrderId(tx, accountId, contactId) : null;
      if (purpose === 'status' && !orderId) throw new StoreError('no_order');
      const [conversation] = input.conversationId ? await tx.$queryRaw<{ whatsapp_config_id: string | null }[]>`
        SELECT whatsapp_config_id::text AS whatsapp_config_id FROM conversations
        WHERE account_id=${accountId}::uuid AND id=${input.conversationId}::uuid AND contact_id=${contactId}::uuid` : [];
      return issueSessionTx(tx, accountId, {
        sessionId: seededUuid(`storefront:flow:${accountId}:${step}`), contactId,
        conversationId: conversation ? input.conversationId : null, whatsappConfigId: conversation?.whatsapp_config_id ?? null,
        purpose, orderId, ttlHours: ttl, createdBy: null,
      });
    }, getWorkerPrisma());
    const sent = await sendStorefrontText({
      accountId, contactId, conversationId: input.conversationId, text: linkMessageText(message, session.url),
      intentKey: `flow:${step}:storefront_link`, sender: { kind: 'bot' },
    });
    return { ok: true, sessionId: session.sessionId, whatsappMessageId: sent.whatsappMessageId };
  } catch (error) {
    if (error instanceof UncertainDispatchError) return { ok: false, reason: 'send_uncertain', uncertain: true };
    if (error instanceof StoreError) return { ok: false, reason: REASON[error.code] ?? error.code };
    if (error instanceof WorkspaceSuspendedError) return { ok: false, reason: 'workspace_suspended' };
    if (error instanceof PlanLimitError) return { ok: false, reason: 'storefront_disabled' };
    if (error instanceof MetaApiError) return { ok: false, reason: 'send_failed' };
    throw error;
  }
}
