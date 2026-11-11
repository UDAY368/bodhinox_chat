// Instagram profile fetch (Phase 11): GET /{igsid}?fields=name,username with the
// account's token updates the identity's display fields, and sets the contact
// name to the profile's display name while the contact still has no name (a
// name staff typed is never overwritten). The IGSID and username are
// identifiers that masking hides (maskIdentityRow), so neither is ever written
// into contacts.name, which every list, search and event returns unmasked. A 4xx (for example no profile consent) is a pre-send rejection:
// the placeholder stays and the job is not retried. A disconnected, token-invalid
// or permission-missing account makes no call. Nothing is logged but ids-free counts.
// The Graph call never runs inside an open transaction. Stage 2 adds
// refreshProfileFacts (the follow gate's live read of the follow facts). Stage 3
// adds the stale-profile re-check: segments read the stored facts, so
// queueStaleProfileRechecks queues one { identityId, facts: true } job per identity
// whose facts are older than PROFILE_STALE_MS (or never read), and the job re-reads them.
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { decrypt } from '@/lib/whatsapp/encryption';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { instagramConfig } from './config';
import { getProfile, type InstagramProfile } from './graph';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Target { igsid: string; contactId: string; tokenEnc: string }

/** The instagram.profile_fetch job: { identityId }. */
export async function handleProfileFetchJob(accountId: string, payload: Record<string, unknown>): Promise<void> {
  if (!instagramConfig()) return;
  const identityId = payload.identityId;
  if (typeof identityId !== 'string' || !UUID.test(identityId)) throw new Error('Invalid job identifier');
  if (payload.facts === true) return void (await refreshIdentityFacts(accountId, identityId));
  const run = <T,>(work: (tx: TenantTransaction) => Promise<T>) => withTenant({ accountId, role: 'owner' }, work, getWorkerPrisma());
  const target = await run(async (tx): Promise<Target | null> => {
    const [row] = await tx.$queryRaw<{ external_id: string; contact_id: string; access_token_enc: string | null; status: string;
      username: string | null; display_name: string | null }[]>`
      SELECT i.external_id, i.contact_id::text AS contact_id, a.access_token_enc, a.status, i.username, i.display_name
      FROM contact_channel_identities i
      JOIN instagram_accounts a ON a.account_id=i.account_id AND a.id=i.instagram_account_id
      WHERE i.account_id=${accountId}::uuid AND i.id=${identityId}::uuid`;
    if (!row || row.status !== 'active' || !row.access_token_enc) return null;
    if (row.username || row.display_name) return null;
    return { igsid: row.external_id, contactId: row.contact_id, tokenEnc: row.access_token_enc };
  });
  if (!target) return;
  let profile: InstagramProfile;
  try {
    profile = await getProfile(target.igsid, decrypt(target.tokenEnc));
  } catch (error) {
    // No consent, unknown user, throttled: keep the placeholder, do not retry.
    if (error instanceof MetaApiError && error.httpStatus >= 400 && error.httpStatus < 500) return;
    throw error;
  }
  const username = profile.username && /^[A-Za-z0-9._]{1,64}$/.test(profile.username) ? profile.username : null;
  const displayName = profile.name ? profile.name.slice(0, 500) : null;
  if (!username && !displayName) return;
  await run(async (tx) => {
    await tx.$executeRaw`UPDATE contact_channel_identities SET username=${username}, display_name=${displayName}
      WHERE account_id=${accountId}::uuid AND id=${identityId}::uuid`;
    if (displayName) await tx.$executeRaw`UPDATE contacts SET name=${displayName}, updated_at=now()
      WHERE account_id=${accountId}::uuid AND id=${target.contactId}::uuid AND (name IS NULL OR btrim(name)='')`;
  });
}

/** A conversation's Instagram profile facts (null: unknown). */
export interface ProfileFacts {
  followsBusiness: boolean | null;
  businessFollows: boolean | null;
  isVerified: boolean | null;
  followerCount: number | null;
}

/**
 * The follow gate (Stage 2, plan item 8): reads the customer's follow,
 * verified and follower facts from Meta now (needs live capture: the field
 * names follow Meta's documented user profile, not yet seen on an Instagram
 * Login app) and stores them on the identity with profile_checked_at. When
 * Meta does not answer with them (no consent, throttled, account not usable)
 * the stored facts are returned instead, so a run never fails on them.
 * Null when the conversation is not an Instagram one of this workspace or
 * Instagram is off. The Graph call never runs inside a transaction; nothing
 * is logged.
 */
export async function refreshProfileFacts(accountId: string, conversationId: string): Promise<ProfileFacts | null> {
  if (!instagramConfig() || !UUID.test(accountId) || !UUID.test(conversationId)) return null;
  const run = <T,>(work: (tx: TenantTransaction) => Promise<T>) => withTenant({ accountId, role: 'owner' }, work, getWorkerPrisma());
  const row = await run(async (tx) => {
    const [found] = await tx.$queryRaw<FactsRow[]>`
      SELECT i.id::text AS identity_id, i.external_id, a.access_token_enc, a.status, i.follows_business, i.business_follows,
        i.is_verified, i.ig_follower_count
      FROM conversations c
      JOIN contact_channel_identities i ON i.account_id=c.account_id AND i.contact_id=c.contact_id
        AND i.instagram_account_id=c.instagram_account_id
      JOIN instagram_accounts a ON a.account_id=c.account_id AND a.id=c.instagram_account_id
      WHERE c.account_id=${accountId}::uuid AND c.id=${conversationId}::uuid AND c.channel='instagram'
      ORDER BY i.created_at, i.id LIMIT 1`;
    return found ?? null;
  });
  if (!row) return null;
  return readAndStoreFacts(accountId, run, row);
}

/** The stale-profile re-check for one identity (the instagram.profile_fetch job with facts: true). */
export async function refreshIdentityFacts(accountId: string, identityId: string): Promise<ProfileFacts | null> {
  if (!instagramConfig() || !UUID.test(accountId) || !UUID.test(identityId)) return null;
  const run = <T,>(work: (tx: TenantTransaction) => Promise<T>) => withTenant({ accountId, role: 'owner' }, work, getWorkerPrisma());
  const row = await run(async (tx) => {
    const [found] = await tx.$queryRaw<FactsRow[]>`
      SELECT i.id::text AS identity_id, i.external_id, a.access_token_enc, a.status, i.follows_business, i.business_follows,
        i.is_verified, i.ig_follower_count
      FROM contact_channel_identities i
      JOIN instagram_accounts a ON a.account_id=i.account_id AND a.id=i.instagram_account_id
      WHERE i.account_id=${accountId}::uuid AND i.id=${identityId}::uuid AND i.channel='instagram' LIMIT 1`;
    return found ?? null;
  });
  return row ? readAndStoreFacts(accountId, run, row, true) : null;
}

interface FactsRow { identity_id: string; external_id: string; access_token_enc: string | null; status: string;
  follows_business: boolean | null; business_follows: boolean | null; is_verified: boolean | null; ig_follower_count: number | null }

async function readAndStoreFacts(accountId: string, run: <T>(work: (tx: TenantTransaction) => Promise<T>) => Promise<T>,
  row: FactsRow, stampOnRefusal = false): Promise<ProfileFacts> {
  // The re-check stamps profile_checked_at when Meta did not answer, keeping the stored facts: an identity Meta keeps
  // refusing is retried after PROFILE_STALE_MS, not queued again every day ahead of the others (oldest-first, capped).
  const unanswered = async () => {
    if (stampOnRefusal) await run((tx) => tx.$executeRaw`UPDATE contact_channel_identities SET profile_checked_at=now()
      WHERE account_id=${accountId}::uuid AND id=${row.identity_id}::uuid`);
    return stored;
  };
  const stored: ProfileFacts = { followsBusiness: row.follows_business, businessFollows: row.business_follows,
    isVerified: row.is_verified, followerCount: row.ig_follower_count };
  if (row.status !== 'active' || !row.access_token_enc) return stored;
  let token: string;
  try { token = decrypt(row.access_token_enc); } catch { return unanswered(); }
  let profile: InstagramProfile;
  try {
    profile = await getProfile(row.external_id, token, { facts: true });
  } catch {
    // Refused by Meta, or a network failure or timeout: a read changes nothing on
    // Meta's side, so the run goes on with the stored facts rather than failing.
    return unanswered();
  }
  const f = profile.facts;
  if (!f) return unanswered();
  await run((tx) => tx.$executeRaw`UPDATE contact_channel_identities SET follows_business=${f.followsBusiness},
    business_follows=${f.businessFollows}, is_verified=${f.isVerified}, ig_follower_count=${f.followerCount}, profile_checked_at=now()
    WHERE account_id=${accountId}::uuid AND id=${row.identity_id}::uuid`);
  return { followsBusiness: f.followsBusiness, businessFollows: f.businessFollows, isVerified: f.isVerified, followerCount: f.followerCount };
}

/** Facts older than this (or never read) are re-read by the re-check. */
export const PROFILE_STALE_MS = 7 * 24 * 60 * 60 * 1000;
/** At most this many identities are queued per call, so a large workspace re-checks over several days. */
export const PROFILE_RECHECK_BATCH = 200;

/**
 * Queues the stale-profile re-check for the workspace: one profile_fetch job
 * ({ identityId, facts: true }) per Instagram identity of an active account whose
 * facts were never read or were read over PROFILE_STALE_MS ago, at most
 * PROFILE_RECHECK_BATCH, oldest first, deduplicated per identity and day so
 * repeated calls queue nothing new. `tx` is a tenant transaction of `accountId`;
 * returns how many jobs were queued. Nothing is logged.
 */
export async function queueStaleProfileRechecks(tx: TenantTransaction, accountId: string, now: Date = new Date()): Promise<number> {
  if (!instagramConfig() || !UUID.test(accountId)) return 0;
  const day = now.toISOString().slice(0, 10);
  const cutoff = new Date(now.getTime() - PROFILE_STALE_MS);
  return tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key)
    SELECT 'instagram.profile_fetch', ${accountId}::uuid,
      jsonb_build_object('accountId', ${accountId}::text, 'identityId', s.id::text, 'facts', true),
      'igfacts:' || s.id::text || ':' || ${day}::text
    FROM (
      SELECT i.id FROM contact_channel_identities i
      JOIN instagram_accounts a ON a.account_id=i.account_id AND a.id=i.instagram_account_id AND a.status='active'
      WHERE i.account_id=${accountId}::uuid AND i.channel='instagram'
        AND (i.profile_checked_at IS NULL OR i.profile_checked_at < ${cutoff})
      ORDER BY i.profile_checked_at NULLS FIRST, i.id LIMIT ${PROFILE_RECHECK_BATCH}
    ) s
    ON CONFLICT(dedupe_key) DO NOTHING`;
}
