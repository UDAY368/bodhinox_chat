// PATCH  /api/inbox/labels/:id (agents and above) — rename or recolour { name?, color? }:
//   200 { label }; 400 invalid_name | invalid_color; 404 not in this workspace; 409 name_taken.
// DELETE /api/inbox/labels/:id (agents and above) — removes it from every conversation:
//   200 { ok: true }; 404 not in this workspace.
// Another workspace's label id is a 404. CSRF/mutation origin is enforced by src/proxy.ts.
import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { deleteLabel, LABEL_WRITE_LIMIT, labelErrorResponse, parseLabelPatch, updateLabel } from '@/lib/inbox/labels';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const ctx = await requireRole('agent');
    const limit = checkRateLimit(`inbox:labels:${ctx.userId}`, LABEL_WRITE_LIMIT);
    if (!limit.success) return rateLimitResponse(limit);
    const patch = parseLabelPatch(await request.json().catch(() => null));
    return NextResponse.json({ label: await updateLabel(tenantOf(ctx), id, patch) });
  } catch (error) {
    return labelErrorResponse(error);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const ctx = await requireRole('agent');
    const limit = checkRateLimit(`inbox:labels:${ctx.userId}`, LABEL_WRITE_LIMIT);
    if (!limit.success) return rateLimitResponse(limit);
    await deleteLabel(tenantOf(ctx), id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return labelErrorResponse(error);
  }
}
