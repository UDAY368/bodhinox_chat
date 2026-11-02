// GET /api/commerce/events — store events that need an admin (admins and owners):
//   failed template sends and sends whose outcome is unknown, newest first, up to 100.
//   200 { events: AttentionEvent[] } — a fixed projection, never the event payload.
//   Resolve one with POST /api/commerce/events/{id}/resolve.

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { listAttentionEvents } from '@/lib/commerce/event-attention';

export async function GET() {
  try {
    const ctx = await requireRole('admin');
    return NextResponse.json(await listAttentionEvents(tenantOf(ctx)), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
