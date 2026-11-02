// GET /api/whatsapp/ice-breakers — the number's ice breakers (any member).
// PUT /api/whatsapp/ice-breakers { prompts } — set them on Meta, then save (admin).
// Saved only after Meta accepts them, so the stored list never claims
// prompts customers cannot see.

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account';
import { getT } from '@/lib/i18n/translate';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { decrypt } from '@/lib/whatsapp/encryption';
import { setIceBreakers } from '@/lib/whatsapp/meta-api';

const t = getT('Api');
const MAX_ICE_BREAKERS = 4;
const ICE_BREAKER_MAX_LENGTH = 80;
const Body = z.object({
  prompts: z.array(z.string().trim().min(1).max(ICE_BREAKER_MAX_LENGTH)).max(MAX_ICE_BREAKERS)
    .refine((list) => new Set(list.map((p) => p.toLowerCase())).size === list.length),
});

export async function GET() {
  try {
    const { db, accountId } = await getCurrentAccount();
    const { data, error } = await db.from('whatsapp_config').select('ice_breakers,ice_breakers_synced_at').eq('account_id', accountId).maybeSingle();
    if (error) throw error;
    return NextResponse.json({ prompts: data?.ice_breakers ?? [], synced_at: data?.ice_breakers_synced_at ?? null });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const { db, accountId, userId } = await requireRole('admin');
    const limit = checkRateLimit(`iceBreakers:${userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const parsed = Body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: t('whatsappConfig.iceBreakersInvalid', { max: MAX_ICE_BREAKERS, length: ICE_BREAKER_MAX_LENGTH }) }, { status: 400 });
    }
    const { data: config, error } = await db.from('whatsapp_config').select('phone_number_id,access_token,status').eq('account_id', accountId).maybeSingle();
    if (error) throw error;
    if (!config?.phone_number_id || !config.access_token || config.status !== 'connected') {
      return NextResponse.json({ error: t('whatsappConfig.notConnected') }, { status: 409 });
    }
    try {
      await setIceBreakers({ phoneNumberId: config.phone_number_id, accessToken: decrypt(config.access_token), prompts: parsed.data.prompts });
    } catch {
      return NextResponse.json({ error: t('whatsappConfig.iceBreakersSyncFailed') }, { status: 502 });
    }
    const syncedAt = new Date().toISOString();
    const { error: saveError } = await db.from('whatsapp_config')
      .update({ ice_breakers: parsed.data.prompts, ice_breakers_synced_at: syncedAt })
      .eq('account_id', accountId);
    if (saveError) throw saveError;
    return NextResponse.json({ prompts: parsed.data.prompts, synced_at: syncedAt });
  } catch (error) {
    return toErrorResponse(error);
  }
}
