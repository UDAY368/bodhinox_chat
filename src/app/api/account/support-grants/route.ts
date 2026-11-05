// GET /api/account/support-grants (owners and admins) - 200 { grants }: Bodhinox support's
//   diagnostics requests and grants for this workspace, newest first.
// POST /api/account/support-grants (owners and admins) - { email, reason (10..1000), minutes (15..1440) }:
//   grants diagnostics access proactively to a named Bodhinox platform admin (the email must be on the
//   platform allowlist). Audited as support.approved. 201 { grant }; 400 invalid (the same answer whatever the email, so the platform allowlist cannot be probed);
//   409 grant_open (that admin already has an open request or grant).
// Support sees statuses, counts and error codes only: never messages, contacts or secrets.
// Session and CSRF are enforced by the proxy; the workspace comes from the session.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { createProactiveGrant, listSupportGrants, parseProactiveGrant, supportErrorResponse } from '@/lib/platform/support';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

const noStore = { 'Cache-Control': 'private, no-store' };

export async function GET() {
  try {
    const ctx = await requireRole('admin');
    const grants = await withTenant(tenantOf(ctx), (tx) => listSupportGrants(tx, ctx.accountId));
    return NextResponse.json({ grants }, { headers: noStore });
  } catch (error) {
    return supportErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`support-grants:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const input = parseProactiveGrant(await request.json().catch(() => null));
    if (!input) return NextResponse.json({ error: 'invalid', code: 'invalid' }, { status: 400, headers: noStore });
    const grant = await withTenant(tenantOf(ctx), (tx) =>
      createProactiveGrant(tx, { accountId: ctx.accountId, userId: ctx.userId }, input));
    return NextResponse.json({ grant }, { status: 201, headers: noStore });
  } catch (error) {
    return supportErrorResponse(error);
  }
}
