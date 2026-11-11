// Webhook resubscribe for accounts connected before Stage 3 (Instagram Phase 2).
//
// Stage 3 adds the live_comments field. An account connected earlier is
// subscribed to messages, messaging_postbacks and (with the comments scope)
// comments only, and Meta replaces the whole list on every subscribe, so each
// such account is subscribed again with webhookFieldsFor(scopes). New
// connections already subscribe to the full list (connection.ts).
//
// scheduleInstagramResubscribe runs on every worker tick (handlers.ts) and acts
// at most once an hour per process. It queues one instagram.resubscribe job per
// workspace listed by crm_instagram_accounts_for_sweep() (a live Instagram
// account only), deduped forever per field-set version (RESUBSCRIBE_VERSION:
// raise it when the list of fields changes again), so a workspace is resubscribed
// once and an unconnected workspace never gets an Instagram call.
// runResubscribe handles each active account that holds the comments scope; a
// token Meta rejects goes through the health path, a throttle retries the job,
// and one account's other failure is logged by code only and does not stop the
// others. Nothing runs while Instagram is off. No token, id or Meta text is logged.
import { getWorkerPrisma } from '@/lib/db/prisma';
import { instagramConfig } from './config';
import { asWorker, errorCodeOf, readToken, webhookFieldsFor } from './connection';
import { recordHealthTx } from './health';
import { INSTAGRAM_RESUBSCRIBE_JOB } from './jobs';
import { isMetaThrottle, isMetaTokenInvalid, subscribe } from './graph';
import { MetaApiError } from '@/lib/whatsapp/meta-api';

/** Bump when the webhook field list changes again, to queue every workspace once more. */
export const RESUBSCRIBE_VERSION = 'v1';
const SCHEDULE_INTERVAL_MS = 60 * 60_000;

let lastSchedule = Number.NEGATIVE_INFINITY;

/** Queues one resubscribe job per workspace with a live account; returns how many were offered (0 while off). */
export async function scheduleInstagramResubscribe(now: number = Date.now(), force = false): Promise<number> {
  if (!instagramConfig()) return 0;
  if (!force && now - lastSchedule < SCHEDULE_INTERVAL_MS) return 0;
  lastSchedule = now;
  let accounts: { account_id: string }[];
  try {
    accounts = await getWorkerPrisma().$queryRaw<{ account_id: string }[]>`
      SELECT account_id::text AS account_id FROM crm_instagram_accounts_for_sweep()`;
  } catch (error) {
    if (/crm_instagram_accounts_for_sweep|42883/.test(error instanceof Error ? error.message : '')) return 0;
    throw error;
  }
  for (const { account_id } of accounts) {
    await getWorkerPrisma().$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,max_attempts)
      VALUES(${INSTAGRAM_RESUBSCRIBE_JOB},${account_id}::uuid,'{}'::jsonb,${`igresub:${RESUBSCRIBE_VERSION}:${account_id}`},4)
      ON CONFLICT(dedupe_key) DO NOTHING`;
  }
  return accounts.length;
}

/** Test hook. */
export function resetInstagramResubscribeForTests(): void {
  lastSchedule = Number.NEGATIVE_INFINITY;
}

interface Row { id: string; access_token_enc: string | null; scopes: string[] | null }

export interface ResubscribeSummary { subscribed: number; skipped: number; failures: number }

/** The instagram.resubscribe job (jobs.ts): one workspace's active accounts. */
export async function runResubscribe(accountId: string): Promise<ResubscribeSummary> {
  const summary: ResubscribeSummary = { subscribed: 0, skipped: 0, failures: 0 };
  if (!instagramConfig()) return summary;
  const rows = await asWorker(accountId, (tx) => tx.$queryRaw<(Row & { ig_user_id: string })[]>`
    SELECT id::text AS id, ig_user_id, access_token_enc, scopes FROM instagram_accounts
    WHERE account_id=${accountId}::uuid AND status='active' AND connection_kind='instagram_login' ORDER BY id LIMIT 50`);
  let throttled = false;
  for (const row of rows) {
    const fields = webhookFieldsFor(row.scopes ?? []);
    const token = readToken(row);
    // Without the comments scope the field list has not changed; without a readable token nothing can be sent.
    if (!token || !fields.includes('live_comments')) {
      summary.skipped++;
      continue;
    }
    const oldEnc = row.access_token_enc!;
    try {
      await subscribe(row.ig_user_id, token, fields);
      summary.subscribed++;
    } catch (error) {
      if (isMetaTokenInvalid(error)) {
        await asWorker(accountId, (tx) => recordHealthTx(tx, accountId, row.id, oldEnc, 'token_invalid', errorCodeOf(error)));
        summary.failures++;
      } else if (isMetaThrottle(error)) {
        throttled = true;
        summary.failures++;
      } else {
        summary.failures++;
        console.error('[instagram] resubscribe failed for one account',
          error instanceof MetaApiError ? error.httpStatus : error instanceof Error ? error.name : 'unknown');
      }
    }
  }
  // A throttle is the one failure worth another attempt: the job retries and the rest are idempotent.
  if (throttled) throw new Error('Instagram resubscribe throttled');
  return summary;
}
