// PATCH /api/inbox/reminders/:id — { status: 'dismissed' | 'cancelled' } or { remind_at?, note? } (agent or above).
//   200 { reminder }; 400 invalid_request | past | tooFar; 404 notFound (not the caller's row, or already decided).
// Only the member who owns a reminder can change it; another member's id is a 404.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import {
  parseReminderPatch,
  reminderErrorResponse,
  reminderHeaders,
  REMINDER_WRITE_LIMIT,
  updateReminder,
} from '@/lib/inbox/reminders';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const ctx = await requireRole('agent');
    const limit = checkRateLimit(`inbox:reminders:${ctx.userId}`, REMINDER_WRITE_LIMIT);
    if (!limit.success) return rateLimitResponse(limit);
    const patch = parseReminderPatch(await request.json().catch(() => null));
    return NextResponse.json({ reminder: await updateReminder(tenantOf(ctx), id, patch) }, { headers: reminderHeaders });
  } catch (error) {
    return reminderErrorResponse(error);
  }
}
