// GET  /api/sequences — the workspace's Instagram sequences with subscribers, messages, open rate and CTR (any member).
//   200 { sequences: SequenceSummary[] }
// POST /api/sequences — { name } (agent or above). 201 { sequence }; 400 invalid_request.
// Both 503 instagram_not_enabled while Instagram is off.
import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import {
  createSequence,
  listSequences,
  parseName,
  requireInstagram,
  sequenceErrorResponse,
  sequenceHeaders,
  SEQUENCE_WRITE_LIMIT,
} from '@/lib/sequences/store';

export async function GET() {
  try {
    const ctx = await requireRole('viewer');
    requireInstagram();
    return NextResponse.json({ sequences: await listSequences(tenantOf(ctx)) }, { headers: sequenceHeaders });
  } catch (error) {
    return sequenceErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    requireInstagram();
    const limit = checkRateLimit(`sequences:write:${ctx.userId}`, SEQUENCE_WRITE_LIMIT);
    if (!limit.success) return rateLimitResponse(limit);
    const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
    const sequence = await createSequence(tenantOf(ctx), parseName(body?.name));
    return NextResponse.json({ sequence }, { status: 201, headers: sequenceHeaders });
  } catch (error) {
    return sequenceErrorResponse(error);
  }
}
