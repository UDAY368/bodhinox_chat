import { describe, expect, it } from 'vitest';
import { parseView, paymentStateKey, refundOffered, resolveTab, snapDrag, zonedStartIso } from './shared';

describe('resolveTab', () => {
  it('keeps the four tabs and sends old tabs to their new home', () => {
    expect(resolveTab('team')).toEqual({ tab: 'team', section: null, legacy: false });
    expect(resolveTab('tasks')).toEqual({ tab: 'schedule', section: 'attention', legacy: true });
    expect(resolveTab('staff')).toMatchObject({ tab: 'team', section: 'staff' });
    expect(resolveTab('locations')).toMatchObject({ tab: 'team', section: 'locations' });
    expect(resolveTab('exceptions')).toMatchObject({ tab: 'team', section: 'exceptions' });
    expect(resolveTab('pages')).toMatchObject({ tab: 'settings', section: 'pages' });
    expect(resolveTab('nonsense')).toEqual({ tab: 'schedule', section: null, legacy: false });
    expect(resolveTab(null).tab).toBe('schedule');
  });
});

describe('parseView', () => {
  it('reads ?view= and otherwise defaults by screen', () => {
    expect(parseView('list', false)).toBe('list');
    expect(parseView('today', false)).toBe('today');
    expect(parseView('grid', false)).toBe('week');
    expect(parseView(null, true)).toBe('today');
    expect(parseView(null, false)).toBe('week');
  });
});

describe('payment words and the refund offer', () => {
  const paid = { refundable_minor: 50000, status: 'captured' };
  it('names the payment state', () => {
    expect([paymentStateKey('paid'), paymentStateKey('pending'), paymentStateKey('refunded'), paymentStateKey('none')])
      .toEqual(['paid', 'waiting', 'refunded', null]);
  });
  it('offers a refund only for a cancelled, paid booking with money left, to someone who may refund', () => {
    const cancelled = { status: 'cancelled', payment_status: 'paid' };
    expect(refundOffered(cancelled, paid, true)).toBe(true);
    expect(refundOffered(cancelled, paid, false)).toBe(false);
    expect(refundOffered({ status: 'confirmed', payment_status: 'paid' }, paid, true)).toBe(false);
    expect(refundOffered({ status: 'cancelled', payment_status: 'refunded' }, paid, true)).toBe(false);
    expect(refundOffered(cancelled, { ...paid, refundable_minor: 0 }, true)).toBe(false);
    expect(refundOffered(cancelled, { ...paid, status: 'authorized' }, true)).toBe(false);
    expect(refundOffered(cancelled, null, true)).toBe(false);
  });
});

describe('snapDrag', () => {
  it('snaps a drag to the slot step', () => {
    expect(snapDrag(600, 56, 56, 15, 30)).toBe(660);
    expect(snapDrag(600, 20, 56, 15, 30)).toBe(615);
    expect(snapDrag(600, 5, 56, 15, 30)).toBe(600);
    expect(snapDrag(600, -28, 56, 30, 30)).toBe(570);
  });
  it('keeps the booking inside the day', () => {
    expect(snapDrag(30, -500, 56, 15, 30)).toBe(0);
    expect(snapDrag(1380, 500, 56, 15, 60)).toBe(1380);
  });
});

describe('zonedStartIso', () => {
  it('turns a local day and minute into the instant in that zone', () => {
    expect(zonedStartIso('2026-11-16', 600, 'Asia/Kolkata')).toBe('2026-11-16T04:30:00.000Z');
    expect(zonedStartIso('2026-11-16', 600, 'UTC')).toBe('2026-11-16T10:00:00.000Z');
  });
});
