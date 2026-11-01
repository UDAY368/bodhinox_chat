// PATCH  /api/segments/[id] — rename or change the filter (agent+)
// DELETE /api/segments/[id] — remove (agent+)
// A foreign or unknown id is a 404.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { audienceError, tenantOf } from '@/lib/audience/http';
import { deleteSegment, updateSegment } from '@/lib/audience/segments';

const notFound = () => NextResponse.json({ error: 'Segment not found' }, { status: 404 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('agent');
    const { id } = await params;
    if (!UUID.test(id)) return notFound();
    const segment = await updateSegment(tenantOf(ctx), id, await request.json().catch(() => null));
    return segment ? NextResponse.json({ segment }) : notFound();
  } catch (err) {
    return audienceError(err);
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('agent');
    const { id } = await params;
    if (!UUID.test(id)) return notFound();
    return (await deleteSegment(tenantOf(ctx), id)) ? NextResponse.json({ success: true }) : notFound();
  } catch (err) {
    return audienceError(err);
  }
}
