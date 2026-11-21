// POST /api/broadcasts/[id]/segment { result } — create a saved segment of this campaign's recipients by result
// (read_not_replied | delivered_not_read | failed | clicked). Agent+ (RLS enforces segment writes too).

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { audienceError, tenantOf } from '@/lib/audience/http';
import { createResultSegment } from '@/lib/broadcasts/result-segment';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('agent');
    const { id } = await params;
    if (!UUID.test(id)) return NextResponse.json({ error: 'Campaign unavailable' }, { status: 404 });
    const body = (await request.json().catch(() => null)) as { result?: unknown } | null;
    const segment = await createResultSegment(tenantOf(ctx), id, body?.result);
    return NextResponse.json({ segment: { id: segment.id, name: segment.name } }, { status: 201 });
  } catch (err) {
    return audienceError(err);
  }
}
