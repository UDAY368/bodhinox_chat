// GET /api/meta-ads/leads?formId&adId&from&to&cursor — any member: one page of
// the workspace's Meta leads, newest first. Phone answers are masked for
// members whose numbers are masked. 503 while Meta ads are not enabled.
import { NextResponse } from 'next/server';
import { getCurrentAccount } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { metaAdsConfig } from '@/lib/meta-ads/config';
import { listLeads, parseLeadsFilter } from '@/lib/meta-ads/leads';
import { leadsErrorResponse, NO_STORE, notEnabledResponse } from '@/lib/meta-ads/leads-http';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    if (!metaAdsConfig()) return notEnabledResponse();
    const ctx = await getCurrentAccount();
    const filter = parseLeadsFilter(new URL(request.url).searchParams);
    return NextResponse.json(await listLeads(tenantOf(ctx), filter), { headers: NO_STORE });
  } catch (error) {
    return leadsErrorResponse(error);
  }
}
