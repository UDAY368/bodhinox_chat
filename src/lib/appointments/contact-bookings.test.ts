import { describe, expect, it } from 'vitest';
import type { TenantTransaction } from '@/lib/db/tenant';
import { bookingTimelineEvent, clampLimit, contactBookingTimeline, decodeCursor, encodeCursor } from './contact-bookings';

describe('contact bookings helpers', () => {
  it('round-trips a cursor and rejects forged ones', () => {
    const row = { start_at: '2026-12-01T05:30:00.000Z', id: '33333333-3333-4333-8333-333333333333' };
    expect(decodeCursor(encodeCursor(row))).toEqual({ startAt: row.start_at, id: row.id });
    expect(decodeCursor(null)).toBeNull();
    for (const bad of ['x', `${row.start_at}_nope`, `2026-13-45T99:99:99Z_${row.id}`, `${row.start_at}_${row.id}' OR 1=1`])
      expect(() => decodeCursor(bad)).toThrow();
  });

  it('defaults the page size to 3 and caps it at 20', () => {
    expect(clampLimit(null)).toBe(3);
    expect(clampLimit('7')).toBe(7);
    expect(clampLimit('500')).toBe(20);
    expect(() => clampLimit('0')).toThrow();
    expect(() => clampLimit('2.5')).toThrow();
  });

  it('names timeline events, defaulting unknown ones to booked', () => {
    expect(bookingTimelineEvent({ event: 'no_show' })).toBe('no_show');
    expect(bookingTimelineEvent({ event: 'held' })).toBe('booked');
    expect(bookingTimelineEvent({})).toBe('booked');
  });

  it('maps ledger rows to bounded timeline rows for this workspace and contact, hiding unconfirmed cancelled holds', async () => {
    const calls: { sql: string; values: unknown[] }[] = [];
    const at = new Date('2026-12-01T05:30:00Z');
    const tx = {
      $queryRaw: async (s: TemplateStringsArray, ...values: unknown[]) => {
        calls.push({ sql: s.join('?'), values });
        return [{ kind: 'confirmed', created_at: at, actor_id: null, id: 'a1', service_name: 'Consult' }];
      },
    } as unknown as TenantTransaction;
    expect(await contactBookingTimeline(tx, 'acct', 'contact')).toEqual([
      { kind: 'booking', at: at.toISOString(), actor_id: null, detail: { appointment_id: 'a1', event: 'booked', service_name: 'Consult' } },
    ]);
    expect(calls[0].values).toEqual(expect.arrayContaining(['acct', 'contact', 50]));
    expect(calls[0].sql).toContain("e.kind <> 'cancelled' OR a.confirmed_at IS NOT NULL");
    expect(calls[0].sql).not.toMatch(/outcome_note|intake|phone/);
  });
});
