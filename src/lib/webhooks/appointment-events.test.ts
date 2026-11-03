import { describe, expect, it } from 'vitest';
import type { AppointmentRow } from '@/lib/appointments/types';
import { appointmentWebhookData } from './appointment-events';

const start = new Date('2026-12-06T19:00:00Z'); // Monday 00:30 in Kolkata
const row: AppointmentRow = {
  id: 'a1', contact_id: 'c1', service_id: 's1', staff_id: 'st1', location_id: 'l1', start_at: start,
  end_at: new Date(start.getTime() + 1_800_000), timezone: 'Asia/Kolkata', local_date: '2026-12-07', status: 'cancelled', version: 3,
  source: 'public', source_ref: 'public:p:r', booking_page_id: 'p1', hold_expires_at: null, hold_code: 'ABC234',
  confirmed_at: start, price_minor: BigInt(50000), currency: 'INR', meeting_url: 'https://meet.example/x', service_name: 'Consult',
  token_epoch: 1, cancel_reason: 'customer', outcome_note: 'clinical detail', feedback_score: null, created_by: null,
  created_at: start, updated_at: start,
};

describe('appointmentWebhookData', () => {
  it('carries ids, UTC and local times, and never the note, code, link or source reference', () => {
    const data = appointmentWebhookData(row, { previousStartAt: new Date('2026-12-05T19:00:00Z') });
    expect(data).toMatchObject({
      appointment_id: 'a1', version: 3, status: 'cancelled', start_at: '2026-12-06T19:00:00.000Z', local_date: '2026-12-07',
      local_time: '00:30', timezone: 'Asia/Kolkata', previous_start_at: '2026-12-05T19:00:00.000Z', cancel_reason: 'customer',
      price_minor: 50000, currency: 'INR',
    });
    const text = JSON.stringify(data);
    for (const secret of ['clinical detail', 'ABC234', 'meet.example', 'public:p:r', 'token']) expect(text).not.toContain(secret);
  });

  it('omits the previous time and cancel reason when they do not apply', () => {
    const data = appointmentWebhookData({ ...row, status: 'confirmed' });
    expect(data).not.toHaveProperty('previous_start_at');
    expect(data).not.toHaveProperty('cancel_reason');
  });
});
