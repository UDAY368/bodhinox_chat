// GET    /api/sequences/:id — the sequence and its messages in order, with Sent, Clicks, Open rate and CTR (any member).
// PATCH  /api/sequences/:id — { name?, status?: 'active' | 'paused' } (agent or above).
// DELETE /api/sequences/:id — archive: it leaves the list and every subscription ends at once (agent or above).
// 404 notFound for another workspace's sequence; 503 instagram_not_enabled while Instagram is off.
import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import {
  archiveSequence,
  getSequence,
  parseSequencePatch,
  requireInstagram,
  sequenceErrorResponse,
  sequenceHeaders,
  SEQUENCE_WRITE_LIMIT,
  updateSequence,
} from '@/lib/sequences/store';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const ctx = await requireRole('viewer');
    requireInstagram();
    return NextResponse.json({ sequence: await getSequence(tenantOf(ctx), id) }, { headers: sequenceHeaders });
  } catch (error) {
    return sequenceErrorResponse(error);
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const ctx = await requireRole('agent');
    requireInstagram();
    const limit = checkRateLimit(`sequences:write:${ctx.userId}`, SEQUENCE_WRITE_LIMIT);
    if (!limit.success) return rateLimitResponse(limit);
    const patch = parseSequencePatch(await request.json().catch(() => null));
    return NextResponse.json({ sequence: await updateSequence(tenantOf(ctx), id, patch) }, { headers: sequenceHeaders });
  } catch (error) {
    return sequenceErrorResponse(error);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const ctx = await requireRole('agent');
    requireInstagram();
    await archiveSequence(tenantOf(ctx), id);
    return NextResponse.json({ archived: true }, { headers: sequenceHeaders });
  } catch (error) {
    return sequenceErrorResponse(error);
  }
}
