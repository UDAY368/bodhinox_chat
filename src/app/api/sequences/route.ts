// GET  /api/sequences — the workspace's sequences with subscribers, messages, open rate and CTR (any member).
//   WhatsApp sequences always; Instagram ones while Instagram is on.
//   200 { sequences: SequenceSummary[] }
// POST /api/sequences — { name, channel?: 'instagram' | 'whatsapp' } (agent or above; default instagram).
//   201 { sequence }; 400 invalid_request; 503 instagram_not_enabled for an Instagram one while Instagram is off.
import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import {
  createSequence,
  listSequences,
  parseChannel,
  parseName,
  sequenceErrorResponse,
  sequenceHeaders,
  SEQUENCE_WRITE_LIMIT,
} from '@/lib/sequences/store';

export async function GET() {
  try {
    const ctx = await requireRole('viewer');
    return NextResponse.json({ sequences: await listSequences(tenantOf(ctx)) }, { headers: sequenceHeaders });
  } catch (error) {
    return sequenceErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const limit = await checkRateLimit(`sequences:write:${ctx.userId}`, SEQUENCE_WRITE_LIMIT);
    if (!limit.success) return rateLimitResponse(limit);
    const body = (await request.json().catch(() => null)) as { name?: unknown; channel?: unknown } | null;
    const channel = body?.channel === undefined ? 'instagram' : parseChannel(body.channel);
    const sequence = await createSequence(tenantOf(ctx), parseName(body?.name), channel);
    return NextResponse.json({ sequence }, { status: 201, headers: sequenceHeaders });
  } catch (error) {
    return sequenceErrorResponse(error);
  }
}
