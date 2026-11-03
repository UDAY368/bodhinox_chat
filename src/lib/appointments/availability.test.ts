import { describe, expect, it } from 'vitest';
import { computeSlots, dayAllowed, effectiveRanges, POOL_KEY, rangeEndInstant, remainingFor, type BusyRow, type SlotInputs } from './availability';
import type { WorkingHours } from '@/lib/inbox/working-hours';

const SVC = '00000000-0000-4000-8000-000000000001';
const OTHER_SVC = '00000000-0000-4000-8000-000000000002';
const A = '00000000-0000-4000-8000-0000000000aa';
const B = '00000000-0000-4000-8000-0000000000bb';
const LOC = '00000000-0000-4000-8000-0000000000cc';
const EVERY_DAY: WorkingHours = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
  .map((d) => [d, [{ start: '09:00', end: '12:00' }]]));

function inputs(over: Partial<SlotInputs> = {}): SlotInputs {
  return {
    timezone: 'Asia/Kolkata',
    locationId: LOC,
    service: { id: SVC, duration_minutes: 60, buffer_minutes: 0, slot_step_minutes: null, capacity: 1, allowed_weekdays: null },
    offerings: [{ staff_id: A }],
    hoursByKey: new Map([[A, EVERY_DAY]]),
    exceptions: [],
    busy: [],
    settings: { min_notice_minutes: 0, horizon_days: 365 },
    fromDay: '2026-11-09', // a Monday
    days: 1,
    now: new Date('2026-11-01T00:00:00Z'),
    ...over,
  };
}

const busy = (start: string, minutes: number, over: Partial<BusyRow> = {}): BusyRow => ({
  id: crypto.randomUUID(), staff_id: A, service_id: SVC, location_id: LOC,
  start_at: new Date(start), end_at: new Date(Date.parse(start) + minutes * 60_000), buffer_minutes: 0, ...over,
});

describe('computeSlots', () => {
  it('generates local starts converted to UTC (Kolkata is +05:30)', () => {
    const slots = computeSlots(inputs());
    expect(slots.map((s) => s.hhmm)).toEqual(['09:00', '10:00', '11:00']);
    expect(slots[0]).toMatchObject({ startAt: '2026-11-09T03:30:00.000Z', endAt: '2026-11-09T04:30:00.000Z', localDate: '2026-11-09', staffIds: [A], remaining: 1 });
  });

  it('applies the Monday rule to the local date in Kolkata: Monday 00:30 IST (Sunday UTC) is allowed, Sunday is not', () => {
    const service = { ...inputs().service, duration_minutes: 30, allowed_weekdays: [1] };
    const hours = new Map([[A, { sun: [{ start: '00:00', end: '24:00' }], mon: [{ start: '00:30', end: '01:00' }] } as WorkingHours]]);
    const slots = computeSlots(inputs({ service, hoursByKey: hours, fromDay: '2026-11-08', days: 2 }));
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({ localDate: '2026-11-09', hhmm: '00:30', startAt: '2026-11-08T19:00:00.000Z' });
  });

  it('applies the Monday rule in Pago_Pago (-11), where the local Monday is Tuesday in UTC', () => {
    const service = { ...inputs().service, allowed_weekdays: [1] };
    const slots = computeSlots(inputs({ timezone: 'Pacific/Pago_Pago', service, fromDay: '2026-11-08', days: 3 }));
    expect(new Set(slots.map((s) => s.localDate))).toEqual(new Set(['2026-11-09']));
    expect(slots[slots.length - 1].startAt).toBe('2026-11-09T22:00:00.000Z');
    // 11:00 local Monday = 22:00 UTC Monday; 09:00 = 20:00 UTC.
    expect(dayAllowed(service, '2026-11-10')).toBe(false);
  });

  it('a location holiday beats staff hours; a staff exception replaces the week; a location custom range intersects', () => {
    const holiday = [{ staff_id: null, starts_on: '2026-11-09', ends_on: '2026-11-09', ranges: null }];
    expect(computeSlots(inputs({ exceptions: holiday }))).toEqual([]);
    const staffEx = [{ staff_id: A, starts_on: '2026-11-09', ends_on: '2026-11-09', ranges: [{ start: '14:00', end: '16:00' }] }];
    expect(computeSlots(inputs({ exceptions: staffEx })).map((s) => s.hhmm)).toEqual(['14:00', '15:00']);
    const staffOff = [{ staff_id: A, starts_on: '2026-11-01', ends_on: '2026-11-30', ranges: null }];
    expect(computeSlots(inputs({ exceptions: staffOff }))).toEqual([]);
    const shortDay = [{ staff_id: null, starts_on: '2026-11-09', ends_on: '2026-11-09', ranges: [{ start: '10:00', end: '11:00' }] }];
    expect(computeSlots(inputs({ exceptions: shortDay })).map((s) => s.hhmm)).toEqual(['10:00']);
    expect(effectiveRanges('2026-11-09', A, new Map([[A, EVERY_DAY]]), [...shortDay, ...staffEx])).toEqual([]);
  });

  it('capacity 1 blocks an overlap; capacity 3 allows a group session of the same service and start', () => {
    const at = '2026-11-09T03:30:00Z';
    expect(computeSlots(inputs({ busy: [busy(at, 60)] })).map((s) => s.hhmm)).toEqual(['10:00', '11:00']);
    const service = { ...inputs().service, capacity: 3 };
    const group = computeSlots(inputs({ service, busy: [busy(at, 60), busy(at, 60)] }));
    expect(group[0]).toMatchObject({ hhmm: '09:00', remaining: 1 });
    expect(computeSlots(inputs({ service, busy: [busy(at, 60), busy(at, 60), busy(at, 60)] }))[0].hhmm).toBe('10:00');
  });

  it('a different service, or a shifted start, overlapping a group session is a conflict', () => {
    const service = { ...inputs().service, capacity: 3 };
    expect(computeSlots(inputs({ service, busy: [busy('2026-11-09T03:30:00Z', 60, { service_id: OTHER_SVC })] }))[0].hhmm).toBe('10:00');
    expect(computeSlots(inputs({ service, busy: [busy('2026-11-09T03:00:00Z', 60)] }))[0].hhmm).toBe('10:00');
  });

  it('applies both buffers', () => {
    // Busy 09:00-10:00 with a 30 minute buffer blocks 10:00 too (busy until 10:30).
    const slots = computeSlots(inputs({ service: { ...inputs().service, slot_step_minutes: 30 }, busy: [busy('2026-11-09T03:30:00Z', 60, { buffer_minutes: 30 })] }));
    expect(slots.map((s) => s.hhmm)).toEqual(['10:30', '11:00']);
    // The candidate's own buffer: a 09:00-10:00 slot with 30 min buffer collides with a 10:15 booking.
    const own = computeSlots(inputs({ service: { ...inputs().service, buffer_minutes: 30 }, busy: [busy('2026-11-09T04:45:00Z', 15)] }));
    expect(own.map((s) => s.hhmm)).toEqual(['11:00']);
  });

  it('honours minimum notice and the horizon', () => {
    const now = new Date('2026-11-09T03:00:00Z'); // 08:30 IST
    expect(computeSlots(inputs({ now, settings: { min_notice_minutes: 60, horizon_days: 365 } })).map((s) => s.hhmm)).toEqual(['10:00', '11:00']);
    expect(computeSlots(inputs({ now: new Date('2026-10-01T00:00:00Z'), settings: { min_notice_minutes: 0, horizon_days: 30 } }))).toEqual([]);
    expect(computeSlots(inputs({ now, settings: { min_notice_minutes: 600, horizon_days: 365 }, ignoreNotice: true })).map((s) => s.hhmm))
      .toEqual(['09:00', '10:00', '11:00']);
  });

  it('skips a wall time inside a DST gap (New York, 2026-03-08 02:30)', () => {
    const hours = new Map([[A, { sun: [{ start: '01:30', end: '04:00' }] } as WorkingHours]]);
    const slots = computeSlots(inputs({ timezone: 'America/New_York', hoursByKey: hours, fromDay: '2026-03-08',
      service: { ...inputs().service, duration_minutes: 30 }, now: new Date('2026-03-01T00:00:00Z') }));
    expect(slots.map((s) => s.hhmm)).toEqual(['01:30', '03:00', '03:30']);
  });

  it('a practitioner busy at another location is busy here', () => {
    const slots = computeSlots(inputs({ busy: [busy('2026-11-09T03:30:00Z', 60, { location_id: crypto.randomUUID() })] }));
    expect(slots.map((s) => s.hhmm)).toEqual(['10:00', '11:00']);
  });

  it('lists every free practitioner and pools use pool hours and pool bookings only', () => {
    const two = computeSlots(inputs({ offerings: [{ staff_id: B }, { staff_id: A }], hoursByKey: new Map([[A, EVERY_DAY], [B, EVERY_DAY]]),
      busy: [busy('2026-11-09T03:30:00Z', 60)] }));
    expect(two[0]).toMatchObject({ hhmm: '09:00', staffIds: [B], remaining: 1 });
    expect(two[1]).toMatchObject({ staffIds: [A, B], remaining: 2 });
    const pool = computeSlots(inputs({ offerings: [{ staff_id: null }], hoursByKey: new Map([[POOL_KEY, EVERY_DAY]]),
      busy: [busy('2026-11-09T03:30:00Z', 60, { staff_id: null })] }));
    expect(pool.map((s) => s.hhmm)).toEqual(['10:00', '11:00']);
    expect(pool[0].staffIds).toEqual([]);
  });

  it('ignores its own appointment when re-checking a reschedule', () => {
    const own = busy('2026-11-09T03:30:00Z', 60);
    expect(computeSlots(inputs({ busy: [own], excludeAppointmentId: own.id }))[0].hhmm).toBe('09:00');
  });

  it('refuses bad input quietly', () => {
    expect(computeSlots(inputs({ timezone: 'Not/AZone' }))).toEqual([]);
    expect(computeSlots(inputs({ offerings: [] }))).toEqual([]);
    expect(computeSlots(inputs({ fromDay: '09-11-2026' }))).toEqual([]);
  });
});

describe('remainingFor', () => {
  it('treats touching intervals as free', () => {
    const b = busy('2026-11-09T03:30:00Z', 60);
    const start = Date.parse('2026-11-09T04:30:00Z');
    expect(remainingFor({ serviceId: SVC, locationId: LOC, start, end: start + 3_600_000, bufferMs: 0, capacity: 1 }, [b])).toBe(1);
  });

  it('counts a group seat only at the same location', () => {
    const b = busy('2026-11-09T03:30:00Z', 60);
    const start = Date.parse('2026-11-09T03:30:00Z');
    const candidate = { serviceId: SVC, start, end: start + 3_600_000, bufferMs: 0, capacity: 3 };
    expect(remainingFor({ ...candidate, locationId: LOC }, [b])).toBe(2);
    expect(remainingFor({ ...candidate, locationId: crypto.randomUUID() }, [b])).toBe(0);
  });
});

describe('group service at two locations (one practitioner)', () => {
  it('a booking at location A leaves no slot at the same start at location B', () => {
    const service = { ...inputs().service, capacity: 3 };
    const atA = busy('2026-11-09T03:30:00Z', 60, { location_id: LOC });
    const hereA = computeSlots(inputs({ service, busy: [atA] }));
    expect(hereA[0]).toMatchObject({ hhmm: '09:00', remaining: 2 });
    const hereB = computeSlots(inputs({ service, busy: [atA], locationId: crypto.randomUUID() }));
    expect(hereB.map((s) => s.hhmm)).toEqual(['10:00', '11:00']);
  });
});

describe('spring-forward day (America/New_York, 2026-03-08)', () => {
  const now = new Date('2026-03-01T00:00:00Z');
  it('drops a slot whose real end runs past the range close', () => {
    // Hours 00:00-03:00 wall; 02:00-03:00 does not exist, so the range closes at 03:00 EDT = 07:00Z.
    const hours = new Map([[A, { sun: [{ start: '00:00', end: '03:00' }] } as WorkingHours]]);
    const slots = computeSlots(inputs({ timezone: 'America/New_York', hoursByKey: hours, fromDay: '2026-03-08', now,
      service: { ...inputs().service, slot_step_minutes: 30 } }));
    // 01:30 EST (06:30Z) + 60 min = 07:30Z, past 07:00Z, so it is dropped; 00:00-01:00 starts fit.
    expect(slots.map((s) => s.hhmm)).toEqual(['00:00', '00:30', '01:00']);
    expect(slots.every((s) => Date.parse(s.endAt) <= Date.parse('2026-03-08T07:00:00Z'))).toBe(true);
  });

  it('a range end inside the gap closes at the first minute after it', () => {
    expect(new Date(rangeEndInstant('2026-03-08', 150, 'America/New_York') as number).toISOString()).toBe('2026-03-08T07:00:00.000Z');
    expect(new Date(rangeEndInstant('2026-11-09', 1440, 'Asia/Kolkata') as number).toISOString()).toBe('2026-11-09T18:30:00.000Z');
  });
});

describe('impossible dates', () => {
  it('lists nothing for a date that is not on the calendar', () => {
    expect(computeSlots(inputs({ fromDay: '2026-02-30' }))).toEqual([]);
    expect(computeSlots(inputs({ fromDay: '9999-12-31' }))).toEqual([]);
  });
});
