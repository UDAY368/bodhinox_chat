import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  reminder: vi.fn(), notice: vi.fn(), holdReply: vi.fn(), event: vi.fn(), followup: vi.fn(), expire: vi.fn(),
}));
vi.mock('./reminders', () => ({ handleAppointmentReminderJob: h.reminder }));
vi.mock('./notify-customer', () => ({ handleAppointmentNoticeJob: h.notice, handleHoldReplyJob: h.holdReply }));
vi.mock('./events', () => ({ handleAppointmentEventJob: h.event }));
vi.mock('./followup', () => ({ handleAppointmentFollowupJob: h.followup }));
vi.mock('./booking', () => ({ expireHold: h.expire }));
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => 'worker' }));
vi.mock('@/lib/db/tenant', () => ({ withTenant: async (_c: unknown, op: (tx: unknown) => unknown) => op('tx') }));

import { handleAppointmentJob } from './job-handlers';

const acct = '00000000-0000-4000-8000-0000000000aa';
const appt = '00000000-0000-4000-8000-000000000001';
const meta = { attempts: 1, maxAttempts: 5 };

beforeEach(() => vi.clearAllMocks());

describe('handleAppointmentJob', () => {
  it('delegates each job type with a validated payload', async () => {
    await handleAppointmentJob(acct, 'appointments.reminder', { appointmentId: appt, version: 2, kind: '24h' }, meta);
    expect(h.reminder).toHaveBeenCalledWith(acct, { appointmentId: appt, version: 2, kind: '24h' });
    await handleAppointmentJob(acct, 'appointments.notify', { appointmentId: appt, version: 1, kind: 'cancelled' }, meta);
    expect(h.notice).toHaveBeenCalledWith(acct, { appointmentId: appt, version: 1, kind: 'cancelled' });
    await handleAppointmentJob(acct, 'appointments.notify', { kind: 'hold_reply', contactId: appt, messageId: appt, reason: 'code_unknown' }, meta);
    expect(h.holdReply).toHaveBeenCalledWith(acct, { kind: 'hold_reply', contactId: appt, messageId: appt, reason: 'code_unknown' });
    await handleAppointmentJob(acct, 'appointments.event', { appointmentId: appt, version: 3, kind: 'rescheduled' }, meta);
    expect(h.event).toHaveBeenCalledWith(acct, { appointmentId: appt, version: 3, kind: 'rescheduled' });
    await handleAppointmentJob(acct, 'appointments.hold_expire', { appointmentId: appt, version: 1 }, meta);
    expect(h.expire).toHaveBeenCalledWith('tx', { accountId: acct, appointmentId: appt, version: 1 });
    await handleAppointmentJob(acct, 'appointments.followup', { appointmentId: appt, version: 4, kind: 'feedback' }, meta);
    expect(h.followup).toHaveBeenCalledWith(acct, { appointmentId: appt, version: 4, kind: 'feedback' });
  });

  it('refuses a malformed contract instead of guessing', async () => {
    for (const [type, payload] of [
      ['appointments.reminder', { appointmentId: 'x', version: 1, kind: '24h' }],
      ['appointments.reminder', { appointmentId: appt, version: 0, kind: '24h' }],
      ['appointments.reminder', { appointmentId: appt, version: 1, kind: '1h' }],
      ['appointments.notify', { kind: 'hold_reply', contactId: appt, messageId: appt, reason: 'other' }],
      ['appointments.event', { appointmentId: appt, version: 1, kind: 'deleted' }],
      ['appointments.followup', { appointmentId: appt, version: 1.5, kind: 'feedback' }],
    ] as const) await expect(handleAppointmentJob(acct, type, payload as Record<string, unknown>, meta)).rejects.toThrow(/Invalid appointment job/);
    expect(h.reminder).not.toHaveBeenCalled();
  });
});
