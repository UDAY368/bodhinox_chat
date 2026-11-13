// GET /api/account/workspace — the workspace name and default language. Any member.
//   200 { workspace: { name, default_language }, can_edit }
// PUT /api/account/workspace — { name?, default_language? }. Owners and admins.
//   200 { workspace }; 400 { error, code }.
// Time zone and working hours live in /api/inbox/settings; this route never stores them.

import { NextResponse } from 'next/server';

import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import { tenantOf } from '@/lib/audience/http';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import {
  getWorkspaceSettings,
  parseWorkspaceUpdate,
  saveWorkspaceSettings,
  WorkspaceSettingsError,
} from '@/lib/settings/workspace-settings';

const PRIVATE = { 'Cache-Control': 'private, no-store' };

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const workspace = await getWorkspaceSettings(tenantOf(ctx));
    return NextResponse.json({ workspace, can_edit: hasMinRole(ctx.role, 'admin') }, { headers: PRIVATE });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`admin:workspace:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const update = parseWorkspaceUpdate(await request.json().catch(() => null));
    const workspace = await saveWorkspaceSettings(tenantOf(ctx), update);
    return NextResponse.json({ workspace }, { headers: PRIVATE });
  } catch (error) {
    if (error instanceof WorkspaceSettingsError) return NextResponse.json({ error: error.code, code: error.code }, { status: 400 });
    return toErrorResponse(error);
  }
}
