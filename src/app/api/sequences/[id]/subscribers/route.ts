// GET  /api/sequences/:id/subscribers — up to 200 subscribers, running ones first (any member).
//   200 { subscribers: SequenceSubscriber[] }
// POST /api/sequences/:id/subscribers — { action: 'subscribe' | 'unsubscribe', contact_id } (agent or above).
//   200 { status: 'subscribed' | 'already_subscribed' | 'unavailable' | 'unsubscribed' | 'not_subscribed' }.
//   Unsubscribing stops the sequence for the contact at once.
// 404 notFound for another workspace's sequence or contact.
import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import {
  changeSubscriber,
  listSubscribers,
  parseSubscriberAction,
  requireInstagram,
  sequenceErrorResponse,
  sequenceHeaders,
  SEQUENCE_WRITE_LIMIT,
} from '@/lib/sequences/store';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const ctx = await requireRole('viewer');
    requireInstagram();
    return NextResponse.json({ subscribers: await listSubscribers(tenantOf(ctx), id) }, { headers: sequenceHeaders });
  } catch (error) {
    return sequenceErrorResponse(error);
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const ctx = await requireRole('agent');
    requireInstagram();
    const limit = checkRateLimit(`sequences:write:${ctx.userId}`, SEQUENCE_WRITE_LIMIT);
    if (!limit.success) return rateLimitResponse(limit);
    const input = parseSubscriberAction(await request.json().catch(() => null));
    return NextResponse.json(await changeSubscriber(tenantOf(ctx), id, input), { headers: sequenceHeaders });
  } catch (error) {
    return sequenceErrorResponse(error);
  }
}
