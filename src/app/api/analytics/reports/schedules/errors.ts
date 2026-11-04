import { NextResponse } from 'next/server';

import { ScheduleError } from '@/lib/analytics/report-schedules';
import { getT } from '@/lib/i18n/translate';

const t = getT('Validation.analytics');

const MESSAGES = {
  invalid: 'invalidSchedule',
  invalid_recipients: 'invalidRecipients',
  not_found: 'scheduleNotFound',
  too_many: 'tooManySchedules',
  creator_lost_access: 'scheduleCreatorLostAccess',
} as const;

/** Maps a ScheduleError (or the 'invalid' shorthand) to its translated response; rethrows anything else. */
export function scheduleErrorResponse(error: unknown): NextResponse {
  const scheduleError = error === 'invalid' ? new ScheduleError('invalid', 400) : error;
  if (!(scheduleError instanceof ScheduleError)) throw error;
  return NextResponse.json({ error: t(MESSAGES[scheduleError.code]) }, { status: scheduleError.status });
}
