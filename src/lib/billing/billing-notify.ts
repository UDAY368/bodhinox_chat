// Billing notices to a workspace's owners and admins: an in-app notification
// (type 'billing'), written in the transaction that changes the subscription,
// and an email queued as a job in that same transaction. The email is sent
// once through an outbound intent, so a lost SMTP answer is never re-sent.
//
// Notices carry the plan and dates only, never customer content, payment
// details or provider ids. Addresses and provider errors are never logged.

import { randomUUID } from 'node:crypto';
import { authEmailTransport } from '@/lib/auth/email';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { dispatchOnce, UncertainDispatchError } from '@/lib/jobs/dispatch';
import { getT } from '@/lib/i18n/translate';
import type { BillingNotice } from './lifecycle';

export const BILLING_EMAIL_JOB = 'billing.email';
export const BILLING_LINK = '/settings?tab=plan';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADDRESS = /^[^\s@<>",;]{1,64}@[^\s@<>",;]{1,255}$/;
const DEDUPE = /^[A-Za-z0-9_.:-]{1,150}$/;

export interface NoticeValues {
  plan?: string;
  /** ISO date shown to the reader (grace end, period end). */
  date?: string | null;
  number?: string;
}

const dateText = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }) : '';

/** Title and body for a notice, in the app's locale. */
export function noticeText(notice: BillingNotice, values: NoticeValues): { title: string; body: string } {
  const t = getT('Billing.notices');
  const v = { plan: values.plan ?? '', date: dateText(values.date), number: values.number ?? '' };
  return { title: t(`${notice}.title`, v), body: t(`${notice}.body`, v) };
}

/**
 * Records a notice inside the caller's worker-role tenant transaction. A
 * repeated dedupe key changes nothing (per member, and for the email job).
 */
export async function recordBillingNotice(tx: TenantTransaction, accountId: string, notice: BillingNotice, dedupeKey: string, values: NoticeValues = {}): Promise<void> {
  if (!UUID.test(accountId) || !DEDUPE.test(dedupeKey)) throw new Error('Invalid billing notice');
  const { title, body } = noticeText(notice, values);
  const admins = await tx.$queryRaw<{ user_id: string }[]>`
    SELECT user_id::text AS user_id FROM account_memberships WHERE account_id=${accountId}::uuid AND role IN ('owner','admin') LIMIT 200`;
  const key = `billing:${dedupeKey}`;
  for (const { user_id } of admins)
    await tx.$executeRaw`
      INSERT INTO notifications(id,account_id,user_id,type,title,body,link,dedupe_key)
      VALUES(${randomUUID()}::uuid,${accountId}::uuid,${user_id}::uuid,'billing',${title.slice(0, 200)},${body.slice(0, 1000)},${BILLING_LINK},${key})
      ON CONFLICT DO NOTHING`;
  await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key)
    VALUES(${BILLING_EMAIL_JOB},${accountId}::uuid,${JSON.stringify({ notice, dedupeKey, values })}::jsonb,${`billing-email:${accountId}:${dedupeKey}`})
    ON CONFLICT(dedupe_key) DO NOTHING`;
}

/** Recipients: the billing profile's address, else every owner/admin with a profile address. */
async function recipients(accountId: string): Promise<string[]> {
  return withTenant({ accountId, role: 'owner' }, async (tx) => {
    const profile = await tx.$queryRaw<{ email: string }[]>`SELECT email FROM billing_profiles WHERE account_id=${accountId}::uuid`;
    if (profile[0]?.email && ADDRESS.test(profile[0].email)) return [profile[0].email];
    const admins = await tx.$queryRaw<{ email: string | null }[]>`
      SELECT pr.email FROM account_memberships m JOIN profiles pr ON pr.user_id=m.user_id
      WHERE m.account_id=${accountId}::uuid AND m.role IN ('owner','admin') LIMIT 20`;
    return [...new Set(admins.map((a) => a.email?.trim() ?? '').filter((e) => ADDRESS.test(e)))];
  }, getWorkerPrisma());
}

/** The billing.email job. Skipped (not failed) while SMTP or APP_URL is not configured. */
export async function sendBillingEmail(accountId: string, payload: Record<string, unknown>): Promise<void> {
  const notice = payload.notice as BillingNotice;
  const dedupeKey = typeof payload.dedupeKey === 'string' && DEDUPE.test(payload.dedupeKey) ? payload.dedupeKey : null;
  if (!dedupeKey) throw new Error('Invalid billing email job');
  const from = process.env.AUTH_EMAIL_FROM;
  const origin = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (!process.env.SMTP_URL || !from || !origin) return;
  const to = await recipients(accountId);
  if (!to.length) return;
  const values = (payload.values ?? {}) as NoticeValues;
  const { title, body } = noticeText(notice, values);
  const text = `${body}\n\n${new URL(BILLING_LINK, origin).toString()}\n`;
  try {
    await dispatchOnce(accountId, `billing-email:${dedupeKey}`, async () => {
      const transport = authEmailTransport();
      try {
        await transport.sendMail({ from, to, subject: title, text });
      } finally {
        transport.close();
      }
      return { sent: true };
    });
  } catch (error) {
    // Ambiguous or refused: the in-app notification stands; never re-send blindly.
    if (error instanceof UncertainDispatchError) return;
    console.error('[billing] notice email failed', { notice });
  }
}
