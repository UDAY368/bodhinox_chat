// The flow builder's post picker (Stage 2, 2D): an Instagram account's recent
// posts for the comment trigger. Readable by anyone who may edit flows
// (agent and up), unlike the comment-rule picker (admin, comments permission):
// listing posts needs only the basic scope and writes nothing anywhere.
//
// The account is checked as the member first (withTenant + RLS), so another
// workspace's id is a 404 before the token is loaded; the token is read as the
// worker, used for one GET /{ig-user-id}/media and never returned or logged.
import { hasMinRole } from '@/lib/auth/roles';
import { requireFeature } from '@/lib/billing/entitlements';
import { withTenant } from '@/lib/db/tenant';
import { instagramConfig } from './config';
import { asWorker, loadAccountSecretTx, readToken, type InstagramActor } from './connection';
import { InstagramError } from './errors';
import { InstagramGraphInputError, isMetaThrottle, isMetaTokenInvalid, listMediaPage, type InstagramMediaPage } from './graph';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One page of the account's posts and reels, newest first, after the cursor
 * `after` from an earlier page. Refusals: instagram_not_enabled
 * while off; forbidden below agent; not_found for a malformed or another
 * workspace's id; instagram_account_disconnected; the plan's PlanLimitError.
 * Meta failures become fixed codes (instagram_token_invalid, rate_limited,
 * meta_error), never Meta's text; a malformed cursor is invalid_request.
 */
export async function listPickerMedia(actor: InstagramActor, instagramAccountId: string, after?: string): Promise<InstagramMediaPage> {
  if (!instagramConfig()) throw new InstagramError('instagram_not_enabled');
  if (!hasMinRole(actor.role, 'agent')) throw new InstagramError('forbidden');
  if (!UUID.test(instagramAccountId)) throw new InstagramError('not_found');
  await withTenant(actor, async (tx) => {
    await requireFeature(tx, actor.accountId, 'instagram');
    const [account] = await tx.$queryRaw<{ status: string }[]>`
      SELECT status FROM instagram_accounts WHERE account_id=${actor.accountId}::uuid AND id=${instagramAccountId}::uuid`;
    if (!account) throw new InstagramError('not_found');
    if (account.status === 'disconnected') throw new InstagramError('instagram_account_disconnected');
  });
  const secret = await asWorker(actor.accountId, (tx) => loadAccountSecretTx(tx, actor.accountId, instagramAccountId));
  if (!secret || secret.status === 'disconnected') throw new InstagramError('instagram_account_disconnected');
  const token = readToken(secret);
  if (!token) throw new InstagramError('instagram_token_invalid');
  try {
    return await listMediaPage(secret.ig_user_id, token, after);
  } catch (error) {
    if (error instanceof InstagramGraphInputError) throw new InstagramError('invalid_request');
    if (isMetaTokenInvalid(error)) throw new InstagramError('instagram_token_invalid');
    if (isMetaThrottle(error)) throw new InstagramError('rate_limited');
    throw new InstagramError('meta_error');
  }
}
