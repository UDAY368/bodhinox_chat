// GET /api/contacts/[id]/timeline?cursor= (any member) — the contact's events from the event feed,
// newest first, 30 at a time (src/lib/events/timeline.ts). 200 { events, next_cursor }; a viewer
// gets no order or payment events. 400 invalid_cursor; another workspace's contact is 404.
import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { UUID_RE } from '@/lib/contacts/profile';
import { contactTimeline, TimelineCursorError } from '@/lib/events/timeline';

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    const cursor = new URL(request.url).searchParams.get('cursor');
    const page = await contactTimeline(tenantOf(ctx), id, cursor);
    if (!page) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json(page, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    if (error instanceof TimelineCursorError) return NextResponse.json({ error: 'invalid_cursor', code: 'invalid_cursor' }, { status: 400 });
    return toErrorResponse(error);
  }
}
