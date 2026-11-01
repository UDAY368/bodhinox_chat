// GET /api/account/plan — the workspace's plan, what it includes and current usage (any member).

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { getEntitlements } from '@/lib/billing/entitlements';
import { currentUsage } from '@/lib/billing/usage';

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const body = await withTenant(tenantOf(ctx), async (tx) => ({
      ...(await getEntitlements(tx, ctx.accountId)),
      usage: await currentUsage(tx, ctx.accountId),
    }));
    return NextResponse.json(body, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
