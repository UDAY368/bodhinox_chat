// Instagram profile fetch (Phase 11): GET /{igsid}?fields=name,username with the
// account's token updates the identity's display fields, and sets the contact
// name to the profile's display name while the contact still has no name (a
// name staff typed is never overwritten). The IGSID and username are
// identifiers that masking hides (maskIdentityRow), so neither is ever written
// into contacts.name, which every list, search and event returns unmasked. A 4xx (for example no profile consent) is a pre-send rejection:
// the placeholder stays and the job is not retried. A disconnected, token-invalid
// or permission-missing account makes no call. Nothing is logged but ids-free counts.
// The Graph call never runs inside an open transaction.
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
