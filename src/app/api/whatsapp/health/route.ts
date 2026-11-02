// GET  /api/whatsapp/health[?number=<id>] — live Meta health of one number (any member).
//      Without ?number it is the workspace default, as before multi-number support.
// POST /api/whatsapp/health[?number=<id>] — refresh that number's stored health now and
//      alert admins about changes, exactly as the six-hourly worker sync does (admin).
// Access tokens never leave the server; Meta errors come back as a fixed state.

import { NextResponse } from 'next/server';
import { getCurrentAccount, requireRole, toErrorResponse, type AccountContext } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { getPrisma } from '@/lib/db/prisma';
import { getT } from '@/lib/i18n/translate';
import { decrypt } from '@/lib/whatsapp/encryption';
import { getPhoneNumberHealth } from '@/lib/whatsapp/meta-api';
import { getNumberConfig, NoNumberError } from '@/lib/whatsapp/numbers';
import { parseMessagingLimit, parseQualityRating, type PhoneHealth } from '@/lib/whatsapp/phone-health';
import { syncNumberHealth } from '@/lib/whatsapp/health-sync';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

const t = getT('Api');
const empty = { displayPhoneNumber: null, quality: 'UNKNOWN', limit: null } as const;
const reply = (body: PhoneHealth & { numberId: string | null }) =>
  NextResponse.json(body, { headers: { 'Cache-Control': 'private, max-age=300' } });

/** The requested number (or the default), or a response explaining why there is none. */
async function resolveNumber(ctx: AccountContext, request: Request) {
  const requested = new URL(request.url).searchParams.get('number');
  try {
    return await withTenant(tenantOf(ctx), (tx) => getNumberConfig(tx, ctx.accountId, requested || undefined));
  } catch (error) {
    if (!(error instanceof NoNumberError)) throw error;
    if (error.reason === 'none') return null;
    const key = error.reason === 'not_found' ? 'whatsappHealth.numberNotFound' : 'whatsappHealth.chooseNumber';
    return NextResponse.json({ error: t(key) }, { status: error.reason === 'not_found' ? 404 : 409 });
  }
}

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const limit = checkRateLimit(`whatsapp:health:${ctx.accountId}:${ctx.userId}`, { limit: 12, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);
    const config = await resolveNumber(ctx, request);
    if (config instanceof NextResponse) return config;
    if (!config?.phone_number_id || !config.access_token || config.status !== 'connected')
      return reply({ state: 'disconnected', numberId: config?.id ?? null, ...empty });
    try {
      const info = await getPhoneNumberHealth({ phoneNumberId: config.phone_number_id, accessToken: decrypt(config.access_token) });
      return reply({
        state: 'connected',
        numberId: config.id,
        displayPhoneNumber: info.display_phone_number ?? null,
        quality: parseQualityRating(info.quality_rating),
        limit: parseMessagingLimit(info.whatsapp_business_manager_messaging_limit),
      });
    } catch {
      return reply({ state: 'unavailable', numberId: config.id, ...empty });
    }
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`whatsapp:health:sync:${ctx.accountId}:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const config = await resolveNumber(ctx, request);
    if (config instanceof NextResponse) return config;
    if (!config) return NextResponse.json({ error: t('whatsappHealth.notConnected') }, { status: 409 });
    // Runs as the admin under tenant RLS, not as the worker.
    const result = await syncNumberHealth({ accountId: ctx.accountId, configId: config.id, tenant: tenantOf(ctx), db: getPrisma() });
    if (result.status === 'not_found') return NextResponse.json({ error: t('whatsappHealth.numberNotFound') }, { status: 404 });
    if (result.status === 'disconnected') return NextResponse.json({ error: t('whatsappHealth.notConnected') }, { status: 409 });
    if (result.status === 'error')
      return NextResponse.json({ numberId: config.id, status: 'error', error: result.error, message: t(`whatsappHealth.error.${result.error}`) }, { status: 502 });
    return NextResponse.json({
      numberId: config.id,
      status: 'synced',
      health: {
        quality_rating: result.snapshot.quality_rating,
        messaging_limit_tier: result.snapshot.messaging_limit_tier,
        name_status: result.snapshot.name_status,
        code_verification_status: result.snapshot.code_verification_status,
      },
      changes: result.changes.map((change) => change.kind),
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
