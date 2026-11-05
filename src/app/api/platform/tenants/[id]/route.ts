// GET /api/platform/tenants/:id (platform admins only) - 200 { tenant }: subscription, lifecycle,
//   members by role, stored usage, open reconciliation items and recent support grants; 404 unknown.

import { NextResponse } from 'next/server';
import { platformErrorResponse, requirePlatformAdmin } from '@/lib/platform/auth';
import { getTenant } from '@/lib/platform/tenants';

const noStore = { 'Cache-Control': 'no-store' };

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requirePlatformAdmin(request);
    const tenant = await getTenant((await params).id);
    if (!tenant) return NextResponse.json({ error: 'not_found', code: 'not_found' }, { status: 404, headers: noStore });
    return NextResponse.json({ tenant }, { headers: noStore });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
