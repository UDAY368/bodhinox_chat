/**
 * Forms key rotation storage. A rotation claims the account's whatsapp_config
 * row under a row lock, so two rotations never upload keys to Meta at the same
 * time: the claim stores the new private key as pending and starts a lease that
 * later rotations wait out. The caller then uploads the public half to Meta and
 * promotes the pending key. If the promote never happens after Meta accepted the
 * key, the data endpoint still decrypts with the pending key (formsPrivateKeys).
 * Keys stay encrypted here and are never returned to a browser.
 */

import { withTenant, type TenantContext } from '@/lib/db/tenant';

/** Longer than the Meta upload timeout, so a live rotation is never overtaken. */
export const ROTATION_LEASE_SECONDS = 120;

export type RotationClaim =
  | { kind: 'notConnected' }
  | { kind: 'busy' }
  | { kind: 'claimed'; phoneNumberId: string; accessTokenEnc: string };

export function claimFormsKeyRotation(tenant: TenantContext, pendingKeyEnc: string): Promise<RotationClaim> {
  return withTenant(tenant, async (tx) => {
    // FOR UPDATE serializes concurrent claims for this account.
    const rows = await tx.$queryRaw<{ phone_number_id: string | null; access_token: string | null; status: string | null; rotating: boolean }[]>`
      SELECT phone_number_id, access_token, status,
        COALESCE(forms_key_rotation_started_at > now() - make_interval(secs => ${ROTATION_LEASE_SECONDS}), false) AS rotating
      FROM whatsapp_config WHERE account_id = ${tenant.accountId}::uuid LIMIT 1 FOR UPDATE`;
    const config = rows[0];
    if (!config?.phone_number_id || !config.access_token || config.status !== 'connected') return { kind: 'notConnected' };
    if (config.rotating) return { kind: 'busy' };
    await tx.$executeRaw`
      UPDATE whatsapp_config SET forms_pending_private_key_enc = ${pendingKeyEnc}, forms_key_rotation_started_at = now()
      WHERE account_id = ${tenant.accountId}::uuid`;
    return { kind: 'claimed', phoneNumberId: config.phone_number_id, accessTokenEnc: config.access_token };
  });
}

/**
 * Ends this rotation's lease without promoting. The pending key stays: an upload
 * that timed out may still have reached Meta, and keeping it lets the endpoint
 * decrypt in that case.
 */
export async function releaseFormsKeyRotation(tenant: TenantContext, pendingKeyEnc: string): Promise<void> {
  await withTenant(tenant, (tx) => tx.$executeRaw`
    UPDATE whatsapp_config SET forms_key_rotation_started_at = NULL
    WHERE account_id = ${tenant.accountId}::uuid AND forms_pending_private_key_enc = ${pendingKeyEnc}`);
}

/**
 * Makes this rotation's pending key the current one. False when a later rotation
 * or a number change took the row over first; nothing is overwritten then.
 */
export async function promoteFormsKey(tenant: TenantContext, args: {
  publicKeyPem: string; pendingKeyEnc: string; phoneNumberId: string; uploadedAt: Date;
}): Promise<boolean> {
  const updated = await withTenant(tenant, (tx) => tx.$executeRaw`
    UPDATE whatsapp_config
    SET forms_public_key = ${args.publicKeyPem}, forms_private_key_enc = forms_pending_private_key_enc,
      forms_pending_private_key_enc = NULL, forms_key_rotation_started_at = NULL, forms_key_uploaded_at = ${args.uploadedAt}
    WHERE account_id = ${tenant.accountId}::uuid AND phone_number_id = ${args.phoneNumberId}
      AND forms_pending_private_key_enc = ${args.pendingKeyEnc}`);
  return updated === 1;
}
