import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppointmentRow } from './types';

const h = vi.hoisted(() => ({ notify: vi.fn(), staffNotify: true }));
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => 'worker' }));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (_c: unknown, op: (tx: unknown) => unknown) => op({
    $executeRaw: async () => 0,
    $queryRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join('');
      if (sql.includes('appointment_events')) return [{ actor_user_id: 'u-actor', old_start_at: null, new_start_at: null }];
      if (sql.includes('account_memberships')) return [{ user_id: 'u-admin' }];
      return [];
    },
  }),
}));
vi.mock('@/lib/jobs/dispatch', () => ({ dispatchOnce: async () => ({}) }));
vi.mock('@/lib/automations/engine', () => ({ runAutomationsForTrigger: vi.fn() }));
vi.mock('@/lib/i18n/translate', () => ({ getT: () => (key: string) => key }));
vi.mock('@/lib/inbox/notify', () => ({ createNotification: h.notify, MAX_NOTIFICATION_RECIPIENTS: 10 }));
vi.mock('@/lib/webhooks/appointment-events', () => ({ emitAppointmentWebhook: vi.fn(), appointmentWebhookData: () => ({}) }));
vi.mock('./availability', () => ({ loadSettings: async () => ({ staff_notify: h.staffNotify }) }));
vi.mock('./booking', () => ({ getAppointment: async () => row }));
vi.mock('./customer-send', () => ({ formatAppointmentTime: (d: Date) => d.toISOString() }));

import { EVENT_FANOUT, handleAppointmentEventJob } from './events';

const acct = '00000000-0000-4000-8000-0000000000aa';
const start = new Date('2026-12-03T05:30:00Z');
const row: AppointmentRow = {
  id: '00000000-0000-4000-8000-000000000001', contact_id: null, service_id: 's1', staff_id: null, location_id: 'l1',
  start_at: start, end_at: new Date(start.getTime() + 1_800_000), timezone: 'Asia/Kolkata', local_date: '2026-12-03',
  status: 'no_show', version: 3, source: 'staff', source_ref: null, booking_page_id: null, hold_expires_at: null, hold_code: null,
  confirmed_at: start, price_minor: null, currency: null, meeting_url: null, service_name: 'Consult', token_epoch: 1,
  cancel_reason: null, outcome_note: 'private note', feedback_score: null, created_by: null, created_at: start, updated_at: start,
};

beforeEach(() => { vi.clearAllMocks(); h.staffNotify = true; });

describe('no-show staff notification', () => {
  it('fans no_show out to the appointment_no_show notification', () => {
    expect(EVENT_FANOUT.no_show?.notification).toBe('appointment_no_show');
  });

  it('notifies staff like a booking, deduped per appointment, version and kind, without the note', async () => {
    await handleAppointmentEventJob(acct, { appointmentId: row.id, version: 3, kind: 'no_show' });
    await handleAppointmentEventJob(acct, { appointmentId: row.id, version: 3, kind: 'no_show' });
    expect(h.notify).toHaveBeenCalledTimes(2);
    const [[, first], [, second]] = h.notify.mock.calls;
    expect(first).toMatchObject({
      accountId: acct, userIds: ['u-admin'], event: 'appointment_no_show', title: 'staffNoShow',
      link: `/appointments?id=${row.id}`, actorUserId: 'u-actor',
    });
    // The same key both times: notifications are unique per (account, user, dedupe key), so a retried job adds nothing.
    expect(second.dedupeKey).toBe(first.dedupeKey);
    expect(first.dedupeKey).toContain('no_show');
    expect(JSON.stringify(first)).not.toContain('private note');
  });

  it('respects the staff notification setting', async () => {
    h.staffNotify = false;
    await handleAppointmentEventJob(acct, { appointmentId: row.id, version: 3, kind: 'no_show' });
    expect(h.notify).not.toHaveBeenCalled();
  });
});
