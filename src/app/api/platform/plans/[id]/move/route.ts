// POST /api/platform/plans/{id}/move (platform admins only, recent MFA, origin checked) -
//   body { reason (10-500 chars), version }. Moves every subscriber of the plan to its current
//   version (which must equal `version`), audited; workspaces then over a limit have the extra
//   segments, lists, flows and automations archived (never deleted). Never automatic.
//   200 { version, moved, archivedWorkspaces, failedAccounts }; 400 reason_required,
//   404 unknown_plan, 409 stale_version.

import { NextResponse } from 'next/server';
import { platformErrorResponse, requirePlatformAdmin } from '@/lib/platform/auth';
import { moveSubscribers } from '@/lib/platform/plans';

const noStore = { 'Cache-Control': 'no-store' };

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requirePlatformAdmin(request, { mutation: true });
    const { id } = await context.params;
    const body = await request.json().catch(() => null);
    return NextResponse.json(await moveSubscribers(admin, id, body), { headers: noStore });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
