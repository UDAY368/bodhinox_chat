import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppointmentRow } from './types';

const h = vi.hoisted(() => ({
  row: null as unknown, event: null as unknown, emit: vi.fn(), automations: vi.fn(), notify: vi.fn(),
}));
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => 'worker' }));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (_c: unknown, op: (tx: unknown) => unknown) => op({
    $executeRaw: async () => 0,
    $queryRaw: async (strings: TemplateStringsArray) =>
      (strings.join('').includes('appointment_events') ? [h.event] : []),
  }),
}));
vi.mock('@/lib/jobs/dispatch', () => ({ dispatchOnce: async (_a: string, _k: string, send: () => unknown) => send() }));
vi.mock('@/lib/automations/engine', () => ({ runAutomationsForTrigger: h.automations }));
vi.mock('@/lib/i18n/translate', () => ({ getT: () => (key: string) => key }));
vi.mock('@/lib/inbox/notify', () => ({ createNotification: h.notify, MAX_NOTIFICATION_RECIPIENTS: 10 }));
vi.mock('@/lib/webhooks/appointment-events', async (orig) => ({
  ...(await orig<typeof import('@/lib/webhooks/appointment-events')>()), emitAppointmentWebhook: h.emit,
}));
vi.mock('./availability', () => ({ loadSettings: async () => ({ staff_notify: false }) }));
vi.mock('./booking', () => ({ getAppointment: async () => h.row }));
vi.mock('./customer-send', () => ({ formatAppointmentTime: (d: Date) => d.toISOString() }));

import { eventSnapshot, handleAppointmentEventJob } from './events';

const acct = '00000000-0000-4000-8000-0000000000aa';
const v1Start = new Date('2026-12-03T05:30:00Z'); // 11:00 in Kolkata
const v2Start = new Date('2026-12-04T19:00:00Z'); // 00:30 on 12-05 in Kolkata
const v3Start = new Date('2026-12-06T07:30:00Z');
// The row after a reschedule to v3Start (v3) and a cancellation (v4).
const current: AppointmentRow = {
  id: '00000000-0000-4000-8000-000000000001', contact_id: null, service_id: 's1', staff_id: 'st2', location_id: 'l1',
  start_at: v3Start, end_at: new Date(v3Start.getTime() + 1_800_000), timezone: 'Asia/Kolkata', local_date: '2026-12-06',
  status: 'cancelled', version: 4, source: 'staff', source_ref: null, booking_page_id: null, hold_expires_at: null, hold_code: null,
  confirmed_at: v1Start, price_minor: null, currency: null, meeting_url: null, service_name: 'Consult', token_epoch: 1,
  cancel_reason: 'staff', outcome_note: null, feedback_score: null, created_by: null, created_at: v1Start, updated_at: v1Start,
};

beforeEach(() => { vi.clearAllMocks(); h.row = current; });

describe('eventSnapshot', () => {
  it('describes the event version: its number, status, start time and the same duration', () => {
    const snap = eventSnapshot(current, 2, 'rescheduled', v2Start);
    expect(snap).toMatchObject({ version: 2, status: 'confirmed', start_at: v2Start, local_date: '2026-12-05' });
    expect(snap.end_at.getTime() - snap.start_at.getTime()).toBe(1_800_000);
  });

  it('keeps the current times when the event recorded none', () => {
    expect(eventSnapshot(current, 4, 'cancelled', null)).toMatchObject({ version: 4, start_at: v3Start, status: 'cancelled' });
  });
});

describe('handleAppointmentEventJob', () => {
  it('a backlogged reschedule webhook carries its own version and time, so it cannot collide with the later cancellation', async () => {
    h.event = { actor_user_id: null, old_start_at: v1Start, new_start_at: v2Start };
    await handleAppointmentEventJob(acct, { appointmentId: current.id, version: 2, kind: 'rescheduled' });
    h.event = { actor_user_id: null, old_start_at: null, new_start_at: null };
    await handleAppointmentEventJob(acct, { appointmentId: current.id, version: 4, kind: 'cancelled' });

    const [[, e1, d1], [, e2, d2]] = h.emit.mock.calls;
    expect(e1).toBe('appointment.rescheduled');
    expect(d1).toMatchObject({ version: 2, status: 'confirmed', start_at: v2Start.toISOString(), local_date: '2026-12-05',
      local_time: '00:30', previous_start_at: v1Start.toISOString() });
    expect(d1).not.toHaveProperty('cancel_reason');
    expect(e2).toBe('appointment.cancelled');
    expect(d2).toMatchObject({ version: 4, status: 'cancelled', cancel_reason: 'staff' });
    expect(d1.version).not.toBe(d2.version);
  });

  it('a late booking webhook reports the originally booked time, not the rescheduled one', async () => {
    h.event = { actor_user_id: null, old_start_at: null, new_start_at: v1Start };
    await handleAppointmentEventJob(acct, { appointmentId: current.id, version: 1, kind: 'confirmed' });
    expect(h.emit.mock.calls[0][2]).toMatchObject({ version: 1, status: 'confirmed', start_at: v1Start.toISOString(), local_time: '11:00' });
  });
});
