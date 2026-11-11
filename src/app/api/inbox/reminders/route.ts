// GET  /api/inbox/reminders?conversation_id=&kind=&status= — the caller's own reminders and snoozes (any member).
//   200 { reminders: ConversationReminder[] } (pending and fired unless status= is given)
// POST /api/inbox/reminders — { conversation_id, remind_at, kind?: 'reminder'|'snooze', note? } (agent or above).
//   201 { reminder }; 400 past | tooFar | invalid_request; 404 notFound.
// Reminders are personal: another member's are never listed.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import {
  createReminder,
  listReminders,
  parseReminderCreate,
  reminderErrorResponse,
  reminderHeaders,
  REMINDER_WRITE_LIMIT,
} from '@/lib/inbox/reminders';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('viewer');
    const params = new URL(request.url).searchParams;
    const reminders = await listReminders(tenantOf(ctx), {
      conversationId: params.get('conversation_id'),
      kind: params.get('kind'),
      status: params.get('status'),
    });
    return NextResponse.json({ reminders }, { headers: reminderHeaders });
  } catch (error) {
    return reminderErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const limit = checkRateLimit(`inbox:reminders:${ctx.userId}`, REMINDER_WRITE_LIMIT);
    if (!limit.success) return rateLimitResponse(limit);
    const input = parseReminderCreate(await request.json().catch(() => null));
    return NextResponse.json({ reminder: await createReminder(tenantOf(ctx), input) }, { status: 201, headers: reminderHeaders });
  } catch (error) {
    return reminderErrorResponse(error);
  }
}
