// POST /api/platform/billing/refetch (platform admins only, recent MFA, origin checked) -
//   body { accountId, reason? }. Queues the existing billing.lifecycle_sweep for that workspace
//   (fetch the provider's state, then apply it: safe to repeat), audited. 202 { queued: true };
//   404 no_provider_subscription; 503 billing_not_configured without the BILLING_RAZORPAY_* keys.

import { NextResponse } from 'next/server';
import { platformErrorResponse, requirePlatformAdmin } from '@/lib/platform/auth';
import { refetchFromProvider } from '@/lib/platform/billing';

const noStore = { 'Cache-Control': 'no-store' };

export async function POST(request: Request) {
  try {
    const admin = await requirePlatformAdmin(request, { mutation: true });
    const body = await request.json().catch(() => null);
    await refetchFromProvider(admin, body);
    return NextResponse.json({ queued: true }, { status: 202, headers: noStore });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
