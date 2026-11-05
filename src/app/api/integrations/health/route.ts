// GET /api/integrations/health (any workspace member) - 200 { integrations }: one row per connected
//   integration (WhatsApp numbers, Instagram, Meta Ads, Shopify, WooCommerce, meetings, courier,
//   Razorpay payments) with its stored status, health state, last success, last error code and the
//   settings section that fixes it. Read from stored status columns only: no provider call runs on
//   load. Never tokens, secrets or key ids. The workspace comes from the session (withTenant).

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { loadIntegrationHealth } from '@/lib/platform/health';

export async function GET() {
  try {
    const ctx = await requireRole('viewer');
    const integrations = await withTenant(tenantOf(ctx), (tx) => loadIntegrationHealth(tx, ctx.accountId));
    return NextResponse.json({ integrations }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
