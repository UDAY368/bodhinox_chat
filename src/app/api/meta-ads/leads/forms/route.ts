// GET /api/meta-ads/leads/forms — any member: lead forms for the leads filter.
import { NextResponse } from 'next/server';
import { getCurrentAccount } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { metaAdsConfig } from '@/lib/meta-ads/config';
import { listLeadFormOptions } from '@/lib/meta-ads/leads';
import { leadsErrorResponse, NO_STORE, notEnabledResponse } from '@/lib/meta-ads/leads-http';

export const runtime = 'nodejs';

export async function GET() {
  try {
    if (!metaAdsConfig()) return notEnabledResponse();
    const ctx = await getCurrentAccount();
    return NextResponse.json({ forms: await listLeadFormOptions(tenantOf(ctx)) }, { headers: NO_STORE });
  } catch (error) {
    return leadsErrorResponse(error);
  }
}
