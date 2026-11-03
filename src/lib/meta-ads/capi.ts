// Conversions API for click-to-WhatsApp ads (part d, design section 6).
//
// Enqueue: an event row and its meta.capi_event job are written inside the
// caller's transaction (payment link, manual order, form submission), so they
// commit with the business change. It works in worker and app-role (member)
// transactions alike: it reads only app-visible columns and the app role may
// insert a 'queued' event (RLS app_enqueue). It never calls Meta and is a
// no-op, before any SQL, while the feature is off.
//
// Send: the job re-checks everything, then posts through an outbound intent
// (dispatchOnce). A rejection is recorded as 'failed' (an invalid token also
// marks the connection token_invalid); a throttle re-schedules the send minutes
// later, a bounded number of times; an ambiguous outcome becomes 'unknown' and
// waits for an admin. It is never re-sent automatically. The job's last attempt
// never sends, so a worker that dies mid-send always leaves an attempt that
// turns the claimed intent into 'unknown'. Only Meta's code[:subcode] is stored
// or logged.
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { dispatchOnce, UncertainDispatchError } from '@/lib/jobs/dispatch';
import { currencyExponent, isCurrencyCode, minorToDecimalString } from '@/lib/commerce/money';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { capiEvent, isMetaThrottle, isMetaTokenInvalid, metaErrorCode, postCapiEvents, type CapiEventName } from './graph';
import { metaAdsConfig, missingScopes } from './config';
import { loadActiveConnectionTx } from './connection';
import { latestAttributableReferralTx } from './referrals';

export type ConversionSource = 'payment_link' | 'order' | 'form' | 'flow';

export interface ConversionEventInput {
  accountId: string;
  eventName: CapiEventName;
  source: ConversionSource;
  /**
   * The business object: the payment link id, the order id, the form
   * submission's WhatsApp message id, or `<run_id>:<node_key>` for a flow node.
   */
  sourceId: string;
  /** Set when an order is involved: a Purchase is then keyed by the order, whichever path reports it. */
  orderId?: string | null;
  contactId: string | null;
  value?: number | null;
  /** ISO 4217, three upper-case letters. */
  currency?: string | null;
  /** Defaults to now. */
  eventTime?: Date;
}

export const CAPI_EVENT_JOB = 'meta.capi_event';
/** Meta attributes a business-messaging event to the ad click for 7 days. */
export const CAPI_ATTRIBUTION_DAYS = 7;
/** The last attempt only reconciles (it never sends), so five attempts may send. */
const CAPI_MAX_ATTEMPTS = 6;
/**
 * A Meta throttle lasts minutes to an hour, longer than the job's own backoff:
 * each throttle re-schedules the send this much later, then the event fails.
 */
export const CAPI_THROTTLE_DELAYS_MS: readonly number[] = [5, 15, 60, 60].map((m) => m * 60_000);
const MAX_VALUE = 999_999_999_999.99;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_NAMES: readonly CapiEventName[] = ['Purchase', 'LeadSubmitted', 'QualifiedLead', 'InitiateCheckout', 'AddToCart', 'ViewContent', 'OrderCreated'];
const SOURCES: readonly ConversionSource[] = ['payment_link', 'order', 'form', 'flow'];

/**
 * The deterministic event id (dedupe key for capi_events, the job and Meta):
 * Purchase with an order -> `order:<orderId>:Purchase`; otherwise
 * `<source>:<sourceId>:<eventName>` (a flow node's sourceId is `<run>:<node>`).
 */
export function conversionEventId(input: Pick<ConversionEventInput, 'eventName' | 'source' | 'sourceId' | 'orderId'>): string {
  if (input.eventName === 'Purchase' && input.orderId) return `order:${input.orderId}:Purchase`;
  return `${input.source}:${input.sourceId}:${input.eventName}`;
}

/** A minor-unit amount as the decimal CAPI value, or null when it cannot be represented. */
export function capiValue(minor: number | bigint | null | undefined, currency: string | null | undefined): number | null {
  if (minor === null || minor === undefined || !isCurrencyCode(currency)) return null;
  try {
    const value = Number(minorToDecimalString(minor, currency));
    return Number.isFinite(value) && value >= 0 && value <= MAX_VALUE ? value : null;
  } catch {
    return null;
  }
}

/** Rounds to the currency's minor unit (INR 2, JPY 0, KWD 3 digits); capi_events.value keeps six. */
export function cleanValue(value: number | null | undefined, currency: string): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_VALUE) return null;
  const scale = 10 ** currencyExponent(currency);
  return Math.round(value * scale) / scale;
}

interface CapiSettingsRow {
  id: string;
  capi_enabled: boolean;
  capi_dataset_id: string | null;
  capi_waba_id: string | null;
  capi_whatsapp_config_id: string | null;
  capi_auto_purchase: boolean;
  capi_auto_lead: boolean;
}

/**
 * Queues a conversion event and its meta.capi_event job inside the caller's
 * transaction (worker or app role). Returns true only when a new event row was
 * queued. A no-op when the feature, CAPI, the matching auto toggle or an
 * attributable ad click is missing. It never throws: its SQL runs under a
 * savepoint, so a failure here cannot roll back the payment or order.
 */
export async function queueConversionEventTx(tx: TenantTransaction, input: ConversionEventInput): Promise<boolean> {
  if (!metaAdsConfig()) return false;
  const { accountId, contactId } = input;
  if (!UUID.test(accountId) || !contactId || !UUID.test(contactId)) return false;
  if (!EVENT_NAMES.includes(input.eventName) || !SOURCES.includes(input.source)) return false;
  if (input.orderId && !UUID.test(input.orderId)) return false;
  const eventId = conversionEventId(input);
  if (!input.sourceId || input.sourceId.length > 200 || eventId.length > 200) return false;
  const currency = isCurrencyCode(input.currency) ? input.currency : null;
  const value = currency ? cleanValue(input.value, currency) : null;
  const eventTime = input.eventTime instanceof Date && !Number.isNaN(input.eventTime.getTime()) ? input.eventTime : new Date();

  await tx.$executeRaw`SAVEPOINT capi_enqueue`;
  try {
    const queued = await enqueue(tx, { ...input, contactId }, eventId, value, currency, eventTime);
    await tx.$executeRaw`RELEASE SAVEPOINT capi_enqueue`;
    return queued;
  } catch {
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT capi_enqueue`;
    console.error('[meta-ads] conversion event not queued');
    return false;
  }
}

async function enqueue(tx: TenantTransaction, input: ConversionEventInput & { contactId: string }, eventId: string,
  value: number | null, currency: string | null, eventTime: Date): Promise<boolean> {
  const { accountId } = input;
  const [conn] = await tx.$queryRaw<CapiSettingsRow[]>`
    SELECT id::text AS id, capi_enabled, capi_dataset_id, capi_waba_id, capi_whatsapp_config_id::text AS capi_whatsapp_config_id,
      capi_auto_purchase, capi_auto_lead
    FROM meta_ad_connections WHERE account_id=${accountId}::uuid AND status='active' LIMIT 1`;
  if (!conn?.capi_enabled || !conn.capi_dataset_id || !conn.capi_waba_id) return false;
  if ((input.source === 'payment_link' || input.source === 'order') && !conn.capi_auto_purchase) return false;
  if (input.source === 'form' && !conn.capi_auto_lead) return false;

  // A dataset belongs to one WABA: only a click that arrived on one of its numbers is attributable.
  const numbers = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM whatsapp_config WHERE account_id=${accountId}::uuid AND waba_id=${conn.capi_waba_id}`;
  const numberIds = new Set(numbers.map((n) => n.id));
  if (conn.capi_whatsapp_config_id) numberIds.add(conn.capi_whatsapp_config_id);
  const referral = await latestAttributableReferralTx(tx, accountId, input.contactId, CAPI_ATTRIBUTION_DAYS, [...numberIds]);
  if (!referral) return false;

  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO capi_events(account_id, connection_id, event_name, event_id, source, source_id, contact_id, ad_referral_id,
      value, currency, event_time)
    VALUES (${accountId}::uuid, ${conn.id}::uuid, ${input.eventName}, ${eventId}, ${input.source}, ${input.sourceId},
      ${input.contactId}::uuid, ${referral.id}::uuid, ${value}::numeric, ${currency}, ${eventTime})
    ON CONFLICT (account_id, event_id) DO NOTHING
    RETURNING id::text AS id`;
  const id = inserted[0]?.id;
  if (!id) return false;
  await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,max_attempts)
    VALUES(${CAPI_EVENT_JOB},${accountId}::uuid,${JSON.stringify({ capiEventId: id })}::jsonb,${`capi:${accountId}:${eventId}`},${CAPI_MAX_ATTEMPTS})
    ON CONFLICT(dedupe_key) DO NOTHING`;
  return true;
}

/** The same in its own worker transaction (for the flow node, whose executor holds no transaction). Never throws. */
export async function queueConversionEvent(accountId: string, input: Omit<ConversionEventInput, 'accountId'>): Promise<boolean> {
  if (!metaAdsConfig()) return false;
  if (!UUID.test(accountId)) return false;
  try {
    return await withTenant({ accountId, role: 'owner' },
      (tx) => queueConversionEventTx(tx, { ...input, accountId }), getWorkerPrisma());
  } catch {
    console.error('[meta-ads] conversion event not queued');
    return false;
  }
}

// ---------------------------------------------------------------------------
// Send (meta.capi_event)

export type CapiEventStatus = 'queued' | 'sent' | 'failed' | 'unknown' | 'skipped';
export type CapiSkipReason = 'disabled' | 'no_connection' | 'missing_scope' | 'no_dataset' | 'wrong_waba';

interface QueuedEventRow {
  id: string;
  event_id: string;
  event_name: CapiEventName;
  status: CapiEventStatus;
  ad_referral_id: string | null;
  value: number | null;
  currency: string | null;
  event_time: Date;
  throttle_count: number;
}

type SendPlan =
  | { kind: 'noop' }
  | { kind: 'settle'; status: CapiEventStatus; skipReason?: CapiSkipReason | null }
  | { kind: 'send'; row: QueuedEventRow; connectionId: string; datasetId: string; wabaId: string; token: string; ctwaClid: string };

const worker = <T>(accountId: string, work: (tx: TenantTransaction) => Promise<T>) =>
  withTenant({ accountId, role: 'owner' }, work, getWorkerPrisma());

async function settle(accountId: string, id: string, status: CapiEventStatus,
  extra: { skipReason?: CapiSkipReason | null; errorCode?: string | null } = {}): Promise<void> {
  await worker(accountId, (tx) => tx.$executeRaw`
    UPDATE capi_events SET status=${status}, skip_reason=${extra.skipReason ?? null},
      last_error_code=COALESCE(${extra.errorCode ?? null}, last_error_code),
      sent_at=CASE WHEN ${status === 'sent'} THEN now() ELSE sent_at END
    WHERE account_id=${accountId}::uuid AND id=${id}::uuid AND status='queued'`);
}

const errorCodeOf = (error: unknown): string | null => {
  const code = metaErrorCode(error);
  if (code && /^[0-9:]{1,32}$/.test(code)) return code;
  return error instanceof MetaApiError ? String(error.httpStatus).slice(0, 32) : null;
};

/**
 * meta.capi_event: sends one queued event through an outbound intent. With
 * `attempt` from the queue, the job's last attempt only reconciles: the queue
 * fails a job whose lease expired on its last attempt without running it again,
 * so a send on that attempt could leave a claimed intent behind a 'queued' row.
 */
export async function handleCapiEventJob(accountId: string, payload: Record<string, unknown>,
  attempt?: { attempts: number; maxAttempts: number }): Promise<void> {
  const capiEventId = typeof payload.capiEventId === 'string' && UUID.test(payload.capiEventId) ? payload.capiEventId : null;
  if (!capiEventId) throw new Error('Invalid conversion event job');
  const enabled = metaAdsConfig() !== null;
  const lastAttempt = !!attempt && attempt.maxAttempts > 1 && attempt.attempts >= attempt.maxAttempts;

  const plan = await worker(accountId, async (tx): Promise<SendPlan> => {
    const [row] = await tx.$queryRaw<QueuedEventRow[]>`
      SELECT id::text AS id, event_id, event_name, status, ad_referral_id::text AS ad_referral_id,
        value::float8 AS value, currency, event_time, throttle_count
      FROM capi_events WHERE account_id=${accountId}::uuid AND id=${capiEventId}::uuid`;
    if (!row || row.status !== 'queued') return { kind: 'noop' };
    // A previous attempt already claimed the send: its intent decides, never a fresh plan.
    const [intent] = await tx.$queryRaw<{ status: string }[]>`
      SELECT status FROM outbound_intents WHERE account_id=${accountId}::uuid AND idempotency_key=${`${accountId}:capi:${row.event_id}`}`;
    if (intent?.status === 'accepted') return { kind: 'settle', status: 'sent' };
    if (intent && intent.status !== 'failed') return { kind: 'settle', status: 'unknown' };

    // Earlier attempts failed before claiming a send (database or network errors).
    if (lastAttempt) return { kind: 'settle', status: 'failed' };
    if (!enabled) return { kind: 'settle', status: 'skipped', skipReason: 'disabled' };
    const conn = await loadActiveConnectionTx(tx, accountId);
    if (!conn || !conn.userToken) return { kind: 'settle', status: 'skipped', skipReason: 'no_connection' };
    if (!conn.capiEnabled) return { kind: 'settle', status: 'skipped', skipReason: 'disabled' };
    if (missingScopes(conn.scopes, 'capi').length) return { kind: 'settle', status: 'skipped', skipReason: 'missing_scope' };
    if (!conn.capiDatasetId || !conn.capiWabaId) return { kind: 'settle', status: 'skipped', skipReason: 'no_dataset' };
    if (!row.ad_referral_id) return { kind: 'settle', status: 'skipped' };
    const [referral] = await tx.$queryRaw<{ ctwa_clid: string | null; waba_id: string | null }[]>`
      SELECT r.ctwa_clid, w.waba_id FROM ad_referrals r
      LEFT JOIN whatsapp_config w ON w.account_id=r.account_id AND w.id=r.whatsapp_config_id
      WHERE r.account_id=${accountId}::uuid AND r.id=${row.ad_referral_id}::uuid`;
    if (!referral?.ctwa_clid) return { kind: 'settle', status: 'skipped' };
    if (referral.waba_id !== conn.capiWabaId) return { kind: 'settle', status: 'skipped', skipReason: 'wrong_waba' };
    return { kind: 'send', row, connectionId: conn.id, datasetId: conn.capiDatasetId, wabaId: conn.capiWabaId, token: conn.userToken, ctwaClid: referral.ctwa_clid };
  });

  if (plan.kind === 'noop') return;
  if (plan.kind === 'settle') return settle(accountId, capiEventId, plan.status, { skipReason: plan.skipReason });

  const { row } = plan;
  const event = capiEvent({
    eventName: row.event_name, eventTime: row.event_time, eventId: row.event_id, wabaId: plan.wabaId,
    ctwaClid: plan.ctwaClid, value: row.value, currency: row.currency,
  });
  try {
    // A queued row with a 'failed' intent was rejected by Meta (a throttle, or a crash
    // before the row was updated): Meta recorded nothing and dedupes on event_id, so a
    // re-claim is safe. Every other intent state stopped above.
    await dispatchOnce(accountId, `capi:${row.event_id}`, () => postCapiEvents(plan.datasetId, plan.token, [event]),
      { retryRejected: true });
  } catch (error) {
    if (error instanceof UncertainDispatchError) {
      console.error('[meta-ads] conversion event outcome unknown');
      return settle(accountId, capiEventId, 'unknown');
    }
    if (error instanceof MetaApiError && error.httpStatus >= 400 && error.httpStatus < 500) {
      const code = errorCodeOf(error);
      console.error('[meta-ads] conversion event rejected', { code });
      if (isMetaThrottle(error) && await rescheduleAfterThrottle(accountId, row, code)) return;
      if (isMetaTokenInvalid(error)) {
        // Like the leads and insights jobs: the admin must reconnect, and later events skip as no_connection.
        await worker(accountId, (tx) => tx.$executeRaw`
          UPDATE meta_ad_connections SET status='token_invalid', last_error_code=${code}, updated_at=now()
          WHERE account_id=${accountId}::uuid AND id=${plan.connectionId}::uuid AND status='active'`);
      }
      return settle(accountId, capiEventId, 'failed', { errorCode: code });
    }
    throw error;
  }
  await settle(accountId, capiEventId, 'sent');
}

/**
 * Keeps a throttled event queued and, in the same transaction, queues a new
 * meta.capi_event job for it minutes later (its own dedupe key per round, so
 * the running job finishes normally). False once the rounds are used up.
 */
async function rescheduleAfterThrottle(accountId: string, row: QueuedEventRow, code: string | null): Promise<boolean> {
  return worker(accountId, async (tx) => {
    const [updated] = await tx.$queryRaw<{ throttle_count: number }[]>`
      UPDATE capi_events SET last_error_code=${code}, throttle_count=throttle_count+1
      WHERE account_id=${accountId}::uuid AND id=${row.id}::uuid AND status='queued'
        AND throttle_count < ${CAPI_THROTTLE_DELAYS_MS.length}
      RETURNING throttle_count`;
    if (!updated) return false;
    const round = Number(updated.throttle_count);
    const runAt = new Date(Date.now() + CAPI_THROTTLE_DELAYS_MS[round - 1]);
    await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,run_at,max_attempts)
      VALUES(${CAPI_EVENT_JOB},${accountId}::uuid,${JSON.stringify({ capiEventId: row.id })}::jsonb,
        ${`capi:${accountId}:${row.event_id}:throttle:${round}`},${runAt},${CAPI_MAX_ATTEMPTS})
      ON CONFLICT(dedupe_key) DO NOTHING`;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Event log and reconciliation (admins)

export type CapiResolution = 'confirmed_sent' | 'confirmed_not_sent';
export const CAPI_RESOLUTIONS: readonly CapiResolution[] = ['confirmed_sent', 'confirmed_not_sent'];
export const CAPI_STATUSES: readonly CapiEventStatus[] = ['queued', 'sent', 'failed', 'unknown', 'skipped'];
/** 'review' lists the unknown-outcome events that still need an admin. */
export type CapiListFilter = CapiEventStatus | 'review';

export class CapiError extends Error {
  constructor(public readonly code: 'not_found' | 'not_open', public readonly status: number) {
    super(code);
    this.name = 'CapiError';
  }
}

export interface ConversionEventDto {
  id: string;
  eventName: CapiEventName;
  source: ConversionSource;
  status: CapiEventStatus;
  skipReason: CapiSkipReason | null;
  errorCode: string | null;
  value: number | null;
  currency: string | null;
  contactId: string | null;
  contactName: string | null;
  eventTime: string;
  createdAt: string;
  sentAt: string | null;
  resolution: CapiResolution | null;
  resolvedAt: string | null;
}

interface EventRow {
  id: string; event_name: CapiEventName; source: ConversionSource; status: CapiEventStatus; skip_reason: CapiSkipReason | null;
  last_error_code: string | null; value: number | null; currency: string | null; contact_id: string | null;
  contact_name: string | null; event_time: Date; created_at: Date; sent_at: Date | null; resolution: CapiResolution | null;
  resolved_at: Date | null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const toDto = (r: EventRow): ConversionEventDto => ({
  id: r.id, eventName: r.event_name, source: r.source, status: r.status, skipReason: r.skip_reason,
  errorCode: r.last_error_code, value: r.value, currency: r.currency, contactId: r.contact_id, contactName: r.contact_name,
  eventTime: r.event_time.toISOString(), createdAt: r.created_at.toISOString(), sentAt: iso(r.sent_at),
  resolution: r.resolution, resolvedAt: iso(r.resolved_at),
});

export const CONVERSIONS_PAGE_SIZE = 100;

export function parseListFilter(value: string | null): CapiListFilter | null | undefined {
  if (value === null || value === '' || value === 'all') return null;
  if (value === 'review' || (CAPI_STATUSES as readonly string[]).includes(value)) return value as CapiListFilter;
  return undefined;
}

export function parseResolution(body: unknown): CapiResolution | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const r = (body as { resolution?: unknown }).resolution;
  return typeof r === 'string' && (CAPI_RESOLUTIONS as readonly string[]).includes(r) ? (r as CapiResolution) : null;
}

const selectEvents = (tx: TenantTransaction, accountId: string, filter: CapiListFilter | null, id: string | null) =>
  tx.$queryRaw<EventRow[]>`
    SELECT e.id::text AS id, e.event_name, e.source, e.status, e.skip_reason, e.last_error_code, e.value::float8 AS value,
      e.currency, e.contact_id::text AS contact_id, c.name AS contact_name, e.event_time, e.created_at, e.sent_at,
      e.resolution, e.resolved_at
    FROM capi_events e
    LEFT JOIN contacts c ON c.account_id=e.account_id AND c.id=e.contact_id
    WHERE e.account_id=${accountId}::uuid
      AND (${id}::uuid IS NULL OR e.id=${id}::uuid)
      AND (${filter}::text IS NULL
        OR (${filter}::text='review' AND e.status='unknown' AND e.resolution IS NULL)
        OR e.status=${filter}::text)
    ORDER BY e.created_at DESC, e.id DESC
    LIMIT ${CONVERSIONS_PAGE_SIZE}`;

/** The newest events (at most 100), optionally by status or the 'review' queue. Stored data only. */
export async function listConversionEvents(ctx: TenantContext, filter: CapiListFilter | null = null): Promise<ConversionEventDto[]> {
  return withTenant(ctx, async (tx) => (await selectEvents(tx, ctx.accountId, filter, null)).map(toDto));
}

/**
 * Records what an admin found in Events Manager for an 'unknown' event. Never
 * sends or re-sends anything, and keeps the outbound intent. RLS and the WHERE
 * both allow it only once, only for 'unknown', only for admins.
 */
export async function resolveConversionEvent(ctx: TenantContext, id: string, resolution: CapiResolution): Promise<ConversionEventDto> {
  if (!UUID.test(id)) throw new CapiError('not_found', 404);
  if (!ctx.userId) throw new Error('Resolution needs the acting user');
  return withTenant(ctx, async (tx) => {
    const updated = await tx.$executeRaw`
      UPDATE capi_events SET resolution=${resolution}, resolved_by=${ctx.userId}::uuid, resolved_at=now()
      WHERE account_id=${ctx.accountId}::uuid AND id=${id}::uuid AND status='unknown' AND resolution IS NULL`;
    if (updated !== 1) {
      const seen = await selectEvents(tx, ctx.accountId, null, id);
      throw seen.length ? new CapiError('not_open', 409) : new CapiError('not_found', 404);
    }
    await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
      VALUES(${ctx.accountId}::uuid,${ctx.userId}::uuid,'meta_capi.resolve',${id},${JSON.stringify({ resolution })}::jsonb)`;
    const [row] = await selectEvents(tx, ctx.accountId, null, id);
    return toDto(row);
  });
}
