// /api/integrations/zoom — the workspace's Zoom connection (Phase 9, design §4).
//   GET     any member: { available, connected, status, register_attendees, last_error_code, connected_at }.
//           available=false when this deployment has no Zoom app configuration. Never a token.
//   PATCH   { register_attendees: boolean } admin + integrations.meetings; 503 not_configured.
//   DELETE  admin + integrations.meetings: revoke (best effort), clear the tokens, detach live
//           meetings, audit. Allowed without deployment config so stored tokens can always be
//           cleared (no Zoom call then).
// Mutations need the session's Origin + CSRF proof.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireSession } from '@/lib/auth/session';
import { zoomConfig } from '@/lib/meetings/config';
import { disconnectZoom, getMeetingConnection, setRegisterAttendees } from '@/lib/meetings/connection';
import { actorOf, adminMutation, meetingErrorResponse, NO_STORE, zoomRouteError } from './_lib/http';

export const runtime = 'nodejs';

const Settings = z.object({ register_attendees: z.boolean() }).strict();

export async function GET(request: Request) {
  try {
    const session = await requireSession(request);
    return NextResponse.json(await getMeetingConnection(actorOf(session)), { headers: NO_STORE });
  } catch (error) {
    return zoomRouteError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    if (!zoomConfig()) return meetingErrorResponse('not_configured');
    const session = await adminMutation(request);
    if (session instanceof NextResponse) return session;
    const body = Settings.safeParse(await request.json().catch(() => null));
    if (!body.success) return NextResponse.json({ error: 'invalid_request', code: 'invalid_request' }, { status: 400, headers: NO_STORE });
    return NextResponse.json(await setRegisterAttendees(actorOf(session), body.data.register_attendees), { headers: NO_STORE });
  } catch (error) {
    return zoomRouteError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const session = await adminMutation(request);
    if (session instanceof NextResponse) return session;
    await disconnectZoom(session.accountId, session.userId, 'admin');
    return NextResponse.json(await getMeetingConnection(actorOf(session)), { headers: NO_STORE });
  } catch (error) {
    return zoomRouteError(error);
  }
}
