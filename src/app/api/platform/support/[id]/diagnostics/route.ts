// GET /api/platform/support/:grantId/diagnostics (platform admins only) - 200 { diagnostics } while
//   the caller's grant is approved and unexpired: statuses, counts and error codes for that one
//   workspace (never message bodies, contact fields, secrets or tokens). Each view is logged as
//   support.viewed in both audit trails (at most once per grant per 5 minutes).
//   403 grant_not_active otherwise (not approved, expired, revoked, or another admin's grant).

import { NextResponse } from 'next/server';
import { platformErrorResponse, requirePlatformAdmin } from '@/lib/platform/auth';
import { platformSupportDiagnostics } from '@/lib/platform/db';
import { isUuid } from '@/lib/platform/tenants';

const noStore = { 'Cache-Control': 'no-store' };

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requirePlatformAdmin(request);
    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: 'grant_not_active', code: 'grant_not_active' }, { status: 403, headers: noStore });
    return NextResponse.json({ diagnostics: await platformSupportDiagnostics(id.toLowerCase(), admin.email) }, { headers: noStore });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
