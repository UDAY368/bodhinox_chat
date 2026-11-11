// Instagram account health (Phase 11, design section 4). Owner: T2.
//
// GET /me with the account's token: 190 or HTTP 401 (or a token that now
// belongs to a different Instagram account) -> token_invalid; a scope gap in
// the stored grant -> permission_missing; otherwise active. Throttling and
// server errors leave the status as it is and record Meta's code only. A status
// change notifies the workspace's owners and admins once
// (instagram_account_health). Writes are compare-and-set on the token that was
// checked, so a reconnect that lands meanwhile is never marked invalid. No
// Instagram call while Instagram is off; never one inside a transaction.
import type { TenantTransaction } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { instagramConfig, missingScopes } from './config';
import { asWorker, errorCodeOf, loadAccountSecretTx, readToken, type InstagramAccountStatus } from './connection';
import { InstagramError } from './errors';
import { getMe, isMetaThrottle, isMetaTokenInvalid } from './graph';
import { probePageLink } from './page-login';

export type { InstagramAccountStatus } from './connection';

/** Where a health alert sends admins (the Settings section mounting the Instagram card). */
const SETTINGS_LINK = '/settings?tab=instagram';

/** Notifies owners and admins of a status change (one per recipient per change). */
export async function notifyHealthChangeTx(tx: TenantTransaction, accountId: string, instagramAccountId: string,
  status: InstagramAccountStatus, username: string | null): Promise<void> {
  if (status === 'disconnected') return;
  const t = getT('Settings.instagram.notifications');
  const name = username ? `@${username}` : 'Instagram';
  const title = t(`${status}Title`, { name }).slice(0, 200);
  const body = t(`${status}Body`, { name }).slice(0, 1000);
  const [stamp] = await tx.$queryRaw<{ epoch: string }[]>`SELECT floor(extract(epoch FROM clock_timestamp()))::bigint::text AS epoch`;
  const dedupeKey = `ig-health:${instagramAccountId}:${status}:${stamp?.epoch ?? '0'}`;
  await tx.$executeRaw`INSERT INTO notifications(account_id,user_id,type,instagram_account_id,title,body,link,dedupe_key)
    SELECT ${accountId}::uuid, m.user_id, 'instagram_account_health', ${instagramAccountId}::uuid, ${title}, ${body},
      ${SETTINGS_LINK}, ${dedupeKey}
    FROM account_memberships m WHERE m.account_id=${accountId}::uuid AND m.role IN ('owner','admin')
    ON CONFLICT DO NOTHING`;
}

/**
 * Sets a new status when the row still holds the checked token; notifies on a
 * change. Returns the status now stored.
 */
export async function recordHealthTx(tx: TenantTransaction, accountId: string, instagramAccountId: string,
  checkedTokenEnc: string, next: InstagramAccountStatus, errorCode: string | null): Promise<InstagramAccountStatus> {
  const [row] = await tx.$queryRaw<{ status: InstagramAccountStatus; access_token_enc: string | null; username: string | null }[]>`
    SELECT status, access_token_enc, username FROM instagram_accounts
    WHERE account_id=${accountId}::uuid AND id=${instagramAccountId}::uuid FOR UPDATE`;
  if (!row) throw new InstagramError('not_found');
  // Disconnected or reconnected meanwhile: what was checked is no longer this row's token.
  if (row.status === 'disconnected' || row.access_token_enc !== checkedTokenEnc) return row.status;
  await tx.$executeRaw`UPDATE instagram_accounts SET status=${next}, last_error_code=${errorCode}
    WHERE account_id=${accountId}::uuid AND id=${instagramAccountId}::uuid`;
  if (row.status !== next) await notifyHealthChangeTx(tx, accountId, instagramAccountId, next, row.username);
  return next;
}

/** Checks one account now (daily sweep and "Check now"). */
export async function checkHealth(accountId: string, instagramAccountId: string): Promise<InstagramAccountStatus> {
  if (!instagramConfig()) throw new InstagramError('instagram_not_enabled');
  const row = await asWorker(accountId, async (tx) => {
    const secret = await loadAccountSecretTx(tx, accountId, instagramAccountId);
    if (!secret) return null;
    const [extra] = await tx.$queryRaw<{ scopes: string[] }[]>`SELECT scopes FROM instagram_accounts
      WHERE account_id=${accountId}::uuid AND id=${instagramAccountId}::uuid`;
    return { ...secret, scopes: extra?.scopes ?? [] };
  });
  if (!row) throw new InstagramError('not_found');
  if (row.status === 'disconnected' || !row.access_token_enc) return 'disconnected';
  const tokenEnc = row.access_token_enc;
  const token = readToken(row);
  if (!token) return asWorker(accountId, (tx) => recordHealthTx(tx, accountId, instagramAccountId, tokenEnc, 'token_invalid', null));

  let next: InstagramAccountStatus;
  let errorCode: string | null = null;
  try {
    // A Facebook Page connection (Stage 4) is probed through its Page: Instagram Login's /me does not apply to a Page token.
    const linkedId = row.connection_kind === 'facebook_page' && row.facebook_page_id
      ? await probePageLink(row.facebook_page_id, token)
      : (await getMe(token)).userId;
    next = linkedId !== row.ig_user_id ? 'token_invalid'
      : missingScopes(row.scopes, 'dm').length ? 'permission_missing' : 'active';
  } catch (error) {
    if (!isMetaTokenInvalid(error)) {
      // Throttled or Meta unavailable: keep the status, remember the code, try again later.
      await asWorker(accountId, (tx) => tx.$executeRaw`UPDATE instagram_accounts SET last_error_code=${errorCodeOf(error)}
        WHERE account_id=${accountId}::uuid AND id=${instagramAccountId}::uuid AND access_token_enc=${tokenEnc}`);
      throw new InstagramError(isMetaThrottle(error) ? 'rate_limited' : 'meta_error');
    }
    next = 'token_invalid';
    errorCode = errorCodeOf(error);
  }
  return asWorker(accountId, (tx) => recordHealthTx(tx, accountId, instagramAccountId, tokenEnc, next, errorCode));
}
