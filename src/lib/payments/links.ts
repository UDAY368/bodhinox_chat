/**
 * Razorpay payment links: create, reconcile, cancel, apply provider events,
 * and send a link into a WhatsApp conversation.
 *
 * Durability rules (see razorpay.ts for the provider side):
 *  - A row with a unique reference_id is stored BEFORE Razorpay is called, so
 *    the same reference can never produce two links (a replay finds the row).
 *  - A create whose outcome is unknown (timeout, network error, 5xx) leaves the
 *    row 'unknown'. It is never retried blindly: reconcile fetches by reference
 *    first and creates again only when Razorpay has no link for it.
 *  - 'paid' comes only from a verified webhook or a verified fetch; a browser
 *    request can never set it (the app role cannot even UPDATE payment_links).
 *  - Sending the link is an outbound intent (dispatchOnce), so an ambiguous
 *    send is never repeated automatically.
 *
 * Customer details are never sent to Razorpay (we deliver the link over
 * WhatsApp) and never logged.
 */

import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { dispatchOnce } from '@/lib/jobs/dispatch';
import { getT } from '@/lib/i18n/translate';
import { formatMoney, isCurrencyCode, MAX_MINOR, minorFromDb } from '@/lib/commerce/money';
import { decrypt } from '@/lib/whatsapp/encryption';
import { sendTextMessage } from '@/lib/whatsapp/meta-api';
import { getNumberConfig, NoNumberError } from '@/lib/whatsapp/numbers';
import { isRecipientNotAllowedError, phoneVariants } from '@/lib/whatsapp/phone-utils';
import { resolveContactSendTarget } from '@/lib/whatsapp/wa-identity';
import { emitOrderPaid, emitPaymentLinkPaid } from '@/lib/webhooks/commerce-events';
import {
  cancelPaymentLink as razorpayCancel,
  createPaymentLink as razorpayCreate,
  fetchPaymentLink as razorpayFetch,
  fetchPaymentLinkByReference as razorpayFetchByReference,
  RazorpayError,
  type CreatePaymentLinkResult,
  type RazorpayLinkStatus,
  type RazorpayPaymentLink,
} from './razorpay';
import { loadRazorpaySecrets, PaymentProviderError, type RazorpaySecrets } from './providers';

export const PAYMENT_LINK_STATUSES = ['creating', 'created', 'paid', 'partially_paid', 'expired', 'cancelled', 'failed', 'unknown'] as const;
export type PaymentLinkStatus = (typeof PAYMENT_LINK_STATUSES)[number];

/** Statuses after which nothing more happens to a link (except a late 'paid'). */
export const TERMINAL_STATUSES: ReadonlySet<PaymentLinkStatus> = new Set(['paid', 'expired', 'cancelled', 'failed']);

/** Job that applies one verified Razorpay webhook delivery. */
export const PAYMENT_EVENT_JOB = 'payments.razorpay_event';

/** A creating row older than this is treated as an unknown outcome (the provider call times out at 15 s). */
export const STALE_CREATING_MS = 2 * 60_000;
/** Razorpay needs at least 15 minutes; we ask for a little more. */
export const MIN_EXPIRE_MINUTES = 16;
export const MAX_EXPIRE_MINUTES = 60 * 24 * 180;
export const DESCRIPTION_MAX = 2048;
export const MESSAGE_MAX = 900;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type PaymentLinkErrorCode =
  | 'not_connected'
  | 'invalid_amount'
  | 'invalid_currency'
  | 'invalid_description'
  | 'invalid_expiry'
  | 'invalid_message'
  | 'target_not_found'
  | 'reference_conflict'
  | 'not_found'
  | 'not_cancellable'
  | 'busy'
  | 'provider_auth'
  | 'provider_rejected'
  | 'provider_unreachable'
  | 'conversation_not_found'
  | 'contact_blocked'
  | 'no_address'
  | 'window_closed'
  | 'number_unavailable'
  | 'link_not_ready';

const ERROR_STATUS: Record<PaymentLinkErrorCode, number> = {
  not_connected: 409,
  invalid_amount: 400,
  invalid_currency: 400,
  invalid_description: 400,
  invalid_expiry: 400,
  invalid_message: 400,
  target_not_found: 404,
  reference_conflict: 409,
  not_found: 404,
  not_cancellable: 409,
  busy: 409,
  provider_auth: 502,
  provider_rejected: 502,
  provider_unreachable: 502,
  conversation_not_found: 404,
  contact_blocked: 409,
  no_address: 400,
  window_closed: 409,
  number_unavailable: 409,
  link_not_ready: 409,
};

export class PaymentLinkError extends Error {
  readonly status: number;
  constructor(readonly code: PaymentLinkErrorCode) {
    super(getT('Validation.payments')(code));
    this.name = 'PaymentLinkError';
    this.status = ERROR_STATUS[code];
  }
}

/** One payment link as members (agent and above) may see it. Never contains secrets. */
export interface PaymentLinkView {
  id: string;
  provider: 'razorpay';
  provider_link_id: string | null;
  short_url: string | null;
  amount_minor: number;
  currency: string;
  description: string | null;
  contact_id: string | null;
  conversation_id: string | null;
  order_id: string | null;
  flow_run_id: string | null;
  node_key: string | null;
  status: PaymentLinkStatus;
  paid_at: string | null;
  expires_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface LinkRow {
  id: string;
  account_id: string;
  provider: string;
  provider_link_id: string | null;
  reference_id: string;
  short_url: string | null;
  amount_minor: bigint | number;
  currency: string;
  description: string | null;
  contact_id: string | null;
  conversation_id: string | null;
  order_id: string | null;
  flow_run_id: string | null;
  node_key: string | null;
  status: string;
  paid_at: Date | null;
  expires_at: Date | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

const iso = (d: Date | string | null): string | null => (d ? new Date(d).toISOString() : null);

export function toView(row: LinkRow): PaymentLinkView {
  return {
    id: row.id,
    provider: 'razorpay',
    provider_link_id: row.provider_link_id,
    short_url: row.short_url,
    amount_minor: minorFromDb(row.amount_minor) ?? 0,
    currency: row.currency,
    description: row.description,
    contact_id: row.contact_id,
    conversation_id: row.conversation_id,
    order_id: row.order_id,
    flow_run_id: row.flow_run_id,
    node_key: row.node_key,
    status: row.status as PaymentLinkStatus,
    paid_at: iso(row.paid_at),
    expires_at: iso(row.expires_at),
    created_by: row.created_by,
    created_at: iso(row.created_at)!,
    updated_at: iso(row.updated_at)!,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers

/**
 * The status a link moves to when the provider reports `incoming`. 'paid' is
 * final and wins over everything; an ended link (expired, cancelled, failed)
 * only moves to 'paid'; an 'unknown' provider status changes nothing.
 */
export function nextStatus(current: PaymentLinkStatus, incoming: RazorpayLinkStatus | 'unknown'): PaymentLinkStatus {
  if (current === 'paid') return 'paid';
  if (incoming === 'paid') return 'paid';
  if (incoming === 'unknown') return current;
  if (current === 'expired' || current === 'cancelled' || current === 'failed') return current;
  return incoming;
}

/** The status a Razorpay webhook event name stands for, or null for events we ignore. */
export function statusForEvent(event: string): RazorpayLinkStatus | null {
  switch (event) {
    case 'payment_link.paid': return 'paid';
    case 'payment_link.partially_paid': return 'partially_paid';
    case 'payment_link.expired': return 'expired';
    case 'payment_link.cancelled': return 'cancelled';
    default: return null;
  }
}

const digest = (input: string) => createHash('sha256').update(input).digest('base64url').slice(0, 32);

/** The reference for a flow's payment_link step: one per run, node and transition, so a replay finds the same row. */
export function flowPaymentReference(runId: string, nodeKey: string, seq: number): string {
  return `fl_${digest(`flow:${runId}:${nodeKey}:${seq}`)}`;
}

/** The reference for an inbox/API request: one per account, user and client request id. */
export function requestPaymentReference(accountId: string, userId: string, clientRequestId: string): string {
  return `in_${digest(`request:${accountId}:${userId}:${clientRequestId}`)}`;
}

/** The WhatsApp text that carries a link: the message, then the URL on its own line. */
export function paymentLinkMessageText(message: string | null | undefined, shortUrl: string): string {
  const body = (message ?? '').trim();
  return body ? `${body}\n${shortUrl}` : shortUrl;
}

export interface CreateLinkInput {
  accountId: string;
  /** An agent from the inbox or the payments page; a flow run acts as 'bot'. */
  actor: { kind: 'agent'; userId: string; role: NonNullable<TenantContext['role']> } | { kind: 'bot' };
  amountMinor: number;
  currency: string;
  description?: string | null;
  contactId?: string | null;
  conversationId?: string | null;
  orderId?: string | null;
  flowRunId?: string | null;
  nodeKey?: string | null;
  expireBy?: Date | null;
  referenceId: string;
}

/** Throws PaymentLinkError for input that must never reach Razorpay. */
export function validateCreateInput(input: Pick<CreateLinkInput, 'amountMinor' | 'currency' | 'description' | 'expireBy'>, now = Date.now()): void {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0 || input.amountMinor > MAX_MINOR) throw new PaymentLinkError('invalid_amount');
  if (!isCurrencyCode(input.currency)) throw new PaymentLinkError('invalid_currency');
  if (input.description && (typeof input.description !== 'string' || input.description.length > DESCRIPTION_MAX)) throw new PaymentLinkError('invalid_description');
  if (input.expireBy) {
    const ms = input.expireBy.getTime() - now;
    if (!Number.isFinite(ms) || ms < (MIN_EXPIRE_MINUTES - 1) * 60_000 || ms > MAX_EXPIRE_MINUTES * 60_000) throw new PaymentLinkError('invalid_expiry');
  }
}

// ---------------------------------------------------------------------------
// Database access

const LINK_COLUMNS = 'id,account_id,provider,provider_link_id,reference_id,short_url,amount_minor,currency,description,contact_id,conversation_id,order_id,flow_run_id,node_key,status,paid_at,expires_at,created_by,created_at,updated_at';

const worker = <T>(accountId: string, op: (tx: TenantTransaction) => Promise<T>) =>
  withTenant({ accountId, role: 'owner' }, op, getWorkerPrisma());

async function selectLink(tx: TenantTransaction, accountId: string, where: { id?: string; referenceId?: string; providerLinkId?: string }, lock = false): Promise<LinkRow | null> {
  const lockSql = lock ? ' FOR UPDATE' : '';
  let rows: LinkRow[];
  if (where.id) {
    rows = await tx.$queryRawUnsafe<LinkRow[]>(`SELECT ${LINK_COLUMNS} FROM payment_links WHERE account_id=$1::uuid AND id=$2::uuid${lockSql}`, accountId, where.id);
  } else if (where.providerLinkId) {
    rows = await tx.$queryRawUnsafe<LinkRow[]>(`SELECT ${LINK_COLUMNS} FROM payment_links WHERE account_id=$1::uuid AND provider='razorpay' AND provider_link_id=$2${lockSql}`, accountId, where.providerLinkId);
  } else if (where.referenceId) {
    rows = await tx.$queryRawUnsafe<LinkRow[]>(`SELECT ${LINK_COLUMNS} FROM payment_links WHERE account_id=$1::uuid AND reference_id=$2${lockSql}`, accountId, where.referenceId);
  } else {
    return null;
  }
  return rows[0] ?? null;
}

/** One link for a member (app-role transaction; RLS hides it below agent). */
export async function getPaymentLink(tx: TenantTransaction, accountId: string, id: string): Promise<PaymentLinkView | null> {
  if (!UUID.test(id)) return null;
  const row = await selectLink(tx, accountId, { id });
  return row ? toView(row) : null;
}

export interface ListLinksFilter {
  status?: PaymentLinkStatus;
  conversationId?: string;
  orderId?: string;
  contactId?: string;
  /** created_at of the last row of the previous page. */
  before?: Date;
  limit?: number;
}

/** Newest first. `tx` is an app-role tenant transaction (agent and above see rows). */
export async function listPaymentLinks(tx: TenantTransaction, accountId: string, filter: ListLinksFilter = {}): Promise<PaymentLinkView[]> {
  const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 50), 1), 100);
  const params: unknown[] = [accountId];
  const clauses = ['account_id=$1::uuid'];
  const add = (sql: string, value: unknown) => { params.push(value); clauses.push(sql.replace('?', `$${params.length}`)); };
  if (filter.status) add('status=?', filter.status);
  if (filter.conversationId) add('conversation_id=?::uuid', filter.conversationId);
  if (filter.orderId) add('order_id=?::uuid', filter.orderId);
  if (filter.contactId) add('contact_id=?::uuid', filter.contactId);
  if (filter.before) add('created_at<?', filter.before);
  params.push(limit);
  const rows = await tx.$queryRawUnsafe<LinkRow[]>(
    `SELECT ${LINK_COLUMNS} FROM payment_links WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
    ...params,
  );
  return rows.map(toView);
}

async function secretsOrThrow(accountId: string): Promise<RazorpaySecrets> {
  try {
    return await loadRazorpaySecrets(accountId);
  } catch (error) {
    if (error instanceof PaymentProviderError) throw new PaymentLinkError('not_connected');
    throw error;
  }
}

function providerError(error: unknown): PaymentLinkError {
  if (error instanceof RazorpayError) {
    if (error.reason === 'auth') return new PaymentLinkError('provider_auth');
    if (error.reason === 'unknown' || error.reason === 'rate_limited') return new PaymentLinkError('provider_unreachable');
    return new PaymentLinkError('provider_rejected');
  }
  return new PaymentLinkError('provider_unreachable');
}

/** The ids a new link is tied to, checked inside the caller's tenant scope. */
async function resolveTargets(tx: TenantTransaction, input: CreateLinkInput): Promise<{ contactId: string | null; conversationId: string | null; orderId: string | null }> {
  let contactId = input.contactId ?? null;
  let conversationId = input.conversationId ?? null;
  const orderId = input.orderId ?? null;
  for (const id of [contactId, conversationId, orderId, input.flowRunId ?? null]) {
    if (id !== null && !UUID.test(id)) throw new PaymentLinkError('target_not_found');
  }
  if (orderId) {
    const orders = await tx.$queryRaw<{ contact_id: string | null; conversation_id: string | null }[]>`
      SELECT contact_id,conversation_id FROM orders WHERE account_id=${input.accountId}::uuid AND id=${orderId}::uuid`;
    if (!orders[0]) throw new PaymentLinkError('target_not_found');
    conversationId ??= orders[0].conversation_id;
    contactId ??= orders[0].contact_id;
  }
  if (conversationId) {
    const conversations = await tx.$queryRaw<{ contact_id: string }[]>`
      SELECT contact_id FROM conversations WHERE account_id=${input.accountId}::uuid AND id=${conversationId}::uuid`;
    if (!conversations[0]) throw new PaymentLinkError('target_not_found');
    if (contactId && contactId !== conversations[0].contact_id) throw new PaymentLinkError('target_not_found');
    contactId = conversations[0].contact_id;
  } else if (contactId) {
    const contacts = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM contacts WHERE account_id=${input.accountId}::uuid AND id=${contactId}::uuid`;
    if (!contacts[0]) throw new PaymentLinkError('target_not_found');
  }
  return { contactId, conversationId, orderId };
}

/**
 * Stores the row (status 'creating') or finds the one already stored for this
 * reference. The insert runs with the caller's own role, so RLS decides
 * whether an agent may create links at all.
 */
async function claimReference(input: CreateLinkInput): Promise<{ row: LinkRow; inserted: boolean }> {
  const agent = input.actor.kind === 'agent' ? input.actor : null;
  const context: TenantContext = agent ? { accountId: input.accountId, userId: agent.userId, role: agent.role } : { accountId: input.accountId, role: 'owner' };
  const prisma: PrismaClient = agent ? getPrisma() : getWorkerPrisma();
  return withTenant(context, async (tx) => {
    const targets = await resolveTargets(tx, input);
    const inserted = await tx.$queryRawUnsafe<LinkRow[]>(
      `INSERT INTO payment_links(account_id,provider,reference_id,amount_minor,currency,description,contact_id,conversation_id,order_id,flow_run_id,node_key,status,expires_at,created_by)
       VALUES($1::uuid,'razorpay',$2,$3,$4,$5,$6::uuid,$7::uuid,$8::uuid,$9::uuid,$10,'creating',$11,$12::uuid)
       ON CONFLICT(reference_id) DO NOTHING RETURNING ${LINK_COLUMNS}`,
      input.accountId, input.referenceId, BigInt(input.amountMinor), input.currency, input.description || null,
      targets.contactId, targets.conversationId, targets.orderId, input.flowRunId ?? null, input.nodeKey ?? null,
      input.expireBy ?? null, agent?.userId ?? null,
    );
    if (inserted[0]) return { row: inserted[0], inserted: true };
    const existing = await selectLink(tx, input.accountId, { referenceId: input.referenceId });
    // Not visible: the reference belongs to another workspace (or a role that cannot read it).
    if (!existing) throw new PaymentLinkError('reference_conflict');
    if (minorFromDb(existing.amount_minor) !== input.amountMinor || existing.currency !== input.currency) throw new PaymentLinkError('reference_conflict');
    return { row: existing, inserted: false };
  }, prisma);
}

export interface ApplyResult {
  row: LinkRow;
  /** True when this call moved the link to 'paid'. */
  becamePaid: boolean;
  /** The linked order this call moved to 'paid' (only when becamePaid). */
  paidOrder: PaidOrderRow | null;
  changed: boolean;
}

interface PaidOrderRow {
  id: string;
  source: string;
  external_id: string | null;
  status: string;
  total_minor: bigint | number | null;
  subtotal_minor: bigint | number;
  currency: string;
  contact_id: string | null;
  conversation_id: string | null;
  item_count: number | null;
}

/**
 * Applies what Razorpay reports about a link (a verified webhook or a verified
 * fetch) under a row lock. Marks the linked order paid and notifies agents the
 * first time the link is paid. Runs as the worker; never from browser input.
 */
export async function applyProviderState(
  accountId: string,
  linkId: string,
  incoming: { status: RazorpayLinkStatus | 'unknown'; providerLinkId?: string | null; shortUrl?: string | null; expireBy?: number | null },
  source: 'webhook' | 'fetch',
): Promise<ApplyResult | null> {
  const result = await applyProviderStateTx(accountId, linkId, incoming, source);
  // After COMMIT, and only for the one call whose row-locked update moved the
  // link to 'paid', so each event goes out once. Best effort: never throws.
  if (result?.becamePaid) await emitPaidEvents(accountId, result);
  return result;
}

async function emitPaidEvents(accountId: string, result: ApplyResult): Promise<void> {
  const row = result.row;
  const amountMinor = minorFromDb(row.amount_minor) ?? 0;
  await emitPaymentLinkPaid(accountId, {
    paymentLinkId: row.id, provider: row.provider, referenceId: row.reference_id, providerLinkId: row.provider_link_id,
    amountMinor, amountPaidMinor: amountMinor, currency: row.currency, orderId: row.order_id,
    contactId: row.contact_id, conversationId: row.conversation_id, paidAt: row.paid_at ? new Date(row.paid_at) : undefined,
  });
  const order = result.paidOrder;
  if (order) {
    await emitOrderPaid(accountId, {
      orderId: order.id, source: order.source, externalId: order.external_id, status: order.status,
      totalMinor: minorFromDb(order.total_minor ?? order.subtotal_minor), currency: order.currency,
      itemCount: order.item_count, contactId: order.contact_id, conversationId: order.conversation_id,
    });
  }
}

async function applyProviderStateTx(
  accountId: string,
  linkId: string,
  incoming: { status: RazorpayLinkStatus | 'unknown'; providerLinkId?: string | null; shortUrl?: string | null; expireBy?: number | null },
  source: 'webhook' | 'fetch',
): Promise<ApplyResult | null> {
  return worker(accountId, async (tx) => {
    const row = await selectLink(tx, accountId, { id: linkId }, true);
    if (!row) return null;
    // A provider id that disagrees with the stored one is someone else's link.
    if (incoming.providerLinkId && row.provider_link_id && incoming.providerLinkId !== row.provider_link_id) return { row, becamePaid: false, paidOrder: null, changed: false };
    const status = nextStatus(row.status as PaymentLinkStatus, incoming.status);
    const becamePaid = status === 'paid' && row.status !== 'paid';
    const providerLinkId = row.provider_link_id ?? incoming.providerLinkId ?? null;
    const shortUrl = incoming.shortUrl ?? row.short_url;
    const expiresAt = incoming.expireBy ? new Date(incoming.expireBy * 1000) : row.expires_at;
    const changed = status !== row.status || providerLinkId !== row.provider_link_id || shortUrl !== row.short_url;
    const updated = await tx.$queryRawUnsafe<LinkRow[]>(
      `UPDATE payment_links SET status=$3, provider_link_id=$4, short_url=$5, expires_at=$6,
         paid_at=CASE WHEN $7 THEN now() ELSE paid_at END,
         last_event_at=CASE WHEN $8 THEN now() ELSE last_event_at END
       WHERE account_id=$1::uuid AND id=$2::uuid RETURNING ${LINK_COLUMNS}`,
      accountId, linkId, status, providerLinkId, shortUrl, expiresAt, becamePaid, source === 'webhook',
    );
    let paidOrder: PaidOrderRow | null = null;
    if (becamePaid) {
      if (row.order_id) {
        // RETURNING tells us whether the order itself moved to 'paid' (order.paid fires only then).
        const orders = await tx.$queryRaw<PaidOrderRow[]>`UPDATE orders o SET status='paid'
          WHERE o.account_id=${accountId}::uuid AND o.id=${row.order_id}::uuid AND o.status IN ('new','confirmed','awaiting_payment')
          RETURNING o.id::text AS id,o.source,o.external_id,o.status,o.total_minor,o.subtotal_minor,o.currency,
            o.contact_id::text AS contact_id,o.conversation_id::text AS conversation_id,
            (SELECT count(*)::int FROM order_items i WHERE i.account_id=o.account_id AND i.order_id=o.id) AS item_count`;
        paidOrder = orders[0] ?? null;
      }
      await notifyPaid(tx, updated[0] ?? row);
    }
    return { row: updated[0] ?? row, becamePaid, paidOrder, changed };
  });
}

/**
 * In-app alert for a paid link: the agent who created it and the agent the
 * conversation is assigned to; with neither, the owners and admins. One per
 * recipient per link (dedupe key). The amount only, never customer content.
 */
async function notifyPaid(tx: TenantTransaction, row: LinkRow): Promise<void> {
  const t = getT('Payments.notifications');
  const recipients = await tx.$queryRaw<{ user_id: string }[]>`
    SELECT DISTINCT m.user_id FROM account_memberships m
    WHERE m.account_id=${row.account_id}::uuid AND m.role IN ('owner','admin','agent') AND (
      m.user_id=${row.created_by}::uuid
      OR m.user_id=(SELECT assigned_agent_id FROM conversations WHERE account_id=${row.account_id}::uuid AND id=${row.conversation_id}::uuid)
    )`;
  const targets = recipients.length ? recipients : await tx.$queryRaw<{ user_id: string }[]>`
    SELECT user_id FROM account_memberships WHERE account_id=${row.account_id}::uuid AND role IN ('owner','admin')`;
  const title = t('paidTitle');
  const body = t('paidBody', { amount: formatMoney(minorFromDb(row.amount_minor) ?? 0, row.currency) });
  const dedupeKey = `payment:${row.id}:paid`;
  for (const { user_id } of targets) {
    await tx.$executeRaw`INSERT INTO notifications(account_id,user_id,type,conversation_id,contact_id,title,body,dedupe_key)
      VALUES(${row.account_id}::uuid,${user_id}::uuid,'payment_received',${row.conversation_id}::uuid,${row.contact_id}::uuid,${title},${body},${dedupeKey})
      ON CONFLICT DO NOTHING`;
  }
}

async function markFailed(accountId: string, linkId: string, from: string[]): Promise<LinkRow | null> {
  return worker(accountId, async (tx) => {
    const rows = await tx.$queryRawUnsafe<LinkRow[]>(
      `UPDATE payment_links SET status='failed' WHERE account_id=$1::uuid AND id=$2::uuid AND status = ANY($3::text[]) RETURNING ${LINK_COLUMNS}`,
      accountId, linkId, from,
    );
    return rows[0] ?? (await selectLink(tx, accountId, { id: linkId }));
  });
}

async function markUnknown(accountId: string, linkId: string): Promise<LinkRow | null> {
  return worker(accountId, async (tx) => {
    const rows = await tx.$queryRawUnsafe<LinkRow[]>(
      `UPDATE payment_links SET status='unknown' WHERE account_id=$1::uuid AND id=$2::uuid AND status='creating' RETURNING ${LINK_COLUMNS}`,
      accountId, linkId,
    );
    return rows[0] ?? (await selectLink(tx, accountId, { id: linkId }));
  });
}

async function applyCreated(accountId: string, linkId: string, link: RazorpayPaymentLink): Promise<LinkRow | null> {
  const applied = await applyProviderState(accountId, linkId, {
    status: link.status === 'unknown' ? 'created' : link.status, providerLinkId: link.id, shortUrl: link.shortUrl, expireBy: link.expireBy,
  }, 'fetch');
  return applied?.row ?? null;
}

export type CreateOutcome = 'created' | 'existing' | 'rejected' | 'unknown';

/** Calls Razorpay for a row this process has claimed (status 'creating') and records what happened. */
async function createAtProvider(row: LinkRow, secrets: RazorpaySecrets): Promise<{ row: LinkRow; outcome: CreateOutcome; reason?: string }> {
  const expiresAt = row.expires_at ? new Date(row.expires_at) : undefined;
  if (expiresAt && expiresAt.getTime() < Date.now() + 15 * 60_000) {
    // Too late to create: the link would expire before Razorpay accepts it.
    return { row: (await markFailed(row.account_id, row.id, ['creating'])) ?? row, outcome: 'rejected', reason: 'invalid_request' };
  }
  let result: CreatePaymentLinkResult;
  try {
    result = await razorpayCreate({
      keyId: secrets.keyId, keySecret: secrets.keySecret,
      amountMinor: minorFromDb(row.amount_minor) ?? 0, currency: row.currency,
      description: row.description ?? undefined, referenceId: row.reference_id, expireBy: expiresAt,
    });
  } catch {
    // Input refused before any request: nothing was created.
    return { row: (await markFailed(row.account_id, row.id, ['creating'])) ?? row, outcome: 'rejected', reason: 'invalid_request' };
  }
  if (result.outcome === 'created') return { row: (await applyCreated(row.account_id, row.id, result.link)) ?? row, outcome: 'created' };
  if (result.outcome === 'rejected' && result.reason === 'duplicate_reference') {
    // Razorpay already holds a link for this reference: adopt it.
    const found = await razorpayFetchByReference({ keyId: secrets.keyId, keySecret: secrets.keySecret, referenceId: row.reference_id }).catch(() => null);
    if (found) return { row: (await applyCreated(row.account_id, row.id, found)) ?? row, outcome: 'created' };
    return { row: (await markUnknown(row.account_id, row.id)) ?? row, outcome: 'unknown' };
  }
  if (result.outcome === 'rejected') return { row: (await markFailed(row.account_id, row.id, ['creating'])) ?? row, outcome: 'rejected', reason: result.reason };
  return { row: (await markUnknown(row.account_id, row.id)) ?? row, outcome: 'unknown' };
}

/**
 * Creates a link, or returns the one already stored for `referenceId`
 * (reconciling it first when its earlier create had an unknown outcome).
 * Throws PaymentLinkError for bad input, a missing target or no Razorpay
 * connection; provider refusals come back as outcome 'rejected' with the
 * row marked failed, and an ambiguous create as 'unknown'.
 */
export async function createPaymentLinkRecord(input: CreateLinkInput): Promise<{ link: PaymentLinkView; outcome: CreateOutcome; reason?: string }> {
  validateCreateInput(input);
  if (!/^[A-Za-z0-9_-]{16,40}$/.test(input.referenceId)) throw new PaymentLinkError('reference_conflict');
  const secrets = await secretsOrThrow(input.accountId);
  const { row, inserted } = await claimReference(input);
  if (!inserted) {
    const settled = await settleExisting(row, secrets);
    return { link: toView(settled), outcome: 'existing' };
  }
  const created = await createAtProvider(row, secrets);
  return { link: toView(created.row), outcome: created.outcome, reason: created.reason };
}

/** A replayed create: an unknown or abandoned one is reconciled; anything else is returned as stored. */
async function settleExisting(row: LinkRow, secrets: RazorpaySecrets): Promise<LinkRow> {
  if (row.status === 'unknown' || (row.status === 'creating' && isStaleCreating(row))) {
    try {
      return (await reconcileRow(row, secrets)).row;
    } catch {
      return row;
    }
  }
  return row;
}

export function isStaleCreating(row: { status: string; updated_at: Date | string }, now = Date.now()): boolean {
  return row.status === 'creating' && now - new Date(row.updated_at).getTime() > STALE_CREATING_MS;
}

/**
 * Settles one link against Razorpay. An unknown (or abandoned creating) link
 * is looked up by reference first; only when Razorpay has none is it created
 * again, under a claim so two reconciles cannot both create. A live link is
 * re-read by id, which may show it paid. Throws PaymentLinkError('busy') when
 * a create is in flight and provider errors as PaymentLinkError.
 */
async function reconcileRow(row: LinkRow, secrets: RazorpaySecrets): Promise<{ row: LinkRow; changed: boolean }> {
  const creds = { keyId: secrets.keyId, keySecret: secrets.keySecret };
  if (row.status === 'creating' && !isStaleCreating(row)) throw new PaymentLinkError('busy');
  if (row.status === 'unknown' || row.status === 'creating') {
    let found: RazorpayPaymentLink | null;
    try {
      found = await razorpayFetchByReference({ ...creds, referenceId: row.reference_id });
    } catch (error) {
      throw providerError(error);
    }
    if (found) {
      const applied = await applyCreated(row.account_id, row.id, found);
      return { row: applied ?? row, changed: true };
    }
    // Razorpay has no link for this reference: claim the row and create it now.
    // The claim moves it to 'creating' (and the trigger bumps updated_at), so a
    // concurrent reconcile finds neither 'unknown' nor a stale 'creating'.
    const claimed = await worker(row.account_id, (tx) => tx.$queryRawUnsafe<LinkRow[]>(
      `UPDATE payment_links SET status='creating' WHERE account_id=$1::uuid AND id=$2::uuid
         AND (status='unknown' OR (status='creating' AND updated_at < now() - ($3::int * interval '1 millisecond'))) RETURNING ${LINK_COLUMNS}`,
      row.account_id, row.id, STALE_CREATING_MS,
    ));
    if (!claimed[0]) throw new PaymentLinkError('busy');
    const created = await createAtProvider(claimed[0], secrets);
    return { row: created.row, changed: true };
  }
  if ((row.status === 'created' || row.status === 'partially_paid') && row.provider_link_id) {
    let fetched: RazorpayPaymentLink;
    try {
      fetched = await razorpayFetch({ ...creds, id: row.provider_link_id });
    } catch (error) {
      throw providerError(error);
    }
    const applied = await applyProviderState(row.account_id, row.id, {
      status: fetched.status, providerLinkId: fetched.id, shortUrl: fetched.shortUrl, expireBy: fetched.expireBy,
    }, 'fetch');
    return { row: applied?.row ?? row, changed: applied?.changed ?? false };
  }
  return { row, changed: false };
}

/** Loads a link through the worker role (after the caller's own role check). */
async function loadForAction(accountId: string, linkId: string): Promise<LinkRow> {
  if (!UUID.test(linkId)) throw new PaymentLinkError('not_found');
  const row = await worker(accountId, (tx) => selectLink(tx, accountId, { id: linkId }));
  if (!row) throw new PaymentLinkError('not_found');
  return row;
}

/** Reconcile action for the API: settles the link, then resumes a waiting flow step if it ended. */
export async function reconcilePaymentLink(accountId: string, linkId: string): Promise<{ link: PaymentLinkView; changed: boolean }> {
  const row = await loadForAction(accountId, linkId);
  if (TERMINAL_STATUSES.has(row.status as PaymentLinkStatus)) return { link: toView(row), changed: false };
  const secrets = await secretsOrThrow(accountId);
  const result = await reconcileRow(row, secrets);
  await resumeFlowForLink(result.row);
  return { link: toView(result.row), changed: result.changed };
}

/** Cancels an unpaid link at Razorpay and records the result. */
export async function cancelPaymentLinkRecord(accountId: string, linkId: string): Promise<PaymentLinkView> {
  const row = await loadForAction(accountId, linkId);
  if (!(row.status === 'created' || row.status === 'partially_paid') || !row.provider_link_id) throw new PaymentLinkError('not_cancellable');
  const secrets = await secretsOrThrow(accountId);
  const creds = { keyId: secrets.keyId, keySecret: secrets.keySecret };
  let link: RazorpayPaymentLink;
  try {
    link = await razorpayCancel({ ...creds, id: row.provider_link_id });
  } catch (error) {
    if (error instanceof RazorpayError && error.reason === 'invalid_request') {
      // Usually already paid or expired: read the truth instead.
      const settled = await reconcileRow(row, secrets);
      await resumeFlowForLink(settled.row);
      if (settled.row.status === 'paid') throw new PaymentLinkError('not_cancellable');
      return toView(settled.row);
    }
    throw providerError(error);
  }
  const applied = await applyProviderState(accountId, row.id, { status: link.status === 'unknown' ? 'cancelled' : link.status, providerLinkId: link.id }, 'fetch');
  const final = applied?.row ?? row;
  await resumeFlowForLink(final);
  return toView(final);
}

// ---------------------------------------------------------------------------
// Webhook processing (the job queued by the webhook route)

export interface PaymentEventReceipt {
  accountId: string;
  event: string;
  paymentLinkId: string;
  referenceId: string | null;
  status: RazorpayLinkStatus | 'unknown';
}

/**
 * Applies one verified Razorpay delivery: finds the link by provider id (or
 * our reference), moves its status, marks the order paid, notifies agents and
 * resumes a flow run waiting on it. Safe to run twice: the receipt is marked
 * processed and every step is idempotent.
 */
export async function handlePaymentEventJob(accountId: string, payload: Record<string, unknown>): Promise<void> {
  const receiptId = typeof payload.receiptId === 'string' && UUID.test(payload.receiptId) ? payload.receiptId : null;
  if (!receiptId) throw new Error('Invalid payment event job contract');
  const receipts = await getWorkerPrisma().$queryRaw<{ payload: PaymentEventReceipt; status: string }[]>`
    SELECT payload,status FROM webhook_receipts WHERE id=${receiptId}::uuid AND provider='razorpay'`;
  const receipt = receipts[0];
  if (!receipt || receipt.status === 'processed') return;
  if (receipt.payload?.accountId !== accountId) throw new Error('Payment event tenant mismatch');
  const status = statusForEvent(receipt.payload.event);
  if (status) {
    const row = await worker(accountId, async (tx) =>
      (await selectLink(tx, accountId, { providerLinkId: receipt.payload.paymentLinkId }))
      ?? (receipt.payload.referenceId ? await selectLink(tx, accountId, { referenceId: receipt.payload.referenceId }) : null));
    if (row) {
      const applied = await applyProviderState(accountId, row.id, { status, providerLinkId: receipt.payload.paymentLinkId }, 'webhook');
      if (applied) await resumeFlowForLink(applied.row);
    }
  }
  await getWorkerPrisma().$executeRaw`UPDATE webhook_receipts SET status='processed' WHERE id=${receiptId}::uuid`;
}

/** The flow outcome a link's status stands for, or null while it is still open. */
export function flowOutcomeFor(status: PaymentLinkStatus): 'paid' | 'expired' | 'failed' | null {
  if (status === 'paid') return 'paid';
  if (status === 'expired' || status === 'cancelled') return 'expired';
  if (status === 'failed') return 'failed';
  return null;
}

/** Resumes the flow run waiting on this link, if any. Idempotent: the engine checks the run still waits on it. */
export async function resumeFlowForLink(row: Pick<LinkRow, 'account_id' | 'flow_run_id' | 'node_key' | 'reference_id' | 'status'>): Promise<void> {
  const outcome = flowOutcomeFor(row.status as PaymentLinkStatus);
  if (!outcome || !row.flow_run_id || !row.node_key) return;
  // Imported lazily: the engine imports this module to create links.
  const { resumePaymentLinkRun } = await import('@/lib/flows/engine');
  await resumePaymentLinkRun({ accountId: row.account_id, runId: row.flow_run_id, nodeKey: row.node_key, referenceId: row.reference_id, outcome, status: row.status });
}

/** The current state of a link by reference (worker role), for the flow engine. */
export async function findLinkByReference(accountId: string, referenceId: string): Promise<PaymentLinkView | null> {
  const row = await worker(accountId, (tx) => selectLink(tx, accountId, { referenceId }));
  return row ? toView(row) : null;
}

// ---------------------------------------------------------------------------
// Sending a link into a conversation (inbox)

export interface SendLinkArgs {
  accountId: string;
  userId: string;
  role: NonNullable<TenantContext['role']>;
  linkId: string;
  /** Optional text above the URL. */
  message?: string | null;
  /** Unique per send attempt; a replay with the same key never sends twice. */
  intentKey: string;
}

/**
 * Sends a created link as a text message from the conversation's own number.
 * Needs an open 24-hour window (a free-form text). Throws PaymentLinkError for
 * a refusal (nothing sent), MetaApiError when Meta rejects it and
 * UncertainDispatchError when the outcome is unknown.
 */
export async function sendPaymentLinkMessage(args: SendLinkArgs): Promise<{ whatsappMessageId: string; messageId: string | null }> {
  const message = (args.message ?? '').trim();
  if (message.length > MESSAGE_MAX) throw new PaymentLinkError('invalid_message');
  const context: TenantContext = { accountId: args.accountId, userId: args.userId, role: args.role };
  const prepared = await withTenant(context, async (tx) => {
    const link = await selectLink(tx, args.accountId, { id: args.linkId });
    if (!link) throw new PaymentLinkError('not_found');
    if (!(link.status === 'created' || link.status === 'partially_paid') || !link.short_url) throw new PaymentLinkError('link_not_ready');
    if (!link.conversation_id) throw new PaymentLinkError('conversation_not_found');
    const conversations = await tx.$queryRaw<{ last_customer_message_at: Date | null; phone: string | null; wa_user_id: string | null;
      blocked_at: Date | null; whatsapp_config_id: string | null }[]>`
      SELECT
        -- conversations has no such column; the 24-hour window comes from the latest customer message.
        (SELECT max(m.created_at) FROM messages m WHERE m.account_id=c.account_id AND m.conversation_id=c.id
          AND m.sender_type='customer') AS last_customer_message_at,
        ct.phone,ct.wa_user_id,ct.blocked_at,c.whatsapp_config_id::text AS whatsapp_config_id
      FROM conversations c JOIN contacts ct ON ct.account_id=c.account_id AND ct.id=c.contact_id
      WHERE c.account_id=${args.accountId}::uuid AND c.id=${link.conversation_id}::uuid`;
    const conversation = conversations[0];
    if (!conversation) throw new PaymentLinkError('conversation_not_found');
    if (conversation.blocked_at) throw new PaymentLinkError('contact_blocked');
    const target = resolveContactSendTarget(conversation);
    if (!target) throw new PaymentLinkError('no_address');
    const last = conversation.last_customer_message_at ? new Date(conversation.last_customer_message_at).getTime() : NaN;
    if (!Number.isFinite(last) || Date.now() - last >= SERVICE_WINDOW_MS) throw new PaymentLinkError('window_closed');
    // The conversation's number (the workspace default for a legacy row); a disconnected number refuses.
    const config = await getNumberConfig(tx, args.accountId, conversation.whatsapp_config_id ?? null).catch((error: unknown) => {
      if (error instanceof NoNumberError) throw new PaymentLinkError('number_unavailable');
      throw error;
    });
    if (!config.phone_number_id || !config.access_token) throw new PaymentLinkError('number_unavailable');
    return { conversationId: link.conversation_id, shortUrl: link.short_url, target, phoneNumberId: config.phone_number_id, accessTokenEnc: config.access_token };
  });

  const text = paymentLinkMessageText(message, prepared.shortUrl);
  const { messageId: whatsappMessageId } = await dispatchOnce(args.accountId, args.intentKey, async () => {
    const accessToken = decrypt(prepared.accessTokenEnc);
    const variants = prepared.target.isPhone ? phoneVariants(prepared.target.target) : [prepared.target.target];
    let lastError: unknown = null;
    for (const to of variants) {
      try {
        return await sendTextMessage({ phoneNumberId: prepared.phoneNumberId, accessToken, to, text });
      } catch (error) {
        if (!isRecipientNotAllowedError(error instanceof Error ? error.message : String(error))) throw error;
        lastError = error;
      }
    }
    throw lastError;
  });

  const messageId = await withTenant(context, async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,message_id,status)
      VALUES(${args.accountId}::uuid,${prepared.conversationId}::uuid,'agent','text',${text},${whatsappMessageId},'sent')
      ON CONFLICT(conversation_id,message_id) DO NOTHING RETURNING id`;
    // An agent stepping in pauses the bot, as every inbox send does.
    await tx.$executeRaw`UPDATE conversations SET last_message_text=${text},last_message_at=NOW(),updated_at=NOW(),bot_paused=true
      WHERE account_id=${args.accountId}::uuid AND id=${prepared.conversationId}::uuid`;
    return rows[0]?.id ?? null;
  });
  return { whatsappMessageId, messageId };
}
