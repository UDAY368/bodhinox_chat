import { describe, expect, it } from 'vitest';
import { assertEvent } from './emit';
import { eventVars } from './dispatch';
import { decodeTimelineCursor, encodeTimelineCursor } from './store';
import { DOMAIN_EVENT_TYPES, triggerForEvent, isEventTriggerType } from './types';

const id = '11111111-1111-4111-8111-111111111111';
const base = { accountId: id, type: 'order.paid' as const, subject: { kind: 'order' as const, id }, data: { order_id: id } };

describe('event feed contract', () => {
  it('accepts a well-formed event', () => {
    expect(() => assertEvent(base)).not.toThrow();
  });

  it('refuses nested data, unknown types, bad ids and oversize data', () => {
    expect(() => assertEvent({ ...base, data: { items: [1] } as never })).toThrow(/scalars/);
    expect(() => assertEvent({ ...base, type: 'order.lost' as never })).toThrow(/type/);
    expect(() => assertEvent({ ...base, accountId: 'x' })).toThrow(/identity/);
    expect(() => assertEvent({ ...base, data: { note: 'x'.repeat(3000) } })).toThrow(/large/);
    expect(() => assertEvent({ ...base, dedupeKey: '' })).toThrow(/dedupe/);
  });

  it('maps every event type to a rule and flow trigger', () => {
    for (const type of DOMAIN_EVENT_TYPES) expect(isEventTriggerType(triggerForEvent(type))).toBe(true);
    expect(triggerForEvent('deal.stage_changed')).toBe('deal_stage_changed');
  });

  it('exposes event fields as event_* vars, and appointment vars under their old names', () => {
    expect(eventVars({ type: 'order.paid', data: { order_id: id, total_minor: 500, conversation_id: null } }))
      .toEqual({ event_order_id: id, event_total_minor: '500' });
    const vars = eventVars({ type: 'appointment.booked', data: { appointment_id: id, service_name: 'Consult',
      start_at: '2026-12-08T04:30:00.000Z', timezone: 'Asia/Kolkata' } });
    expect(vars.appointment_id).toBe(id);
    expect(vars.appointment_service).toBe('Consult');
    expect(vars.appointment_local_time).toContain('10:00');
  });

  it('round-trips a timeline cursor and rejects junk', () => {
    const cursor = encodeTimelineCursor({ occurred_at: new Date('2026-11-19T10:00:00Z'), id });
    expect(decodeTimelineCursor(cursor)).toEqual({ at: '2026-11-19T10:00:00.000Z', id });
    expect(decodeTimelineCursor('not-base64')).toBeNull();
    expect(decodeTimelineCursor(Buffer.from('{"at":"x","id":"y"}').toString('base64url'))).toBeNull();
  });
});
