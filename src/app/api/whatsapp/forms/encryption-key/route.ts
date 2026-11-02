// GET /api/whatsapp/forms/encryption-key[?number=<config id>] — whether that number has a forms key (any member).
// POST /api/whatsapp/forms/encryption-key[?number=<config id>] — generate a new key pair, upload the
// public half to Meta for that number, then make it current (admin).
// Meta holds one key per phone number, so each number has its own; without
// ?number it is the workspace default (or the only number). Rotations are
// serialized per number (lib/whatsapp/forms/keys): the claim stores the new
// private key as pending before the upload, so if Meta accepts the key but the
// promote fails, the data endpoint still decrypts with it. The private key never
// leaves the server and is stored encrypted.

import { NextResponse } from 'next/server';

import { getCurrentAccount, requireRole, toErrorResponse, type AccountContext } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { decrypt, encrypt } from '@/lib/whatsapp/encryption';
import { generateFormsKeyPair } from '@/lib/whatsapp/forms/crypto';
import { claimFormsKeyRotation, promoteFormsKey, releaseFormsKeyRotation } from '@/lib/whatsapp/forms/keys';
import { setBusinessEncryptionKey } from '@/lib/whatsapp/meta-api';
import { getNumberConfig, NoNumberError } from '@/lib/whatsapp/numbers';

const t = getT('Api.formsKey');
const tn = getT('whatsappNumbers');
/** Each rotation makes in-flight form screens refetch the key; a handful per hour per number is plenty. */
const ROTATE_LIMIT = { limit: 5, windowMs: 60 * 60_000 };
const headers = { 'Cache-Control': 'private, no-store' };

type KeyStatus = { number_id: string | null; configured: boolean; uploaded_at: string | null };
type NumberKey = { id: string; configured: boolean; uploaded_at: Date | null };

/**
 * The requested number (else the default) with its key status, null when no
 * number is connected, or the error response. Key material is never selected.
 */
async function resolveNumber(ctx: AccountContext, request: Request): Promise<NumberKey | null | NextResponse> {
  const requested = new URL(request.url).searchParams.get('number') || undefined;
  try {
    return await withTenant(tenantOf(ctx), async (tx) => {
      const { id } = await getNumberConfig(tx, ctx.accountId, requested);
      const rows = await tx.$queryRaw<NumberKey[]>`
        SELECT id, forms_public_key IS NOT NULL AND forms_private_key_enc IS NOT NULL AS configured, forms_key_uploaded_at AS uploaded_at
        FROM whatsapp_config WHERE account_id = ${ctx.accountId}::uuid AND id = ${id}::uuid`;
      return rows[0] ?? { id, configured: false, uploaded_at: null };
    });
  } catch (error) {
    if (!(error instanceof NoNumberError)) throw error;
    if (error.reason === 'none') return null;
    return NextResponse.json(
      { error: tn(error.messageKey.replace(/^whatsappNumbers\./, '')) },
      { status: error.reason === 'not_found' ? 404 : 409 }
    );
  }
}

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const number = await resolveNumber(ctx, request);
    if (number instanceof NextResponse) return number;
    const body: KeyStatus = {
      number_id: number?.id ?? null,
      configured: number?.configured ?? false,
      uploaded_at: number?.uploaded_at?.toISOString() ?? null,
    };
    return NextResponse.json(body, { headers });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const userLimit = checkRateLimit(`formsKey:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!userLimit.success) return rateLimitResponse(userLimit);

    const number = await resolveNumber(ctx, request);
    if (number instanceof NextResponse) return number;
    if (!number) return NextResponse.json({ error: t('notConnected') }, { status: 409 });
    const numberLimit = checkRateLimit(`formsKeyNumber:${ctx.accountId}:${number.id}`, ROTATE_LIMIT);
    if (!numberLimit.success) return rateLimitResponse(numberLimit);

    const tenant = tenantOf(ctx);
    const { publicKeyPem, privateKeyPem } = generateFormsKeyPair();
    const pendingKeyEnc = encrypt(privateKeyPem);
    const claim = await claimFormsKeyRotation(tenant, number.id, pendingKeyEnc);
    if (claim.kind === 'notConnected') return NextResponse.json({ error: t('notConnected') }, { status: 409 });
    if (claim.kind === 'busy') return NextResponse.json({ error: t('rotationInProgress') }, { status: 409 });

    try {
      await setBusinessEncryptionKey({ phoneNumberId: claim.phoneNumberId, accessToken: decrypt(claim.accessTokenEnc), publicKeyPem });
    } catch {
      // The lease would expire anyway; releasing it lets the admin retry now.
      await releaseFormsKeyRotation(tenant, number.id, pendingKeyEnc).catch(() => undefined);
      return NextResponse.json({ error: t('uploadFailed') }, { status: 502 });
    }
    const uploadedAt = new Date();
    let promoted: boolean;
    try {
      promoted = await promoteFormsKey(tenant, number.id, { publicKeyPem, pendingKeyEnc, phoneNumberId: claim.phoneNumberId, uploadedAt });
    } catch {
      // Meta holds the new key and it is stored as pending, so forms keep working.
      return NextResponse.json({ error: t('savePending') }, { status: 500 });
    }
    if (!promoted) return NextResponse.json({ error: t('saveFailed') }, { status: 409 });
    const body: KeyStatus = { number_id: number.id, configured: true, uploaded_at: uploadedAt.toISOString() };
    return NextResponse.json(body);
  } catch (error) {
    return toErrorResponse(error);
  }
}
