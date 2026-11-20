import { describe, expect, it } from 'vitest';
import { BOOKING_NOTIFICATION_TYPES, isBookingNotification, startOfToday } from './use-unread-booking-notifications';
import { NOTIFICATION_TYPES } from '@/types';

describe('booking alert dot', () => {
  it('counts only booking alerts, which are all real notification types', () => {
    for (const type of BOOKING_NOTIFICATION_TYPES) expect(NOTIFICATION_TYPES).toContain(type);
    expect(isBookingNotification({ type: 'appointment_no_show' })).toBe(true);
    expect(isBookingNotification({ type: 'mention' })).toBe(false);
    expect(isBookingNotification({})).toBe(false);
    expect(isBookingNotification(null)).toBe(false);
  });

  it('starts today at local midnight', () => {
    const now = new Date(2026, 10, 19, 15, 42, 7);
    expect(new Date(startOfToday(now)).getTime()).toBe(new Date(2026, 10, 19).getTime());
  });
});
