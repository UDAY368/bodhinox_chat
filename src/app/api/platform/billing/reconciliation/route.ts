// GET /api/platform/billing/reconciliation?status=open|resolved|all&cursor=<ISO>&limit=<1-100>
//   (platform admins only) - 200 { items, nextCursor }: SaaS billing items that need an
//   operator (ids, statuses, plan ids and amounts only), newest first.

import { NextResponse } from 'next/server';
import { platformErrorResponse, requirePlatformAdmin } from '@/lib/platform/auth';
import { listReconciliation } from '@/lib/platform/billing';

const noStore = { 'Cache-Control': 'no-store' };

export async function GET(request: Request) {
  try {
    await requirePlatformAdmin(request);
    return NextResponse.json(await listReconciliation(new URL(request.url).searchParams), { headers: noStore });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
