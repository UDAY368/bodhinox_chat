// POST /api/meta-ads/conversions/{id}/resolve { resolution: 'confirmed_sent' | 'confirmed_not_sent' } (admins and owners)
//   Records what the admin found in Events Manager for an event whose outcome
//   is unknown. Never sends or re-sends anything; a re-send would need a new
//   event id and is out of scope. Audit meta_capi.resolve.
//   200 { event }; 400 { code: 'resolution' }; 404 { code: 'not_found' } (also another
//   workspace's id); 409 { code: 'not_open' } when it is not an unresolved unknown event;
//   503 { error: 'meta_ads_not_enabled' } while the feature is off.

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { getT } from '@/lib/i18n/translate';
import { metaAdsConfig } from '@/lib/meta-ads/config';
import { CapiError, parseResolution, resolveConversionEvent } from '@/lib/meta-ads/capi';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

const NO_STORE = { 'Cache-Control': 'private, no-store' };
type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const ctx = await requireRole('admin');
    const t = getT('Api.metaAds');
    if (!metaAdsConfig()) return NextResponse.json({ error: 'meta_ads_not_enabled', message: t('notEnabled') }, { status: 503, headers: NO_STORE });
    const limit = checkRateLimit(`metaCapi:resolve:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const resolution = parseResolution(await request.json().catch(() => null));
    if (!resolution) return NextResponse.json({ error: t('invalidResolution'), code: 'resolution' }, { status: 400, headers: NO_STORE });
    return NextResponse.json({ event: await resolveConversionEvent(tenantOf(ctx), id, resolution) }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof CapiError) {
      const t = getT('Api.metaAds');
      const message = error.code === 'not_found' ? t('notFound') : t('invalidResolution');
      return NextResponse.json({ error: message, code: error.code }, { status: error.status, headers: NO_STORE });
    }
    return toErrorResponse(error);
  }
}
