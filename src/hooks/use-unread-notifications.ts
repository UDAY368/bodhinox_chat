'use client';

import { useSyncExternalStore } from 'react';
import { createClient } from '@/lib/data/client';
import type { Notification } from '@/types';
import { BOOKING_NOTIFICATION_TYPES, isBookingNotification, startOfToday } from './use-unread-booking-notifications';

/**
 * Unread notification counts for the current member: every unread
 * notification (the Notifications badge in the header) and today's unread
 * booking alerts (the Sales dot in the sidebar).
 *
 * Every reader on the page shares ONE realtime channel. Each channel is its
 * own server connection (EventSource), and a page that opens one per hook
 * can use up the browser's per-host connection limit, which stalls the
 * inbox's own requests. The channel opens with the first reader and closes
 * with the last.
 *
 * RLS on `notifications` scopes every read to the member, so no explicit
 * user filter is needed.
 */
export interface UnreadCounts { all: number; bookings: number }

const EMPTY: UnreadCounts = { all: 0, bookings: 0 };
let counts: UnreadCounts = EMPTY;
const listeners = new Set<() => void>();
let stop: (() => void) | null = null;

function set(next: Partial<UnreadCounts>) {
  counts = { ...counts, ...next };
  for (const listener of listeners) listener();
}

function start(): () => void {
  const db = createClient();
  let cancelled = false;

  // head:true skips fetching rows: only the count comes back.
  const resyncAll = async () => {
    const { count, error } = await db.from('notifications').select('*', { count: 'exact', head: true }).is('read_at', null);
    if (!cancelled && !error) set({ all: count ?? 0 });
  };
  const resyncBookings = async () => {
    const { count, error } = await db.from('notifications').select('*', { count: 'exact', head: true })
      .in('type', [...BOOKING_NOTIFICATION_TYPES]).is('read_at', null).gte('created_at', startOfToday());
    if (!cancelled && !error) set({ bookings: count ?? 0 });
  };
  void resyncAll();
  void resyncBookings();

  const channel = db
    .channel('notifications-unread-count')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications' }, (payload) => {
      if (payload.eventType === 'INSERT') {
        const row = payload.new as unknown as Notification;
        if (!row.read_at) set({ all: counts.all + 1 });
      } else if (payload.eventType === 'UPDATE') {
        // Updates only ever set read_at (marking read). Derive from the new row so
        // payload.old columns (REPLICA IDENTITY FULL) are not needed.
        const row = payload.new as unknown as Notification;
        if (row.read_at) set({ all: Math.max(0, counts.all - 1) });
      } else if (payload.eventType === 'DELETE') {
        const row = payload.old as Partial<Notification>;
        if (!row.read_at) set({ all: Math.max(0, counts.all - 1) });
      }
      // The booking dot is "today's unread", so recount rather than adjust.
      if (isBookingNotification(payload.new as Partial<Notification>) || isBookingNotification(payload.old as Partial<Notification>))
        void resyncBookings();
    })
    .onResync(() => {
      void resyncAll();
      void resyncBookings();
    })
    .subscribe();

  return () => {
    cancelled = true;
    db.removeChannel(channel);
  };
}

/** Join the shared subscription (opens the channel for the first reader); returns leave. */
export function subscribeUnreadCounts(listener: () => void): () => void {
  listeners.add(listener);
  if (!stop) stop = start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && stop) {
      stop();
      stop = null;
      counts = EMPTY;
    }
  };
}

export const unreadCountsSnapshot = (): UnreadCounts => counts;
const serverSnapshot = () => EMPTY;

/** Count of unread notifications (header badge). */
export function useUnreadNotifications(): number {
  return useSyncExternalStore(subscribeUnreadCounts, unreadCountsSnapshot, serverSnapshot).all;
}

/** Count of today's unread booking alerts (booked, moved, cancelled, no-show): the Sales dot. */
export function useUnreadBookingNotifications(): number {
  return useSyncExternalStore(subscribeUnreadCounts, unreadCountsSnapshot, serverSnapshot).bookings;
}
