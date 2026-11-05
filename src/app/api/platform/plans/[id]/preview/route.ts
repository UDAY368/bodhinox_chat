// POST /api/platform/plans/{id}/preview (platform admins only) - body { features, limits }
//   (the whole draft: a missing feature is off, a missing limit unlimited). 200 PlanPreview:
//   each tightened limit with how many workspaces on the live terms are already over it, and
//   the preview_hash a publish of the same draft must echo. Changes nothing (POST only because
//   the draft is a body). 400 invalid_plan_terms, 403 plan_locked (enterprise), 404 unknown_plan.

import { NextResponse } from 'next/server';
import { platformErrorResponse, requirePlatformAdmin } from '@/lib/platform/auth';
import { previewPlan } from '@/lib/platform/plans';

const noStore = { 'Cache-Control': 'no-store' };

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requirePlatformAdmin(request, { mutation: true });
    const { id } = await context.params;
    const body = await request.json().catch(() => null);
    return NextResponse.json(await previewPlan(id, body), { headers: noStore });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
