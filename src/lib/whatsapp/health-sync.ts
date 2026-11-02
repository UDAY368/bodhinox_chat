/**
 * WhatsApp number health sync and admin alerts.
 *
 * Every six hours the worker refreshes each connected number's Meta health
 * (quality rating, messaging limit tier, display-name status, code
 * verification status) onto its whatsapp_config row. When quality drops
 * (GREEN to YELLOW or RED, YELLOW to RED), the tier changes or the display name
 * is rejected, each owner and admin of the workspace gets one in-app
 * notification for that change.
 *
 * Idempotence: the change is detected against the stored values while the row
 * is locked (FOR UPDATE), and the new values are stored in the same transaction
 * as the notifications. A retry or a concurrent run therefore sees no change.
 * Each notification also carries a dedupe key bound to the previous check, with
 * a unique index, so a replayed insert is a no-op.
 *
 * Meta failures are recorded as a fixed category on the row (health_error) and
 * the job completes; the next six-hour cycle retries. Tokens, Meta messages and
 * customer content are never logged or stored.
 */
import type { PrismaClient } from '@prisma/client';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { leaseFetch } from '@/lib/jobs/lease';
import { enqueueJob } from '@/lib/jobs/queue';
import { decrypt } from './encryption';
import { getPhoneNumberHealth, MetaApiError } from './meta-api';
import { parseMessagingLimit } from './phone-health';
import { createNotification } from '@/lib/inbox/notify';

export const HEALTH_SYNC_JOB = 'whatsapp.health_sync';
export const HEALTH_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** How often the scheduler looks for numbers (new numbers wait at most this long). */
export const HEALTH_SCHEDULE_CHECK_MS = 10 * 60 * 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GRAPH = 'https://graph.facebook.com/v21.0';

export interface HealthSnapshot {
  quality_rating: string | null;
  messaging_limit_tier: string | null;
  name_status: string | null;
  code_verification_status: string | null;
}

export type HealthChange =
  | { kind: 'quality_drop'; from: string; to: string }
  | { kind: 'tier_change'; from: string; to: string }
  | { kind: 'name_rejected'; from: string | null; to: string };

export type HealthErrorCategory = 'token' | 'unavailable';

export type HealthSyncResult =
  | { status: 'synced'; snapshot: HealthSnapshot; changes: HealthChange[]; notified: number }
  | { status: 'error'; error: HealthErrorCategory }
  | { status: 'not_found' }
  | { status: 'disconnected' };

export interface FetchedHealth extends HealthSnapshot {
  display_phone_number: string | null;
}

export type HealthFetcher = (args: { phoneNumberId: string; accessToken: string }) => Promise<FetchedHealth>;

/** Meta enum values only (e.g. GREEN, TIER_1K, DECLINED); anything else is treated as absent. */
export function normalizeStatus(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toUpperCase();
  return /^[A-Z0-9_]{1,64}$/.test(value) ? value : null;
}

const QUALITY_RANK: Record<string, number> = { GREEN: 3, YELLOW: 2, RED: 1 };
const REJECTED_NAMES = new Set(['DECLINED', 'REJECTED']);

/**
 * What changed between the stored snapshot and the fresh one. The first sync
 * (nothing stored yet) reports no quality or tier change; a rejected name is
 * reported whenever it is newly observed.
 */
export function detectHealthChanges(previous: HealthSnapshot, next: HealthSnapshot): HealthChange[] {
  const changes: HealthChange[] = [];
  const before = previous.quality_rating && QUALITY_RANK[previous.quality_rating];
  const after = next.quality_rating && QUALITY_RANK[next.quality_rating];
  if (before && after && after < before)
    changes.push({ kind: 'quality_drop', from: previous.quality_rating!, to: next.quality_rating! });
  if (previous.messaging_limit_tier && next.messaging_limit_tier && previous.messaging_limit_tier !== next.messaging_limit_tier)
    changes.push({ kind: 'tier_change', from: previous.messaging_limit_tier, to: next.messaging_limit_tier });
  if (next.name_status && REJECTED_NAMES.has(next.name_status) && previous.name_status !== next.name_status)
    changes.push({ kind: 'name_rejected', from: previous.name_status, to: next.name_status });
  return changes;
}

/** A value Meta did not return keeps what was stored, so a partial answer never erases health. */
export function mergeSnapshot(previous: HealthSnapshot, fetched: HealthSnapshot): HealthSnapshot {
  return {
    quality_rating: fetched.quality_rating ?? previous.quality_rating,
    messaging_limit_tier: fetched.messaging_limit_tier ?? previous.messaging_limit_tier,
    name_status: fetched.name_status ?? previous.name_status,
    code_verification_status: fetched.code_verification_status ?? previous.code_verification_status,
  };
}

/** Bound to the observation it changed from, so the same change can never alert twice. */
export function notificationDedupeKey(configId: string, change: HealthChange, previousCheckedAt: Date | null): string {
  return `wa-health:${configId}:${change.kind}:${previousCheckedAt ? previousCheckedAt.getTime() : 'first'}:${change.to}`;
}

function tierLabel(tier: string): string {
  const limit = parseMessagingLimit(tier);
  if (!limit) return tier;
  return limit.kind === 'unlimited' ? 'unlimited' : `${limit.perDay.toLocaleString('en-US')} per day`;
}

/** Stored title/body text (English, like the other notification types). No customer content. */
export function describeChange(change: HealthChange, numberLabel: string): { title: string; body: string } {
  if (change.kind === 'quality_drop')
    return {
      title: 'WhatsApp number quality dropped',
      body: `${numberLabel}: quality rating went from ${change.from} to ${change.to}. Review recent campaigns, opt-outs and blocks before sending more.`,
    };
  if (change.kind === 'tier_change')
    return {
      title: 'WhatsApp messaging limit changed',
      body: `${numberLabel}: the daily messaging limit changed from ${tierLabel(change.from)} to ${tierLabel(change.to)}.`,
    };
  return {
    title: 'WhatsApp display name rejected',
    body: `${numberLabel}: Meta rejected the display name. Edit it in WhatsApp Manager and resubmit it for review.`,
  };
}

/** A fixed category for a failed Meta call; the message itself is never kept. */
export function categorizeHealthError(error: unknown): HealthErrorCategory {
  if (error instanceof MetaApiError && (error.code === 190 || error.httpStatus === 401)) return 'token';
  return 'unavailable';
}

/**
 * Meta's health for one number: quality through getPhoneNumberHealth (which
 * throws on failure), plus a best-effort read of the review fields. A failed
 * best-effort read leaves those fields absent, and absent fields keep their
 * stored values.
 */
export const fetchNumberHealth: HealthFetcher = async ({ phoneNumberId, accessToken }) => {
  const info = await getPhoneNumberHealth({ phoneNumberId, accessToken });
  const extra = await leaseFetch(
    `${GRAPH}/${encodeURIComponent(phoneNumberId)}?fields=name_status,code_verification_status,messaging_limit_tier`,
    { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10_000) }
  )
    .then(async (response) => (response.ok ? ((await response.json()) as Record<string, unknown>) : null))
    .catch(() => null);
  return {
    display_phone_number: typeof info.display_phone_number === 'string' ? info.display_phone_number.slice(0, 40) : null,
    quality_rating: normalizeStatus(info.quality_rating),
    messaging_limit_tier:
      normalizeStatus(info.whatsapp_business_manager_messaging_limit) ?? normalizeStatus(extra?.messaging_limit_tier),
    name_status: normalizeStatus(extra?.name_status),
    code_verification_status: normalizeStatus(extra?.code_verification_status),
  };
};

interface StoredRow extends HealthSnapshot {
  id: string;
  display_name: string | null;
  health_checked_at: Date | null;
}

export interface SyncOptions {
  accountId: string;
  configId: string;
  /** The tenant scope: the worker passes owner scope; the on-demand route passes the admin's context. */
  tenant?: TenantContext;
  db?: PrismaClient;
  fetchHealth?: HealthFetcher;
  now?: Date;
}

/** Store the new snapshot and alert admins about changes, in one transaction. */
export async function applyHealthSnapshot(
  tx: TenantTransaction,
  args: { accountId: string; configId: string; fetched: FetchedHealth; now: Date }
): Promise<Extract<HealthSyncResult, { status: 'synced' }> | null> {
  const { accountId, configId, fetched, now } = args;
  const rows = await tx.$queryRaw<StoredRow[]>`
    SELECT id, display_name, quality_rating, messaging_limit_tier, name_status, code_verification_status, health_checked_at
    FROM whatsapp_config WHERE account_id=${accountId}::uuid AND id=${configId}::uuid FOR UPDATE`;
  const previous = rows[0];
  if (!previous) return null;
  const snapshot = mergeSnapshot(previous, fetched);
  const changes = detectHealthChanges(previous, snapshot);
  await tx.$executeRaw`
    UPDATE whatsapp_config SET quality_rating=${snapshot.quality_rating}, messaging_limit_tier=${snapshot.messaging_limit_tier},
      name_status=${snapshot.name_status}, code_verification_status=${snapshot.code_verification_status},
      health_checked_at=${now}, health_error=NULL, health_error_at=NULL
    WHERE account_id=${accountId}::uuid AND id=${configId}::uuid`;
  let notified = 0;
  if (changes.length) {
    const admins = await tx.$queryRaw<{ user_id: string }[]>`
      SELECT user_id FROM account_memberships WHERE account_id=${accountId}::uuid AND role IN ('owner','admin') ORDER BY user_id`;
    const label = previous.display_name?.trim() || fetched.display_phone_number || 'Your WhatsApp number';
    for (const change of changes) {
      const { title, body } = describeChange(change, label);
      const dedupeKey = notificationDedupeKey(configId, change, previous.health_checked_at);
      // Each admin's number_quality preference decides in-app and email digest.
      const result = await createNotification(tx, {
        accountId, userIds: admins.map(({ user_id }) => user_id), event: 'number_quality',
        title, body, link: '/settings?tab=whatsapp', dedupeKey, whatsappConfigId: configId,
      });
      notified += result.inApp.length;
    }
  }
  return { status: 'synced', snapshot, changes, notified };
}

/**
 * Refresh one number's health. Never throws for a Meta failure (that is
 * recorded on the row and returned); database errors do throw, so the job
 * retries them.
 */
export async function syncNumberHealth(options: SyncOptions): Promise<HealthSyncResult> {
  const { accountId, configId } = options;
  if (!UUID.test(accountId) || !UUID.test(configId)) return { status: 'not_found' };
  const tenant = options.tenant ?? { accountId, role: 'owner' as const };
  if (tenant.accountId !== accountId) throw new Error('Health sync tenant mismatch');
  const db = options.db ?? getWorkerPrisma();
  const fetchHealth = options.fetchHealth ?? fetchNumberHealth;

  const config = await withTenant(tenant, async (tx) => (await tx.$queryRaw<
    { phone_number_id: string; access_token: string; status: string }[]
  >`SELECT phone_number_id, access_token, status FROM whatsapp_config
    WHERE account_id=${accountId}::uuid AND id=${configId}::uuid`)[0], db);
  if (!config) return { status: 'not_found' };
  if (config.status !== 'connected' || !config.phone_number_id || !config.access_token) return { status: 'disconnected' };

  let fetched: FetchedHealth;
  try {
    fetched = await fetchHealth({ phoneNumberId: config.phone_number_id, accessToken: decrypt(config.access_token) });
  } catch (error) {
    const category = categorizeHealthError(error);
    await withTenant(tenant, (tx) => tx.$executeRaw`
      UPDATE whatsapp_config SET health_error=${category}, health_error_at=${options.now ?? new Date()}
      WHERE account_id=${accountId}::uuid AND id=${configId}::uuid`, db);
    console.warn('[health-sync] number health unavailable', { configId, category });
    return { status: 'error', error: category };
  }
  const result = await withTenant(
    tenant,
    (tx) => applyHealthSnapshot(tx, { accountId, configId, fetched, now: options.now ?? new Date() }),
    db
  );
  return result ?? { status: 'not_found' };
}

/** One job per number per six-hour window; the key makes repeats no-ops. */
export function healthSyncDedupeKey(configId: string, now: number): string {
  return `whatsapp-health:${configId}:${Math.floor(now / HEALTH_SYNC_INTERVAL_MS)}`;
}

let lastScheduleCheck = Number.NEGATIVE_INFINITY;

/**
 * Queue a health sync for every connected number that has none in the current
 * window. Called from the worker's scheduling loop; looks for numbers at most
 * every ten minutes, and the dedupe key keeps several workers from doubling up.
 * Returns how many numbers were offered to the queue.
 */
export async function scheduleHealthSync(now: number = Date.now(), force = false): Promise<number> {
  if (!force && now - lastScheduleCheck < HEALTH_SCHEDULE_CHECK_MS) return 0;
  const numbers = await getWorkerPrisma().$queryRaw<{ account_id: string; whatsapp_config_id: string }[]>`
    SELECT * FROM crm_whatsapp_numbers_for_health_sync()`;
  for (const { account_id, whatsapp_config_id } of numbers)
    await enqueueJob(
      HEALTH_SYNC_JOB,
      { configId: whatsapp_config_id },
      { tenantId: account_id, dedupeKey: healthSyncDedupeKey(whatsapp_config_id, now), maxAttempts: 3 }
    );
  lastScheduleCheck = now;
  return numbers.length;
}

/** Test hook: forget when the scheduler last looked. */
export function resetHealthScheduleForTests(): void {
  lastScheduleCheck = Number.NEGATIVE_INFINITY;
}
