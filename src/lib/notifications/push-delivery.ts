/**
 * Browser push for notifications (notification_push_queue).
 *
 * createNotification writes a queue entry beside the in-app row when the
 * member turned push on for that event. The worker's scheduling loop queues
 * one inbox.notification_push job per workspace with unsent entries (at most
 * every 30 seconds). The job claims the entries (sets sent_at) and commits
 * before any push goes out, so a crash or retry never wakes a device twice for
 * one entry; a push that then fails is recorded as 'failed', not resent.
 *
 * Per member, all claimed entries become one payload-free wake-up per device:
 *   - quiet hours (member_preferences, the member's own time zone) hold it
 *     back, except a mention when the member lets mentions through ('quiet');
 *   - entries already read in the app, switched off since, older than an hour,
 *     or for a member with no device are skipped ('skipped');
 *   - a device the push service says is gone (404/410) is deleted.
 * Nothing is scheduled while VAPID keys are not configured. Endpoints are
 * never logged.
 */
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { enqueueJob } from '@/lib/jobs/queue';
import { isQuietFor, type QuietHours } from './quiet-hours';
import { sendWebPush, vapidConfig, webPushAvailable, type PushFetch, type PushOutcome } from './web-push';

export const NOTIFICATION_PUSH_JOB = 'inbox.notification_push';
export const PUSH_SCHEDULE_CHECK_MS = 30 * 1000;
export const PUSH_MAX_AGE_MS = 60 * 60 * 1000;
export const PUSH_CLAIM_LIMIT = 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PushEntry {
  id: string;
  user_id: string;
  event: string;
  created_at: Date;
  read: boolean;
  wants_push: boolean;
  quiet_enabled: boolean | null;
  quiet_start: number | null;
  quiet_end: number | null;
  quiet_time_zone: string | null;
  quiet_allow_mentions: boolean | null;
}

export interface PushPlan {
  /** Members to wake, each with the entries that wake-up covers. */
  send: { userId: string; entryIds: string[] }[];
  quiet: string[];
  skipped: string[];
}

function quietOf(entry: PushEntry): QuietHours | null {
  if (!entry.quiet_enabled || entry.quiet_start === null || entry.quiet_end === null) return null;
  return {
    enabled: true,
    start: Number(entry.quiet_start),
    end: Number(entry.quiet_end),
    time_zone: entry.quiet_time_zone ?? 'UTC',
    allow_mentions: entry.quiet_allow_mentions ?? true,
  };
}

/** Decide what happens to each claimed entry (pure). */
export function planPushes(entries: PushEntry[], now: Date): PushPlan {
  const plan: PushPlan = { send: [], quiet: [], skipped: [] };
  const byUser = new Map<string, string[]>();
  for (const entry of entries) {
    if (entry.read || !entry.wants_push || now.getTime() - new Date(entry.created_at).getTime() > PUSH_MAX_AGE_MS) {
      plan.skipped.push(entry.id);
    } else if (isQuietFor(quietOf(entry), entry.event, now)) {
      plan.quiet.push(entry.id);
    } else {
      byUser.set(entry.user_id, [...(byUser.get(entry.user_id) ?? []), entry.id]);
    }
  }
  for (const [userId, entryIds] of byUser) plan.send.push({ userId, entryIds });
  return plan;
}

export interface PushResult {
  status: 'unconfigured' | 'done';
  claimed: number;
  sent: number;
}

async function mark(accountId: string, ids: string[], outcome: 'sent' | 'quiet' | 'skipped' | 'failed'): Promise<void> {
  if (!ids.length) return;
  await withTenant({ accountId, role: 'owner' }, (tx) => tx.$executeRaw`
    UPDATE notification_push_queue SET outcome=${outcome}
    WHERE account_id=${accountId}::uuid AND id = ANY(${ids}::uuid[])`, getWorkerPrisma());
}

/** Send one workspace's pending pushes. */
export async function sendNotificationPushes(
  accountId: string,
  options: { fetch?: PushFetch; now?: Date } = {},
): Promise<PushResult> {
  if (!UUID.test(accountId)) throw new Error('Invalid push account');
  const config = vapidConfig();
  if (!config) return { status: 'unconfigured', claimed: 0, sent: 0 };
  const now = options.now ?? new Date();
  const tenant = { accountId, role: 'owner' as const };

  const entries = await withTenant(tenant, async (tx) => {
    const rows = await tx.$queryRaw<PushEntry[]>`
      SELECT q.id::text AS id, q.user_id::text AS user_id, q.event, q.created_at,
        (n.read_at IS NOT NULL) AS read, COALESCE(p.push, false) AS wants_push,
        mp.quiet_enabled, mp.quiet_start, mp.quiet_end, mp.quiet_time_zone, mp.quiet_allow_mentions
      FROM notification_push_queue q
      LEFT JOIN notifications n ON n.account_id=q.account_id AND n.id=q.notification_id
      LEFT JOIN notification_preferences p ON p.account_id=q.account_id AND p.user_id=q.user_id AND p.event=q.event
      LEFT JOIN member_preferences mp ON mp.account_id=q.account_id AND mp.user_id=q.user_id
      WHERE q.account_id=${accountId}::uuid AND q.sent_at IS NULL
      ORDER BY q.created_at, q.id
      LIMIT ${PUSH_CLAIM_LIMIT}
      FOR UPDATE OF q SKIP LOCKED`;
    if (rows.length)
      await tx.$executeRaw`UPDATE notification_push_queue SET sent_at=${now}
        WHERE account_id=${accountId}::uuid AND id = ANY(${rows.map((row) => row.id)}::uuid[]) AND sent_at IS NULL`;
    return rows;
  }, getWorkerPrisma());
  if (!entries.length) return { status: 'done', claimed: 0, sent: 0 };

  const plan = planPushes(entries, now);
  await mark(accountId, plan.quiet, 'quiet');
  await mark(accountId, plan.skipped, 'skipped');

  let sent = 0;
  for (const { userId, entryIds } of plan.send) {
    const devices = await withTenant(tenant, (tx) => tx.$queryRaw<{ id: string; endpoint: string }[]>`
      SELECT id::text AS id, endpoint FROM push_subscriptions
      WHERE account_id=${accountId}::uuid AND user_id=${userId}::uuid ORDER BY created_at LIMIT 20`, getWorkerPrisma());
    if (!devices.length) {
      await mark(accountId, entryIds, 'skipped');
      continue;
    }
    const outcomes: PushOutcome[] = [];
    for (const device of devices) {
      const outcome = await sendWebPush(device, { config, fetch: options.fetch, now });
      outcomes.push(outcome);
      if (outcome === 'gone')
        await withTenant(tenant, (tx) => tx.$executeRaw`DELETE FROM push_subscriptions
          WHERE account_id=${accountId}::uuid AND id=${device.id}::uuid`, getWorkerPrisma());
      else if (outcome === 'sent')
        await withTenant(tenant, (tx) => tx.$executeRaw`UPDATE push_subscriptions SET last_sent_at=${now}
          WHERE account_id=${accountId}::uuid AND id=${device.id}::uuid`, getWorkerPrisma());
    }
    const delivered = outcomes.includes('sent');
    if (delivered) sent++;
    else console.error('[notifications] push not delivered', { userId, devices: devices.length });
    await mark(accountId, entryIds, delivered ? 'sent' : 'failed');
  }
  return { status: 'done', claimed: entries.length, sent };
}

/** One push job per workspace per 30-second window; repeats are no-ops. */
export function pushDedupeKey(accountId: string, now: number): string {
  return `notification-push:${accountId}:${Math.floor(now / PUSH_SCHEDULE_CHECK_MS)}`;
}

let lastPushCheck = Number.NEGATIVE_INFINITY;

/** Queue a push job for each workspace with unsent entries; nothing while VAPID is not configured. */
export async function scheduleNotificationPushes(now: number = Date.now(), force = false): Promise<number> {
  if (!webPushAvailable()) return 0;
  if (!force && now - lastPushCheck < PUSH_SCHEDULE_CHECK_MS) return 0;
  const accounts = await getWorkerPrisma().$queryRaw<{ account_id: string }[]>`
    SELECT * FROM crm_accounts_with_pending_notification_push()`;
  for (const { account_id } of accounts)
    await enqueueJob(NOTIFICATION_PUSH_JOB, {}, {
      tenantId: account_id,
      dedupeKey: pushDedupeKey(account_id, now),
      maxAttempts: 3,
    });
  lastPushCheck = now;
  return accounts.length;
}

/** Test hook: forget when the scheduler last looked. */
export function resetPushScheduleForTests(): void {
  lastPushCheck = Number.NEGATIVE_INFINITY;
}

/** A test push to the member's own devices (Settings › Notifications › Send a test). */
export async function sendTestPush(
  context: { accountId: string; userId: string; role?: 'owner' | 'admin' | 'agent' | 'viewer' },
  options: { fetch?: PushFetch } = {},
): Promise<{ devices: number; sent: number }> {
  const config = vapidConfig();
  if (!config) return { devices: 0, sent: 0 };
  const devices = await withTenant(context, (tx) => tx.$queryRaw<{ id: string; endpoint: string }[]>`
    SELECT id::text AS id, endpoint FROM push_subscriptions
    WHERE account_id=${context.accountId}::uuid AND user_id=${context.userId}::uuid ORDER BY created_at LIMIT 20`);
  let sent = 0;
  for (const device of devices) {
    const outcome = await sendWebPush(device, { config, fetch: options.fetch, urgency: 'high' });
    if (outcome === 'sent') sent++;
    if (outcome === 'gone')
      await withTenant(context, (tx) => tx.$executeRaw`DELETE FROM push_subscriptions
        WHERE account_id=${context.accountId}::uuid AND user_id=${context.userId}::uuid AND id=${device.id}::uuid`);
  }
  return { devices: devices.length, sent };
}
