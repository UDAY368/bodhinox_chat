import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Phase 9: meeting_* appointment events are history only. They are never fanned
// out to staff notifications, automations or tenant webhooks, and an
// appointments.event job carrying one (which nothing should queue) is a no-op.
const eventJob = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('./events', async (importOriginal) => ({ ...(await importOriginal<typeof import('./events')>()), handleAppointmentEventJob: eventJob }));
vi.mock('./booking', () => ({ expireHold: vi.fn() }));
vi.mock('./followup', () => ({ handleAppointmentFollowupJob: vi.fn() }));
vi.mock('./notify-customer', () => ({ handleAppointmentNoticeJob: vi.fn(), handleHoldReplyJob: vi.fn() }));
vi.mock('./reminders', () => ({ handleAppointmentReminderJob: vi.fn() }));

import { EVENT_FANOUT } from './events';
import { handleAppointmentJob } from './job-handlers';
import { APPOINTMENT_EVENT_KINDS, APPOINTMENT_JOB_TYPES, HISTORY_ONLY_EVENT_KINDS, isHistoryOnlyEventKind } from './types';

const meta = { attempts: 1, maxAttempts: 5 };

describe('history-only appointment event kinds', () => {
  beforeEach(() => eventJob.mockClear());

  it('are the meeting kinds, all valid event kinds, none with a fan-out', () => {
    expect([...HISTORY_ONLY_EVENT_KINDS].sort()).toEqual(
      ['meeting_created', 'meeting_deleted', 'meeting_joined_provider', 'meeting_sync_failed', 'meeting_updated']);
    for (const kind of HISTORY_ONLY_EVENT_KINDS) {
      expect(APPOINTMENT_EVENT_KINDS).toContain(kind);
      expect(EVENT_FANOUT[kind]).toBeUndefined();
    }
    expect(isHistoryOnlyEventKind('confirmed')).toBe(false);
  });

  it('never reach the fan-out handler', async () => {
    const accountId = randomUUID(), appointmentId = randomUUID();
    for (const kind of HISTORY_ONLY_EVENT_KINDS)
      await handleAppointmentJob(accountId, APPOINTMENT_JOB_TYPES.event, { appointmentId, version: 2, kind }, meta);
    expect(eventJob).not.toHaveBeenCalled();
    await handleAppointmentJob(accountId, APPOINTMENT_JOB_TYPES.event, { appointmentId, version: 2, kind: 'confirmed' }, meta);
    expect(eventJob).toHaveBeenCalledWith(accountId, { appointmentId, version: 2, kind: 'confirmed' });
  });

  it('still refuses an unknown kind', async () => {
    await expect(handleAppointmentJob(randomUUID(), APPOINTMENT_JOB_TYPES.event, { appointmentId: randomUUID(), version: 1, kind: 'meeting_bogus' }, meta))
      .rejects.toThrow(/Invalid appointment job contract/);
  });
});
