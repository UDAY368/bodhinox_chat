/**
 * Booking alerts that light the Sales dot. Pure helpers only: the count comes
 * from useUnreadBookingNotifications in ./use-unread-notifications, which
 * shares the page's one notifications channel with the header badge.
 */
import type { Notification } from '@/types';

/** Booking alerts (booked, moved, cancelled, no-show). */
export const BOOKING_NOTIFICATION_TYPES = [
  'appointment_booked', 'appointment_cancelled', 'appointment_rescheduled', 'appointment_no_show',
] as const;

/** Local midnight today, as the lower bound for "today's" alerts. */
export function startOfToday(now = new Date()): string {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/** A realtime row change that can move the count. */
export function isBookingNotification(row: Partial<Notification> | null | undefined): boolean {
  return !!row?.type && (BOOKING_NOTIFICATION_TYPES as readonly string[]).includes(row.type);
}
