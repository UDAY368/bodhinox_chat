// GET /api/platform/plans (platform admins only; 404 for everyone else and without
//   PLATFORM_DATABASE_URL) - 200 { plans, prices, billingConfigured }: each plan's live
//   terms, current version, subscriber and pinned-to-older counts, and every price row
//   (active and retired). Prices are edited through PUT /api/billing/admin/prices.

import { NextResponse } from 'next/server';
import { platformErrorResponse, requirePlatformAdmin } from '@/lib/platform/auth';
import { planCatalogue } from '@/lib/platform/plans';

const noStore = { 'Cache-Control': 'no-store' };

export async function GET(request: Request) {
  try {
    await requirePlatformAdmin(request);
    return NextResponse.json(await planCatalogue(), { headers: noStore });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
