// POST /api/platform/plans/{id}/publish (platform admins only, recent MFA, origin checked) -
//   body { features, limits, note?, previewHash }. Publishes the draft as the plan's next
//   version and makes it the live row, in one audited database call. Subscribers stay on the
//   version they are pinned to. 200 { version }; 400 invalid_plan_terms / invalid_request,
//   403 plan_locked, 404 unknown_plan, 409 preview_mismatch (preview again).

import { NextResponse } from 'next/server';
import { platformErrorResponse, requirePlatformAdmin } from '@/lib/platform/auth';
import { publishPlan } from '@/lib/platform/plans';

const noStore = { 'Cache-Control': 'no-store' };

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requirePlatformAdmin(request, { mutation: true });
    const { id } = await context.params;
    const body = await request.json().catch(() => null);
    return NextResponse.json(await publishPlan(admin, id, body), { headers: noStore });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
