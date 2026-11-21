// POST /api/broadcasts/[id]/cancel-remaining — stop a sending or paused campaign for good (agent+ with campaigns.send,
// like Pause). Unsent recipients become Cancelled; any with an open send intent stay for reconciliation.

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { requirePermission } from '@/lib/auth/permissions';
import { cancelRemainingBroadcast } from '@/lib/broadcasts/pause';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('agent');
    await requirePermission(tenantOf(ctx), 'campaigns.send');
    const { id } = await params;
    if (!UUID.test(id)) return NextResponse.json({ error: 'Broadcast unavailable' }, { status: 404 });
    const result = await cancelRemainingBroadcast(tenantOf(ctx), id);
    if (result) return NextResponse.json({ success: true, status: 'cancelled', ...result });
    return NextResponse.json({ error: 'Only a sending or paused campaign can be cancelled', code: 'not_cancellable' }, { status: 409 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
