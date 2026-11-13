import { describe, expect, it } from 'vitest';
import type { Slot } from '@/lib/appointments/types';
import { preferredSlot } from './slot-selector';
import { gridFrame, layoutLanes, zonedMinutes, type HoursRow } from './week-grid';

describe('zonedMinutes', () => {
  it('reads the wall clock in the booking zone', () => {
    expect(zonedMinutes('2026-11-16T04:30:00Z', 'Asia/Kolkata')).toBe(10 * 60);
    expect(zonedMinutes('2026-11-16T15:00:00Z', 'UTC')).toBe(15 * 60);
  });
});

describe('layoutLanes', () => {
  it('puts overlapping bookings side by side and reuses a lane once it is free', () => {
    const { lane, lanes } = layoutLanes([
      { id: 'a', start: 600, end: 660 }, { id: 'b', start: 630, end: 690 }, { id: 'c', start: 660, end: 690 },
    ]);
    expect(lanes).toBe(2);
    expect(lane.get('a')).toBe(0);
    expect(lane.get('b')).toBe(1);
    expect(lane.get('c')).toBe(0);
  });
});

describe('gridFrame', () => {
  const hours: HoursRow[] = [
    { staff_id: null, location_id: 'L1', hours: { mon: [{ start: '09:00', end: '13:00' }, { start: '14:00', end: '18:30' }], sat: [{ start: '10:00', end: '14:00' }] } },
    { staff_id: 's', location_id: 'L2', hours: { sun: [{ start: '07:00', end: '12:00' }] } },
  ];
  it('spans the working hours of the location and shades the other days', () => {
    const f = gridFrame(hours, 'L1', []);
    expect([f.startHour, f.endHour]).toEqual([9, 19]);
    expect([...f.closed].sort()).toEqual([0, 2, 3, 4, 5]);
  });
  it('uses every location when none is chosen, and widens to fit a booking', () => {
    const f = gridFrame(hours, '', [{ start: 20 * 60, end: 21 * 60 }]);
    expect([f.startHour, f.endHour]).toEqual([7, 21]);
    expect(f.closed.has(0)).toBe(false);
  });
  it('closes nothing and shows 9 to 19 when no hours are set', () => {
    const f = gridFrame([], '', []);
    expect([f.startHour, f.endHour, f.closed.size]).toEqual([9, 19, 0]);
  });
});

describe('preferredSlot', () => {
  const slot = (localDate: string, hhmm: string): Slot => ({ startAt: `${localDate}T${hhmm}:00Z`, endAt: '', localDate, hhmm, staffIds: [], remaining: 1 });
  it('picks the first free time on the day at or after the clicked time', () => {
    const slots = [slot('2026-11-17', '09:00'), slot('2026-11-17', '11:30'), slot('2026-11-17', '10:30'), slot('2026-11-18', '10:00')];
    expect(preferredSlot(slots, '2026-11-17', '10:00')?.hhmm).toBe('10:30');
    expect(preferredSlot(slots, '2026-11-17', '12:00')).toBeNull();
    expect(preferredSlot(slots, '2026-11-19', '09:00')).toBeNull();
  });
});
