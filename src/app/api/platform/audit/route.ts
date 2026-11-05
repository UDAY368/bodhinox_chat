// GET /api/platform/audit?accountId=&cursor=&limit= (platform admins only) - 200 { entries, nextCursor }:
//   the append-only platform audit trail, newest first, optionally for one workspace.

import { NextResponse } from 'next/server';
import { platformErrorResponse, requirePlatformAdmin } from '@/lib/platform/auth';
import { platformAuditList } from '@/lib/platform/db';
import { isUuid, parsePageQuery } from '@/lib/platform/tenants';

const noStore = { 'Cache-Control': 'no-store' };

export async function GET(request: Request) {
  try {
    await requirePlatformAdmin(request);
    const params = new URL(request.url).searchParams;
    const page = parsePageQuery(params);
    const accountId = params.get('accountId') || null;
    if (!page || (accountId !== null && !isUuid(accountId)))
      return NextResponse.json({ error: 'invalid', code: 'invalid' }, { status: 400, headers: noStore });
    const entries = await platformAuditList({ accountId: accountId?.toLowerCase() ?? null, cursor: page.cursor, limit: page.limit });
    const nextCursor = entries.length === page.limit ? entries[entries.length - 1].createdAt : null;
    return NextResponse.json({ entries, nextCursor }, { headers: noStore });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
