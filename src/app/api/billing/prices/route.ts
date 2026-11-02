// GET /api/billing/prices — active plan prices (any signed-in member). Amounts are
// paise excluding GST; provider plan ids stay server-side.

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { listPlanPrices } from '@/lib/billing/prices';
import { billingConfigured } from '@/lib/billing/razorpay-billing';

export async function GET() {
  try {
    await getCurrentAccount();
    return NextResponse.json(
      { configured: billingConfigured(), prices: await listPlanPrices() },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
