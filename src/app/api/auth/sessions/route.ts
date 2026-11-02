import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authError } from '@/lib/auth/http';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { enforceAuthRateLimit } from '@/lib/auth/service';
import {
  listDeviceSessions,
  recordSessionDevice,
  revokeDeviceSession,
  revokeOtherDeviceSessions,
} from '@/lib/auth/device-sessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const noStore = { 'Cache-Control': 'no-store' };

/** GET: the signed-in user's active sessions (device and browser from the User-Agent, no location). */
export async function GET(request: Request) {
  try {
    const context = await requireSession(request);
    await recordSessionDevice(context.sessionId, request.headers.get('user-agent'));
    return NextResponse.json({ sessions: await listDeviceSessions(context) }, { headers: noStore });
  } catch (error) {
    return authError(error);
  }
}

/** DELETE ?id=<session id> ends one other session; DELETE ?scope=others ends every other session. */
export async function DELETE(request: Request) {
  try {
    const context = await requireSession(request);
    await assertMutation(request, context);
    await enforceAuthRateLimit('sessions-revoke', context.userId, 30, 900);
    const params = new URL(request.url).searchParams;
    const query = z
      .union([
        z.object({ id: z.string().uuid() }).strict(),
        z.object({ scope: z.literal('others') }).strict(),
      ])
      .parse(Object.fromEntries(params));
    if ('id' in query) {
      const revoked = await revokeDeviceSession(context, query.id);
      if (!revoked)
        return NextResponse.json(
          { error: { message: 'Session not found', code: 'not_found' } },
          { status: 404, headers: noStore }
        );
      return NextResponse.json({ revoked: 1 }, { headers: noStore });
    }
    return NextResponse.json({ revoked: await revokeOtherDeviceSessions(context) }, { headers: noStore });
  } catch (error) {
    return authError(error);
  }
}
