/**
 * Forms key rotation storage. Meta keeps one business encryption key per phone
 * number, so each whatsapp_config row (number) has its own key pair. A rotation
 * claims that number's row under a row lock, so two rotations never upload keys
 * for the same number to Meta at the same time: the claim stores the new private
 * key as pending and starts a lease that later rotations wait out. The caller
 * then uploads the public half to Meta and promotes the pending key. If the
 * promote never happens after Meta accepted the key, the data endpoint still
 * decrypts with the pending key (formsPrivateKeys). Keys stay encrypted here and
 * are never returned to a browser.
 */

import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { setBusinessEncryptionKey } from '@/lib/whatsapp/meta-api';

/** Longer than the Meta upload timeout, so a live rotation is never overtaken. */
export const ROTATION_LEASE_SECONDS = 120;

export type RotationClaim =
  | { kind: 'notConnected' }
  | { kind: 'busy' }
  | { kind: 'claimed'; phoneNumberId: string; accessTokenEnc: string };

/** `configId` is the whatsapp_config row (number) whose key is rotated; the caller resolved it in this workspace. */
export function claimFormsKeyRotation(tenant: TenantContext, configId: string, pendingKeyEnc: string): Promise<RotationClaim> {
  return withTenant(tenant, async (tx) => {
    // FOR UPDATE serializes concurrent claims for this number.
    const rows = await tx.$queryRaw<{ phone_number_id: string | null; access_token: string | null; status: string | null; rotating: boolean }[]>`
      SELECT phone_number_id, access_token, status,
        COALESCE(forms_key_rotation_started_at > now() - make_interval(secs => ${ROTATION_LEASE_SECONDS}), false) AS rotating
      FROM whatsapp_config WHERE account_id = ${tenant.accountId}::uuid AND id = ${configId}::uuid FOR UPDATE`;
    const config = rows[0];
    if (!config?.phone_number_id || !config.access_token || config.status !== 'connected') return { kind: 'notConnected' };
    if (config.rotating) return { kind: 'busy' };
    await tx.$executeRaw`
      UPDATE whatsapp_config SET forms_pending_private_key_enc = ${pendingKeyEnc}, forms_key_rotation_started_at = now()
      WHERE account_id = ${tenant.accountId}::uuid AND id = ${configId}::uuid`;
    return { kind: 'claimed', phoneNumberId: config.phone_number_id, accessTokenEnc: config.access_token };
  });
}

/**
 * Ends this rotation's lease without promoting. The pending key stays: an upload
 * that timed out may still have reached Meta, and keeping it lets the endpoint
 * decrypt in that case.
 */
export async function releaseFormsKeyRotation(tenant: TenantContext, configId: string, pendingKeyEnc: string): Promise<void> {
  await withTenant(tenant, (tx) => tx.$executeRaw`
    UPDATE whatsapp_config SET forms_key_rotation_started_at = NULL
    WHERE account_id = ${tenant.accountId}::uuid AND id = ${configId}::uuid AND forms_pending_private_key_enc = ${pendingKeyEnc}`);
}

/**
 * Makes this rotation's pending key the number's current one. False when a later
 * rotation or a number change took the row over first; nothing is overwritten then.
 */
export async function promoteFormsKey(tenant: TenantContext, configId: string, args: {
  publicKeyPem: string; pendingKeyEnc: string; phoneNumberId: string; uploadedAt: Date;
}): Promise<boolean> {
  const updated = await withTenant(tenant, (tx) => tx.$executeRaw`
    UPDATE whatsapp_config
    SET forms_public_key = ${args.publicKeyPem}, forms_private_key_enc = forms_pending_private_key_enc,
      forms_pending_private_key_enc = NULL, forms_key_rotation_started_at = NULL, forms_key_uploaded_at = ${args.uploadedAt}
    WHERE account_id = ${tenant.accountId}::uuid AND id = ${configId}::uuid AND phone_number_id = ${args.phoneNumberId}
      AND forms_pending_private_key_enc = ${args.pendingKeyEnc}`);
  return updated === 1;
}

/**
 * Sends the number's current public key to Meta again. Registering a number
 * (again) makes Meta drop its business encryption key while this row still
 * holds the pair, and then every form send fails with #131009 "flow_id is
 * invalid". Called right after a register; best effort, so a connect never
 * fails because of it. Skipped when the number has no key or a rotation holds
 * the lease (that rotation uploads its own key). A failed upload clears
 * forms_key_uploaded_at, so Settings shows the key needs generating.
 */
export async function reuploadFormsKey(
  tenant: TenantContext,
  configId: string,
  args: { phoneNumberId: string; accessToken: string },
  upload: typeof setBusinessEncryptionKey = setBusinessEncryptionKey,
): Promise<'uploaded' | 'skipped' | 'failed'> {
  const publicKeyPem = await withTenant(tenant, async (tx) => {
    const rows = await tx.$queryRaw<{ forms_public_key: string | null; rotating: boolean }[]>`
      SELECT forms_public_key,
        COALESCE(forms_key_rotation_started_at > now() - make_interval(secs => ${ROTATION_LEASE_SECONDS}), false) AS rotating
      FROM whatsapp_config WHERE account_id = ${tenant.accountId}::uuid AND id = ${configId}::uuid
        AND phone_number_id = ${args.phoneNumberId} AND forms_private_key_enc IS NOT NULL FOR UPDATE`;
    const row = rows[0];
    if (!row?.forms_public_key || row.rotating) return null;
    // Take the lease so a rotation started meanwhile waits for this upload.
    await tx.$executeRaw`UPDATE whatsapp_config SET forms_key_rotation_started_at = now()
      WHERE account_id = ${tenant.accountId}::uuid AND id = ${configId}::uuid`;
    return row.forms_public_key;
  }).catch(() => null);
  if (!publicKeyPem) return 'skipped';
  const ok = await upload({ phoneNumberId: args.phoneNumberId, accessToken: args.accessToken, publicKeyPem }).then(() => true, () => false);
  await withTenant(tenant, (tx) => tx.$executeRaw`
    UPDATE whatsapp_config SET forms_key_rotation_started_at = NULL,
      forms_key_uploaded_at = CASE WHEN ${ok} THEN now() ELSE NULL END
    WHERE account_id = ${tenant.accountId}::uuid AND id = ${configId}::uuid AND forms_public_key = ${publicKeyPem}`).catch(() => undefined);
  return ok ? 'uploaded' : 'failed';
}
