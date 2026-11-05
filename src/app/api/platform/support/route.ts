// GET /api/platform/support?accountId= (platform admins only) - 200 { grants }: the caller's own
//   support requests and grants, newest first.
// POST /api/platform/support (MFA-recent, CSRF-checked) - { accountId, reason (10..1000),
//   minutes (15..1440) }: asks the workspace for diagnostics access; its owners and admins are
//   notified and decide in Settings. 201 { id }; 400 invalid; 404 unknown workspace; 409 an open
//   request or grant already exists for this admin.

import { NextResponse } from 'next/server';
import { platformErrorResponse, requirePlatformAdmin } from '@/lib/platform/auth';
import { platformSupportGrants, platformSupportRequest } from '@/lib/platform/db';
import { parseSupportRequest } from '@/lib/platform/support';
import { isUuid } from '@/lib/platform/tenants';

const noStore = { 'Cache-Control': 'no-store' };

export async function GET(request: Request) {
  try {
    const admin = await requirePlatformAdmin(request);
    const accountId = new URL(request.url).searchParams.get('accountId') || null;
    if (accountId !== null && !isUuid(accountId))
      return NextResponse.json({ error: 'invalid', code: 'invalid' }, { status: 400, headers: noStore });
    return NextResponse.json({ grants: await platformSupportGrants(admin.email, accountId?.toLowerCase() ?? null) }, { headers: noStore });
  } catch (error) {
    return platformErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const admin = await requirePlatformAdmin(request, { mutation: true });
    const input = parseSupportRequest(await request.json().catch(() => null));
    if (!input) return NextResponse.json({ error: 'invalid', code: 'invalid' }, { status: 400, headers: noStore });
    const id = await platformSupportRequest({ ...input, adminEmail: admin.email });
    return NextResponse.json({ id }, { status: 201, headers: noStore });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
