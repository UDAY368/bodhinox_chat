// GET /api/whatsapp/ice-breakers[?number=<config id>] — that number's ice breakers (any member).
// PUT /api/whatsapp/ice-breakers[?number=<config id>] { prompts } — set them on Meta, then save (admin).
// Ice breakers belong to one WhatsApp number; without ?number it is the
// workspace default (or the only number). Saved only after Meta accepts them,
// so the stored list never claims prompts customers cannot see.

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { getCurrentAccount, requireRole, toErrorResponse, type AccountContext } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { decrypt } from '@/lib/whatsapp/encryption';
import { setIceBreakers } from '@/lib/whatsapp/meta-api';
import { getNumberConfig, NoNumberError, type NumberConfig } from '@/lib/whatsapp/numbers';

const t = getT('Api');
const tn = getT('whatsappNumbers');
const MAX_ICE_BREAKERS = 4;
const ICE_BREAKER_MAX_LENGTH = 80;
const Body = z.object({
  prompts: z.array(z.string().trim().min(1).max(ICE_BREAKER_MAX_LENGTH)).max(MAX_ICE_BREAKERS)
    .refine((list) => new Set(list.map((p) => p.toLowerCase())).size === list.length),
});
const headers = { 'Cache-Control': 'private, no-store' };

/** The requested number (else the default), null when none is connected, or the error response. */
async function resolveNumber(ctx: AccountContext, request: Request): Promise<NumberConfig | null | NextResponse> {
  const requested = new URL(request.url).searchParams.get('number') || undefined;
  try {
    return await withTenant(tenantOf(ctx), (tx) => getNumberConfig(tx, ctx.accountId, requested));
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
    return NextResponse.json({
      number_id: number?.id ?? null,
      prompts: number?.ice_breakers ?? [],
      synced_at: number?.ice_breakers_synced_at?.toISOString() ?? null,
    }, { headers });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`iceBreakers:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const parsed = Body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: t('whatsappConfig.iceBreakersInvalid', { max: MAX_ICE_BREAKERS, length: ICE_BREAKER_MAX_LENGTH }) }, { status: 400 });
    }
    const number = await resolveNumber(ctx, request);
    if (number instanceof NextResponse) return number;
    if (!number?.phone_number_id || !number.access_token || number.status !== 'connected') {
      return NextResponse.json({ error: t('whatsappConfig.notConnected') }, { status: 409 });
    }
    try {
      await setIceBreakers({ phoneNumberId: number.phone_number_id, accessToken: decrypt(number.access_token), prompts: parsed.data.prompts });
    } catch {
      return NextResponse.json({ error: t('whatsappConfig.iceBreakersSyncFailed') }, { status: 502 });
    }
    const syncedAt = new Date();
    // Saved on the same row Meta was told about; a number swapped meanwhile is not overwritten.
    await withTenant(tenantOf(ctx), (tx) => tx.whatsapp_config.updateMany({
      where: { account_id: ctx.accountId, id: number.id, phone_number_id: number.phone_number_id },
      data: { ice_breakers: parsed.data.prompts, ice_breakers_synced_at: syncedAt },
    }));
    return NextResponse.json({ number_id: number.id, prompts: parsed.data.prompts, synced_at: syncedAt.toISOString() });
  } catch (error) {
    return toErrorResponse(error);
  }
}
