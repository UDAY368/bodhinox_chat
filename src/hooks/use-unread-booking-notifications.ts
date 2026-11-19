'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/data/client';
import type { Notification } from '@/types';

/** Booking alerts (booked, moved, cancelled, no-show) that light the Sales dot. */
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

/**
 * Count of the current member's unread booking alerts from today, for the
 * Sales dot. One head-count query on mount, then only on a booking
 * notification change (no polling). RLS scopes notifications to the member.
 */
export function useUnreadBookingNotifications(): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const db = createClient();
    let cancelled = false;

    const resync = async () => {
      const { count: unread, error } = await db
        .from('notifications')
        .select('*', { count: 'exact', head: true })
        .in('type', [...BOOKING_NOTIFICATION_TYPES])
        .is('read_at', null)
        .gte('created_at', startOfToday());
      if (cancelled || error) return;
      setCount(unread ?? 0);
    };
    void resync();

    const channel = db
      .channel('notifications-unread-bookings')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications' }, (payload) => {
        if (isBookingNotification(payload.new as Partial<Notification>) || isBookingNotification(payload.old as Partial<Notification>))
          void resync();
      })
      .onResync(() => void resync())
      .subscribe();

    return () => {
      cancelled = true;
      db.removeChannel(channel);
    };
  }, []);

  return count;
}
