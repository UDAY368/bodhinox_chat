// GET /api/whatsapp/numbers/[id]/profile  the number's WhatsApp business profile (any member).
// PUT /api/whatsapp/numbers/[id]/profile  update it on Meta, then return Meta's fresh copy (admin).
//   JSON body: { about?, address?, description?, email?, websites?, vertical? }
//   or multipart/form-data: `profile` (that JSON, optional) and `photo` (JPEG/PNG <= 5 MB, optional).
//   The photo goes through Meta's resumable upload to get a profile_picture_handle.
// The profile lives on Meta only; nothing is stored here, and the token never leaves the server.

import { NextResponse } from 'next/server';

import { getCurrentAccount, requireRole, toErrorResponse, type AccountContext } from '@/lib/auth/account';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { withTenant } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import {
  parseBusinessProfileUpdate,
  toBusinessProfile,
  validateProfilePhoto,
  type BusinessProfile,
} from '@/lib/whatsapp/business-profile';
import { decrypt } from '@/lib/whatsapp/encryption';
import { getBusinessProfile, updateBusinessProfile, uploadResumableMedia, type BusinessProfileUpdate } from '@/lib/whatsapp/meta-api';
import { assertNumberConnected, getNumberConfig, NoNumberError } from '@/lib/whatsapp/numbers';

const t = getT('Api.businessProfile');
const tn = getT('whatsappNumbers');
/** Each read is a Meta call; generous for opening the dialog, tight enough to stop loops. */
const READ_LIMIT = { limit: 60, windowMs: 60_000 };
const headers = { 'Cache-Control': 'private, no-store' };

type Params = { params: Promise<{ id: string }> };

async function loadNumber(ctx: AccountContext, id: string): Promise<{ phoneNumberId: string; accessToken: string } | NextResponse> {
  try {
    const row = await withTenant({ accountId: ctx.accountId, userId: ctx.userId, role: ctx.role }, (tx) =>
      getNumberConfig(tx, ctx.accountId, id)
    );
    // A removed number has no token to decrypt: say it needs reconnecting.
    assertNumberConnected(row);
    return { phoneNumberId: row.phone_number_id, accessToken: decrypt(row.access_token) };
  } catch (err) {
    if (err instanceof NoNumberError)
      return NextResponse.json({ error: tn(err.messageKey.replace(/^whatsappNumbers\./, '')) }, { status: err.reason === 'disconnected' ? 409 : 404 });
    throw err;
  }
}

function metaError(err: unknown, action: string): NextResponse {
  const code = err && typeof err === 'object' && 'code' in err ? (err as { code: unknown }).code : null;
  console.error(`[business-profile] ${action} failed`, { code });
  return NextResponse.json({ error: t(action === 'read' ? 'readFailed' : action === 'upload' ? 'photoUploadFailed' : 'saveFailed') }, { status: 502 });
}

async function fresh(number: { phoneNumberId: string; accessToken: string }): Promise<BusinessProfile> {
  return toBusinessProfile(await getBusinessProfile(number));
}

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const limit = checkRateLimit(`businessProfileRead:${ctx.userId}`, READ_LIMIT);
    if (!limit.success) return rateLimitResponse(limit);
    const number = await loadNumber(ctx, (await params).id);
    if (number instanceof NextResponse) return number;
    try {
      return NextResponse.json({ profile: await fresh(number) }, { headers });
    } catch (err) {
      return metaError(err, 'read');
    }
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** JPEG and PNG magic bytes, so a renamed file is refused before upload. */
function looksLikeImage(bytes: Uint8Array, type: string): boolean {
  if (type === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

export async function PUT(request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('admin');
    await assertMutation(request, await requireSession(request));
    const limit = checkRateLimit(`businessProfile:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    let body: unknown;
    let photo: File | null = null;
    if ((request.headers.get('content-type') ?? '').startsWith('multipart/form-data')) {
      const form = await request.formData().catch(() => null);
      if (!form) return NextResponse.json({ error: t('invalid.body') }, { status: 400 });
      const profile = form.get('profile');
      const file = form.get('photo');
      try {
        body = typeof profile === 'string' && profile ? JSON.parse(profile) : {};
      } catch {
        return NextResponse.json({ error: t('invalid.body') }, { status: 400 });
      }
      if (file !== null) {
        if (!(file instanceof File)) return NextResponse.json({ error: t('photo.type') }, { status: 400 });
        photo = file;
      }
    } else {
      body = await request.json().catch(() => null);
    }

    const parsed = parseBusinessProfileUpdate(body);
    if (!parsed.ok) {
      return NextResponse.json(
        { error: t(`invalid.${parsed.error.field === 'body' ? 'body' : `${parsed.error.field}_${parsed.error.reason}`}`), field: parsed.error.field },
        { status: 400 }
      );
    }
    let bytes: Uint8Array | null = null;
    if (photo) {
      const problem = validateProfilePhoto(photo);
      if (problem) return NextResponse.json({ error: t(`photo.${problem}`), field: 'photo' }, { status: 400 });
      bytes = new Uint8Array(await photo.arrayBuffer());
      if (!looksLikeImage(bytes, photo.type)) return NextResponse.json({ error: t('photo.type'), field: 'photo' }, { status: 400 });
    }
    const update: BusinessProfileUpdate = { ...parsed.update };
    if (!bytes && Object.keys(update).length === 0) return NextResponse.json({ error: t('invalid.empty') }, { status: 400 });

    const number = await loadNumber(ctx, (await params).id);
    if (number instanceof NextResponse) return number;

    if (photo && bytes) {
      const appId = process.env.META_APP_ID || process.env.NEXT_PUBLIC_META_APP_ID;
      if (!appId) return NextResponse.json({ error: t('photo.notConfigured') }, { status: 503 });
      try {
        const { handle } = await uploadResumableMedia({ appId, accessToken: number.accessToken, fileName: 'profile', mimeType: photo.type, bytes });
        update.profile_picture_handle = handle;
      } catch (err) {
        return metaError(err, 'upload');
      }
    }

    try {
      await updateBusinessProfile({ ...number, profile: update });
    } catch (err) {
      return metaError(err, 'save');
    }
    try {
      return NextResponse.json({ profile: await fresh(number) }, { headers });
    } catch {
      // Saved on Meta; only the re-read failed.
      return NextResponse.json({ profile: null, saved: true }, { headers });
    }
  } catch (error) {
    return toErrorResponse(error);
  }
}
