// GET /api/whatsapp/forms/encryption-key — whether the number has a forms key (any member).
// POST /api/whatsapp/forms/encryption-key — generate a new key pair, upload the
// public half to Meta, then make it current (admin). Rotations are serialized per
// account (lib/whatsapp/forms/keys): the claim stores the new private key as
// pending before the upload, so if Meta accepts the key but the promote fails,
// the data endpoint still decrypts with it. The private key never leaves the
// server and is stored encrypted.

import { NextResponse } from 'next/server';

import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { decrypt, encrypt } from '@/lib/whatsapp/encryption';
import { generateFormsKeyPair } from '@/lib/whatsapp/forms/crypto';
import { claimFormsKeyRotation, promoteFormsKey, releaseFormsKeyRotation } from '@/lib/whatsapp/forms/keys';
import { setBusinessEncryptionKey } from '@/lib/whatsapp/meta-api';

const t = getT('Api.formsKey');
/** Each rotation makes in-flight form screens refetch the key; a handful per hour is plenty. */
const ROTATE_LIMIT = { limit: 5, windowMs: 60 * 60_000 };

type KeyStatus = { configured: boolean; uploaded_at: string | null };

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const rows = await withTenant(tenantOf(ctx), (tx) => tx.$queryRaw<{ configured: boolean; uploaded_at: Date | null }[]>`
      SELECT forms_public_key IS NOT NULL AND forms_private_key_enc IS NOT NULL AS configured, forms_key_uploaded_at AS uploaded_at
      FROM whatsapp_config WHERE account_id = ${ctx.accountId}::uuid LIMIT 1`);
    const row = rows[0];
    const body: KeyStatus = { configured: row?.configured ?? false, uploaded_at: row?.uploaded_at?.toISOString() ?? null };
    return NextResponse.json(body, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST() {
  try {
    const ctx = await requireRole('admin');
    const userLimit = checkRateLimit(`formsKey:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!userLimit.success) return rateLimitResponse(userLimit);
    const accountLimit = checkRateLimit(`formsKeyAccount:${ctx.accountId}`, ROTATE_LIMIT);
    if (!accountLimit.success) return rateLimitResponse(accountLimit);

    const tenant = tenantOf(ctx);
    const { publicKeyPem, privateKeyPem } = generateFormsKeyPair();
    const pendingKeyEnc = encrypt(privateKeyPem);
    const claim = await claimFormsKeyRotation(tenant, pendingKeyEnc);
    if (claim.kind === 'notConnected') return NextResponse.json({ error: t('notConnected') }, { status: 409 });
    if (claim.kind === 'busy') return NextResponse.json({ error: t('rotationInProgress') }, { status: 409 });

    try {
      await setBusinessEncryptionKey({ phoneNumberId: claim.phoneNumberId, accessToken: decrypt(claim.accessTokenEnc), publicKeyPem });
    } catch {
      // The lease would expire anyway; releasing it lets the admin retry now.
      await releaseFormsKeyRotation(tenant, pendingKeyEnc).catch(() => undefined);
      return NextResponse.json({ error: t('uploadFailed') }, { status: 502 });
    }
    const uploadedAt = new Date();
    let promoted: boolean;
    try {
      promoted = await promoteFormsKey(tenant, { publicKeyPem, pendingKeyEnc, phoneNumberId: claim.phoneNumberId, uploadedAt });
    } catch {
      // Meta holds the new key and it is stored as pending, so forms keep working.
      return NextResponse.json({ error: t('savePending') }, { status: 500 });
    }
    if (!promoted) return NextResponse.json({ error: t('saveFailed') }, { status: 409 });
    const body: KeyStatus = { configured: true, uploaded_at: uploadedAt.toISOString() };
    return NextResponse.json(body);
  } catch (error) {
    return toErrorResponse(error);
  }
}
