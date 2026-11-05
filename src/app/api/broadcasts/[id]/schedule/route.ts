// PATCH  /api/broadcasts/[id]/schedule { scheduledAt } — move a scheduled campaign (agent+ with campaigns.send)
// DELETE /api/broadcasts/[id]/schedule — cancel it before it starts (agent+ with campaigns.send)

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { requirePermission } from '@/lib/auth/permissions';
import { cancelScheduledBroadcast, rescheduleBroadcast } from '@/lib/broadcasts/schedule';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const notFound = () => NextResponse.json({ error: 'Broadcast unavailable' }, { status: 404 });

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('agent');
    await requirePermission(tenantOf(ctx), 'campaigns.send');
    const { id } = await params;
    if (!UUID.test(id)) return notFound();
    const body = (await request.json().catch(() => null)) as { scheduledAt?: unknown } | null;
    await rescheduleBroadcast(tenantOf(ctx), id, body?.scheduledAt);
    return NextResponse.json({ success: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('agent');
    await requirePermission(tenantOf(ctx), 'campaigns.send');
    const { id } = await params;
    if (!UUID.test(id)) return notFound();
    if (await cancelScheduledBroadcast(tenantOf(ctx), id)) return NextResponse.json({ success: true });
    return NextResponse.json({ error: 'Only scheduled campaigns can be cancelled' }, { status: 409 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
