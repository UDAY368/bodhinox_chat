// POST /api/broadcasts/[id]/pause — pause a sending campaign (agent+ with campaigns.send).
// The rest stays pending; Resume (/api/whatsapp/broadcast/[id]/resume) continues it.

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { requirePermission } from '@/lib/auth/permissions';
import { pauseBroadcast } from '@/lib/broadcasts/pause';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('agent');
    await requirePermission(tenantOf(ctx), 'campaigns.send');
    const { id } = await params;
    if (!UUID.test(id)) return NextResponse.json({ error: 'Broadcast unavailable' }, { status: 404 });
    if (await pauseBroadcast(tenantOf(ctx), id)) return NextResponse.json({ success: true, status: 'paused' });
    return NextResponse.json({ error: 'Only a sending campaign can be paused' }, { status: 409 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
