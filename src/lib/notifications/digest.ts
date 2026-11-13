/**
 * Email digest of notifications (notification_email_queue).
 *
 * The worker's scheduling loop queues one inbox.notification_digest job per
 * workspace with unsent entries per 30-minute window, so a member gets at most
 * one digest email per window. The job claims the workspace's unsent entries
 * (sets sent_at) and commits before any email goes out, so a crash or retry
 * never sends the same entries twice. A send that failed before the SMTP
 * server accepted anything (bad credentials, no connection) releases that
 * member's entries and fails the job, which retries them; any other failure
 * is ambiguous and the entries stay claimed.
 *
 * Each email lists titles and links only, never notification bodies or
 * customer message content. Entries already read in the app, entries for an
 * event the member has since switched off, and entries older than a week are
 * claimed without sending. A member inside their quiet hours keeps their
 * entries unclaimed until the window ends (a mention passes when they let
 * mentions through). Nothing is scheduled while SMTP or the app URL is
 * not configured. Addresses, titles and provider errors are never logged.
 */
import { authEmailTransport } from '@/lib/auth/email';
import { getT } from '@/lib/i18n/translate';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { maskPhonesInText } from '@/lib/inbox/masking';
import { enqueueJob } from '@/lib/jobs/queue';
import { emailDigestAvailable } from './preferences';
import { isQuietFor } from './quiet-hours';

export const NOTIFICATION_DIGEST_JOB = 'inbox.notification_digest';
export const DIGEST_INTERVAL_MS = 30 * 60 * 1000;
/** How often the scheduler looks for workspaces with pending entries. */
export const DIGEST_SCHEDULE_CHECK_MS = 5 * 60 * 1000;
export const DIGEST_MAX_ITEMS = 50;
export const DIGEST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Entries claimed per job; the rest go in the next window. */
export const DIGEST_CLAIM_LIMIT = 2000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADDRESS = /^[^\s@<>",;]{1,64}@[^\s@<>",;]{1,255}$/;
/** nodemailer codes raised before the server accepted the message: nothing was delivered. */
const NOT_DELIVERED = new Set(['EAUTH', 'ECONNECTION', 'EDNS', 'ETLS', 'EENVELOPE', 'ECONFIG', 'EOAUTH2']);

export interface DigestEntry {
  id: string;
  user_id: string;
  title: string;
  link: string | null;
  created_at: Date;
  /** The member's profile address; resolved at send time, never stored on the entry. */
  address: string | null;
  /** The linked in-app notification was already read. */
  read: boolean;
  /** The member's current email preference for the entry's event. */
  wants_email: boolean;
  /** The member's numbers are masked (mask_phone_numbers, or no membership any more). */
  mask_phones?: boolean;
}

export interface DigestEmail {
  userId: string;
  to: string;
  /** Every claimed entry this email covers. */
  entryIds: string[];
  subject: string;
  text: string;
}

export interface DigestMessage {
  to: string;
  subject: string;
  text: string;
}

interface QuietColumns {
  event?: string;
  quiet_enabled?: boolean | null;
  quiet_start?: number | null;
  quiet_end?: number | null;
  quiet_time_zone?: string | null;
  quiet_allow_mentions?: boolean | null;
}

/** Whether the member's quiet hours hold this entry back at `now` (pure). */
export function heldByQuietHours(row: QuietColumns, now: Date): boolean {
  if (!row.quiet_enabled || row.quiet_start == null || row.quiet_end == null) return false;
  return isQuietFor({
    enabled: true,
    start: Number(row.quiet_start),
    end: Number(row.quiet_end),
    time_zone: row.quiet_time_zone ?? 'UTC',
    allow_mentions: row.quiet_allow_mentions ?? true,
  }, row.event ?? '', now);
}

/** One line of plain text: no control characters, bounded. */
function line(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim().slice(0, max);
}

/**
 * Group claimed entries into one email per member (pure). Entries that should
 * not be sent are left out; members with nothing left get no email.
 */
export function buildDigestEmails(entries: DigestEntry[], options: { origin: string; now: Date }): DigestEmail[] {
  const origin = new URL(options.origin).origin;
  const byUser = new Map<string, DigestEntry[]>();
  for (const entry of entries) {
    if (entry.read || !entry.wants_email) continue;
    if (options.now.getTime() - new Date(entry.created_at).getTime() > DIGEST_MAX_AGE_MS) continue;
    const list = byUser.get(entry.user_id) ?? [];
    list.push(entry);
    byUser.set(entry.user_id, list);
  }
  const emails: DigestEmail[] = [];
  const t = getT('AuthEmails.digest');
  for (const [userId, list] of byUser) {
    const to = list[0].address?.trim() ?? '';
    if (!ADDRESS.test(to)) continue;
    list.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    const shown = list.slice(-DIGEST_MAX_ITEMS);
    const lines = shown.map((entry) => {
      const title = `- ${line(entry.mask_phones ? maskPhonesInText(entry.title) : entry.title, 200)}`;
      return entry.link ? `${title}\n  ${new URL(entry.link, origin).toString()}` : title;
    });
    const more = list.length - shown.length;
    const total = list.length;
    emails.push({
      userId,
      to,
      entryIds: list.map((entry) => entry.id),
      subject: t('subject', { count: total }),
      text: [
        t('intro', { count: total }),
        '',
        ...lines,
        ...(more > 0 ? ['', t('more', { count: more })] : []),
        '',
        t('seeAll', { link: new URL('/notifications', origin).toString() }),
        t('footer'),
      ].join('\n'),
    });
  }
  return emails;
}

/** A nodemailer error code that proves the message was not delivered. */
export function isUndelivered(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && NOT_DELIVERED.has(code);
}

export type DigestSender = (message: DigestMessage) => Promise<void>;

export interface DigestResult {
  status: 'unconfigured' | 'done';
  claimed: number;
  sent: number;
  deferred: number;
}

export class DigestDeferredError extends Error {
  constructor() {
    super('Notification digest delivery deferred');
    this.name = 'DigestDeferredError';
  }
}

/**
 * Send one workspace's pending digest emails. Throws DigestDeferredError when
 * some member's email could not be handed to SMTP, after releasing only those
 * entries, so the job retries them.
 */
export async function sendNotificationDigest(
  accountId: string,
  options: { send?: DigestSender; now?: Date } = {},
): Promise<DigestResult> {
  if (!UUID.test(accountId)) throw new Error('Invalid digest account');
  const origin = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (!emailDigestAvailable() || !origin) return { status: 'unconfigured', claimed: 0, sent: 0, deferred: 0 };
  const now = options.now ?? new Date();
  const tenant = { accountId, role: 'owner' as const };

  const entries = await withTenant(tenant, async (tx) => {
    const locked = await tx.$queryRaw<(DigestEntry & QuietColumns)[]>`
      SELECT q.id::text AS id, q.user_id::text AS user_id, q.event, q.title, q.link, q.created_at,
        pr.email AS address, (n.read_at IS NOT NULL) AS read, COALESCE(p.email, false) AS wants_email,
        COALESCE(m.role::text NOT IN ('owner','admin') AND m.mask_phone_numbers, true) AS mask_phones,
        mp.quiet_enabled, mp.quiet_start, mp.quiet_end, mp.quiet_time_zone, mp.quiet_allow_mentions
      FROM notification_email_queue q
      LEFT JOIN account_memberships m ON m.account_id=q.account_id AND m.user_id=q.user_id
      LEFT JOIN notifications n ON n.account_id=q.account_id AND n.id=q.notification_id
      LEFT JOIN notification_preferences p ON p.account_id=q.account_id AND p.user_id=q.user_id AND p.event=q.event
      LEFT JOIN member_preferences mp ON mp.account_id=q.account_id AND mp.user_id=q.user_id
      LEFT JOIN profiles pr ON pr.user_id=q.user_id
      WHERE q.account_id=${accountId}::uuid AND q.sent_at IS NULL
      ORDER BY q.created_at, q.id
      LIMIT ${DIGEST_CLAIM_LIMIT}
      FOR UPDATE OF q SKIP LOCKED`;
    // Quiet hours hold a member's entries back (unclaimed) until the window ends;
    // the next digest window after it sends them.
    const rows = locked.filter((row) => !heldByQuietHours(row, now));
    if (rows.length)
      await tx.$executeRaw`UPDATE notification_email_queue SET sent_at=${now}
        WHERE account_id=${accountId}::uuid AND id = ANY(${rows.map((row) => row.id)}::uuid[]) AND sent_at IS NULL`;
    return rows;
  }, getWorkerPrisma());
  if (!entries.length) return { status: 'done', claimed: 0, sent: 0, deferred: 0 };

  const emails = buildDigestEmails(entries, { origin, now });
  let send = options.send;
  let transport: ReturnType<typeof authEmailTransport> | null = null;
  if (!send) {
    const from = process.env.AUTH_EMAIL_FROM;
    send = async (message) => {
      transport ??= authEmailTransport();
      await transport.sendMail({ from, ...message });
    };
  }
  const released: string[] = [];
  let sent = 0;
  try {
    for (const email of emails) {
      try {
        await send({ to: email.to, subject: email.subject, text: email.text });
        sent++;
      } catch (error) {
        const undelivered = isUndelivered(error);
        console.error('[notifications] digest email failed', { userId: email.userId, retry: undelivered });
        if (undelivered) released.push(...email.entryIds);
      }
    }
  } finally {
    (transport as ReturnType<typeof authEmailTransport> | null)?.close();
  }
  if (released.length) {
    await withTenant(tenant, (tx) => tx.$executeRaw`UPDATE notification_email_queue SET sent_at=NULL
      WHERE account_id=${accountId}::uuid AND id = ANY(${released}::uuid[]) AND sent_at=${now}`, getWorkerPrisma());
    throw new DigestDeferredError();
  }
  return { status: 'done', claimed: entries.length, sent, deferred: 0 };
}

/** One digest job per workspace per 30-minute window; repeats are no-ops. */
export function digestDedupeKey(accountId: string, now: number): string {
  return `notification-digest:${accountId}:${Math.floor(now / DIGEST_INTERVAL_MS)}`;
}

let lastDigestCheck = Number.NEGATIVE_INFINITY;

/**
 * Queue a digest for each workspace with unsent entries. Called from the
 * worker's scheduling loop; looks at most every five minutes and does nothing
 * while email delivery is not configured. Returns how many were offered.
 */
export async function scheduleNotificationDigests(now: number = Date.now(), force = false): Promise<number> {
  if (!emailDigestAvailable()) return 0;
  if (!force && now - lastDigestCheck < DIGEST_SCHEDULE_CHECK_MS) return 0;
  const accounts = await getWorkerPrisma().$queryRaw<{ account_id: string }[]>`
    SELECT * FROM crm_accounts_with_pending_notification_email()`;
  for (const { account_id } of accounts)
    await enqueueJob(NOTIFICATION_DIGEST_JOB, {}, {
      tenantId: account_id,
      dedupeKey: digestDedupeKey(account_id, now),
      maxAttempts: 3,
    });
  lastDigestCheck = now;
  return accounts.length;
}

/** Test hook: forget when the scheduler last looked. */
export function resetDigestScheduleForTests(): void {
  lastDigestCheck = Number.NEGATIVE_INFINITY;
}
