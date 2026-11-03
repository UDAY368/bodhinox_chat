// GET /api/meta-ads/conversions?status=queued|sent|failed|unknown|skipped|review (admins and owners)
//   The Conversions API event log, newest first, up to 100. 'review' is the
//   unknown-outcome queue that waits for an admin. Stored data only; a fixed
//   projection that never holds the click id.
//   200 { events }; 400 { code: 'invalid' }; 503 { error: 'meta_ads_not_enabled' } while the feature is off.

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { getT } from '@/lib/i18n/translate';
import { metaAdsConfig } from '@/lib/meta-ads/config';
import { listConversionEvents, parseListFilter } from '@/lib/meta-ads/capi';

const NO_STORE = { 'Cache-Control': 'private, no-store' };

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const t = getT('Api.metaAds');
    if (!metaAdsConfig()) return NextResponse.json({ error: 'meta_ads_not_enabled', message: t('notEnabled') }, { status: 503, headers: NO_STORE });
    const filter = parseListFilter(new URL(request.url).searchParams.get('status'));
    if (filter === undefined) return NextResponse.json({ error: t('invalidRequest'), code: 'invalid' }, { status: 400, headers: NO_STORE });
    return NextResponse.json({ events: await listConversionEvents(tenantOf(ctx), filter) }, { headers: NO_STORE });
  } catch (error) {
    return toErrorResponse(error);
  }
}
