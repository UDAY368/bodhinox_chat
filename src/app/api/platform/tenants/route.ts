// GET /api/platform/tenants?search=&cursor=&limit= (platform admins only; 404 for everyone else and
//   without PLATFORM_DATABASE_URL) - 200 { tenants, nextCursor }. Ids, names, owner email, plan,
//   statuses, member counts and stored usage counters only.

import { NextResponse } from 'next/server';
import { platformErrorResponse, requirePlatformAdmin } from '@/lib/platform/auth';
import { listTenants, parsePageQuery } from '@/lib/platform/tenants';

const noStore = { 'Cache-Control': 'no-store' };

export async function GET(request: Request) {
  try {
    await requirePlatformAdmin(request);
    const params = new URL(request.url).searchParams;
    const page = parsePageQuery(params);
    if (!page) return NextResponse.json({ error: 'invalid', code: 'invalid' }, { status: 400, headers: noStore });
    return NextResponse.json(await listTenants({ search: params.get('search'), ...page }), { headers: noStore });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
