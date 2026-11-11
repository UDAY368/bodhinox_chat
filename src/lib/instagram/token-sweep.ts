// Daily Instagram token refresh and health sweep (Phase 11, design section 1
// "Tokens" and section 4). Owner: T2.
//
// scheduleInstagramSweeps runs on every worker tick (handlers.ts scheduleWork)
// and acts at most once an hour per process. It queues one instagram.token_sweep
// job per workspace listed by crm_instagram_accounts_for_sweep() (a live
// Instagram account only), deduped per workspace per UTC day, so an unconnected
// workspace never gets an Instagram call. runTokenSweep refreshes tokens at
// least 24 h old that expire within 10 days, then checks every live account's
// health. One account's failure is logged by name only and left for tomorrow.
// Nothing runs while Instagram is off.
import { getWorkerPrisma } from '@/lib/db/prisma';
import { instagramConfig } from './config';
import { asWorker, errorCodeOf, readToken, type InstagramAccountStatus } from './connection';
import { checkHealth, recordHealthTx } from './health';
import { INSTAGRAM_TOKEN_SWEEP_JOB } from './jobs';
import { isMetaTokenInvalid, refreshToken } from './graph';
import { encrypt } from '@/lib/whatsapp/encryption';

const SCHEDULE_INTERVAL_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
/** Meta refreshes only tokens at least 24 h old. */
const REFRESH_MIN_AGE_MS = DAY_MS;
/** Refresh once expiry is this close. */
const REFRESH_WITHIN_MS = 10 * DAY_MS;
const DEFAULT_TOKEN_SECONDS = 60 * 24 * 60 * 60;

let lastSchedule = Number.NEGATIVE_INFINITY;
let missingFunctionLogged = false;

/** Queues the daily sweep; returns how many workspaces were queued (0 while off). */
export async function scheduleInstagramSweeps(now: number = Date.now(), force = false): Promise<number> {
  if (!instagramConfig()) return 0;
  if (!force && now - lastSchedule < SCHEDULE_INTERVAL_MS) return 0;
  lastSchedule = now;
  let accounts: { account_id: string }[];
  try {
    accounts = await getWorkerPrisma().$queryRaw<{ account_id: string }[]>`
      SELECT account_id::text AS account_id FROM crm_instagram_accounts_for_sweep()`;
  } catch (error) {
    if (/crm_instagram_accounts_for_sweep|42883/.test(error instanceof Error ? error.message : '')) {
      if (!missingFunctionLogged) console.error('[instagram] sweep function missing');
      missingFunctionLogged = true;
      return 0;
    }
    throw error;
  }
  const day = Math.floor(now / DAY_MS);
  for (const { account_id } of accounts) {
    await getWorkerPrisma().$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,max_attempts)
      VALUES(${INSTAGRAM_TOKEN_SWEEP_JOB},${account_id}::uuid,'{}'::jsonb,${`igsweep:${account_id}:${day}`},2)
      ON CONFLICT(dedupe_key) DO NOTHING`;
  }
  return accounts.length;
}

/** Test hook. */
export function resetInstagramScheduleForTests(): void {
  lastSchedule = Number.NEGATIVE_INFINITY;
}

interface SweepRow {
  id: string;
  status: InstagramAccountStatus;
  access_token_enc: string | null;
  token_refreshed_at: Date | null;
  token_expires_at: Date | null;
  connection_kind: string | null;
}

export interface TokenSweepSummary { refreshed: number; checked: number; failures: number }

/** Refreshes one token when it is due; the new token is stored only if the row still holds the old one. */
async function refreshIfDue(accountId: string, row: SweepRow, now: number): Promise<'refreshed' | 'skipped' | 'invalid'> {
  const refreshedAt = row.token_refreshed_at?.getTime() ?? 0;
  const expiresAt = row.token_expires_at?.getTime() ?? 0;
  // A Facebook Page token is not refreshed through Instagram Login (and does not expire): health only.
  if (row.connection_kind === 'facebook_page') return 'skipped';
  if (!row.access_token_enc || now - refreshedAt < REFRESH_MIN_AGE_MS || expiresAt - now > REFRESH_WITHIN_MS) return 'skipped';
  const oldEnc = row.access_token_enc;
  const token = readToken(row);
  if (!token) {
    await asWorker(accountId, (tx) => recordHealthTx(tx, accountId, row.id, oldEnc, 'token_invalid', null));
    return 'invalid';
  }
  try {
    const fresh = await refreshToken(token);
    const expires = new Date(now + (fresh.expiresInSeconds ?? DEFAULT_TOKEN_SECONDS) * 1000);
    await asWorker(accountId, (tx) => tx.$executeRaw`UPDATE instagram_accounts SET access_token_enc=${encrypt(fresh.accessToken)},
        token_expires_at=${expires}, token_refreshed_at=now(), last_error_code=NULL
      WHERE account_id=${accountId}::uuid AND id=${row.id}::uuid AND access_token_enc=${oldEnc} AND status<>'disconnected'`);
    return 'refreshed';
  } catch (error) {
    if (!isMetaTokenInvalid(error)) throw error;
    await asWorker(accountId, (tx) => recordHealthTx(tx, accountId, row.id, oldEnc, 'token_invalid', errorCodeOf(error)));
    return 'invalid';
  }
}

/** The instagram.token_sweep job (handlers.ts via jobs.ts). */
export async function runTokenSweep(accountId: string): Promise<void> {
  await sweepInstagramTokens(accountId);
}

export async function sweepInstagramTokens(accountId: string, now: number = Date.now()): Promise<TokenSweepSummary> {
  const summary: TokenSweepSummary = { refreshed: 0, checked: 0, failures: 0 };
  if (!instagramConfig()) return summary;
  const rows = await asWorker(accountId, (tx) => tx.$queryRaw<SweepRow[]>`
    SELECT id::text AS id, status, access_token_enc, token_refreshed_at, token_expires_at, connection_kind FROM instagram_accounts
    WHERE account_id=${accountId}::uuid AND status IN ('active','permission_missing')
    ORDER BY id LIMIT 50`);
  for (const row of rows) {
    try {
      const refreshed = await refreshIfDue(accountId, row, now);
      if (refreshed === 'refreshed') summary.refreshed++;
      if (refreshed === 'invalid') continue;
      await checkHealth(accountId, row.id);
      summary.checked++;
    } catch (error) {
      summary.failures++;
      console.error('[instagram] token sweep failed for one account', error instanceof Error ? error.name : 'unknown');
    }
  }
  return summary;
}
