// GET /api/platform/plans/{id} (platform admins only) - 200 { plan, versions }: the plan
//   and its published versions, newest first.

import { NextResponse } from 'next/server';
import { platformErrorResponse, requirePlatformAdmin } from '@/lib/platform/auth';
import { planDetail } from '@/lib/platform/plans';

const noStore = { 'Cache-Control': 'no-store' };

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requirePlatformAdmin(request);
    const { id } = await context.params;
    return NextResponse.json(await planDetail(id), { headers: noStore });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
