import { describe, expect, it } from 'vitest';
import { formatAppointmentTime, templateBodyValues, templateOutcome } from './customer-send';
import { EVENT_FANOUT } from './events';
import { followupApplies } from './followup';
import { noticeApplies } from './notify-customer';
import { reminderApplies } from './reminders';
import type { AppointmentRow } from './types';

const start = new Date('2026-12-07T05:30:00Z');
const row = (patch: Partial<AppointmentRow> = {}): AppointmentRow => ({
  id: '00000000-0000-4000-8000-000000000001', contact_id: '00000000-0000-4000-8000-000000000002',
  service_id: 's', staff_id: null, location_id: 'l', start_at: start, end_at: new Date(start.getTime() + 1_800_000),
  timezone: 'Asia/Kolkata', local_date: '2026-12-07', status: 'confirmed', version: 2, source: 'staff', source_ref: null,
  booking_page_id: null, hold_expires_at: null, hold_code: null, confirmed_at: new Date('2026-11-01T00:00:00Z'),
  price_minor: null, currency: null, meeting_url: null, service_name: 'Consult', token_epoch: 1, cancel_reason: null,
  outcome_note: null, feedback_score: null, created_by: null, created_at: start, updated_at: start, ...patch,
});
const H = 3_600_000;

describe('reminderApplies', () => {
  it('skips an old version, a cancelled row and a deleted contact', () => {
    expect(reminderApplies(row(), 1, '24h', new Date(start.getTime() - 30 * H))).toBe('stale_version');
    expect(reminderApplies(row({ status: 'cancelled' }), 2, '24h', new Date(start.getTime() - 30 * H))).toBe('stale_version');
    expect(reminderApplies(row({ contact_id: null }), 2, '2h', new Date(start.getTime() - 3 * H))).toBe('contact_missing');
    expect(reminderApplies(row(), 2, '24h', new Date(start.getTime() - 24 * H))).toBeNull();
  });

  it('never sends a late reminder that no longer makes sense', () => {
    expect(reminderApplies(row(), 2, '24h', new Date(start.getTime() - 2 * H))).toBe('past_due');
    expect(reminderApplies(row(), 2, '24h', new Date(start.getTime() - 2 * H - 1))).toBeNull();
    expect(reminderApplies(row(), 2, '2h', new Date(start.getTime() - 30 * 60_000))).toBe('past_due');
    expect(reminderApplies(row(), 2, '2h', new Date(start.getTime() - 2 * H))).toBeNull();
  });
});

describe('noticeApplies after a same-time reassign', () => {
  it('keeps a confirmation valid when the version moved but the start did not', () => {
    const r = row();
    const start = r.start_at.toISOString();
    expect(noticeApplies({ ...r, version: r.version + 1 }, r.version, 'confirmation', start)).toBeNull();
    expect(noticeApplies({ ...r, version: r.version + 1, start_at: new Date(r.start_at.getTime() + 3_600_000) }, r.version, 'confirmation', start)).toBe('stale_version');
    expect(noticeApplies({ ...r, version: r.version + 1 }, r.version, 'confirmation')).toBe('stale_version');
    expect(noticeApplies({ ...r, version: r.version + 1, status: 'cancelled' }, r.version, 'cancelled', start)).toBe('stale_version');
  });
});

describe('noticeApplies and followupApplies', () => {
  it('a confirmation or rescheduled notice needs the same version, still confirmed', () => {
    expect(noticeApplies(row(), 2, 'confirmation')).toBeNull();
    expect(noticeApplies(row(), 1, 'confirmation')).toBe('stale_version');
    expect(noticeApplies(row({ status: 'cancelled' }), 2, 'rescheduled')).toBe('stale_version');
  });

  it('a cancelled notice checks its own version and status', () => {
    expect(noticeApplies(row({ status: 'cancelled' }), 2, 'cancelled')).toBeNull();
    expect(noticeApplies(row({ status: 'confirmed' }), 2, 'cancelled')).toBe('stale_version');
  });

  it('feedback only for a completed appointment without a score', () => {
    expect(followupApplies(row({ status: 'completed' }), 2, 'feedback')).toBeNull();
    expect(followupApplies(row({ status: 'completed', feedback_score: 4 }), 2, 'feedback')).toBe('feedback_recorded');
    expect(followupApplies(row({ status: 'completed', feedback_score: 4 }), 2, 'rebook')).toBeNull();
    expect(followupApplies(row({ status: 'no_show' }), 2, 'rebook')).toBe('stale_version');
  });
});

describe('message content', () => {
  it('formats the time in the appointment zone with its label, whatever the server zone', () => {
    const text = formatAppointmentTime(start, 'Asia/Kolkata', 'en');
    expect(text).toContain('11:00');
    expect(text).toContain('GMT+5:30');
    expect(text).toMatch(/Mon/);
  });

  it('fills service, time and location positionally, cut to the template', () => {
    const ctx = { serviceName: 'Consult', time: 'Mon 7 Dec, 11:00 GMT+5:30', location: 'Clinic' };
    expect(templateBodyValues({ body_text: 'Your {{1}} is on {{2}} at {{3}}.' }, ctx)).toEqual(['Consult', 'Mon 7 Dec, 11:00 GMT+5:30', 'Clinic']);
    expect(templateBodyValues({ body_text: 'See you {{2}}' }, ctx)).toEqual(['Consult', 'Mon 7 Dec, 11:00 GMT+5:30']);
    expect(templateBodyValues({ body_text: 'No variables' }, ctx)).toEqual([]);
  });
});

describe('templateOutcome', () => {
  const origin = 'https://app.example.com';
  const template = (patch: Record<string, unknown> = {}) => ({
    name: 'appt', language: 'en_US', status: 'APPROVED', category: 'Utility' as const, body_text: 'Hi {{1}}',
    header_type: null, header_content: null, header_media_url: null, buttons: [], template_kind: 'standard' as const,
    cards: null, lto: null, waba_id: null, ...patch,
  }) as unknown as Parameters<typeof templateOutcome>[0];

  it('accepts an approved UTILITY template with the manage-link button', () => {
    expect(templateOutcome(template({ buttons: [{ type: 'URL', text: 'Manage', url: `${origin}/my-booking/{{1}}` }] }), origin, {})).toBeNull();
  });

  it('refuses a missing, unapproved, MARKETING, foreign-link or other-number template', () => {
    expect(templateOutcome(null, origin, {})).toEqual({ status: 'blocked', reason: 'template_not_found' });
    expect(templateOutcome(template({ status: 'PENDING' }), origin, {})).toEqual({ status: 'blocked', reason: 'template_not_approved' });
    expect(templateOutcome(template({ category: 'Marketing' }), origin, {})).toEqual({ status: 'blocked', reason: 'category' });
    expect(templateOutcome(template({ buttons: [{ type: 'URL', text: 'Go', url: 'https://evil.example/{{1}}' }] }), origin, {}))
      .toEqual({ status: 'blocked', reason: 'template_refused' });
    expect(templateOutcome(template({ waba_id: 'w1' }), origin, { waba_id: 'w2' })).toEqual({ status: 'blocked', reason: 'template_wrong_number' });
  });
});

describe('EVENT_FANOUT', () => {
  it('maps each lifecycle event to one trigger, webhook and (for three) a staff alert', () => {
    expect(EVENT_FANOUT.confirmed).toEqual({ trigger: 'appointment_booked', webhook: 'appointment.booked', notification: 'appointment_booked' });
    expect(EVENT_FANOUT.completed?.notification).toBeNull();
    expect(EVENT_FANOUT.held).toBeUndefined();
    expect(EVENT_FANOUT.reassigned).toBeUndefined();
  });
});
