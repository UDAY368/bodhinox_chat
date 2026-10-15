'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/data/client';
import type { Notification } from '@/types';

/**
 * Count of unread notifications for the current user. Used by the
 * sidebar to surface a badge on the Notifications nav entry.
 *
 * RLS on `notifications` already scopes every read to `auth.uid() =
 * user_id`, so no explicit filter is needed here — same pattern as
 * `useTotalUnread` for conversations.
 */
export function useUnreadNotifications(): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const db = createClient();
    let cancelled = false;

    const resync = async () => {
      // head:true skips fetching rows — we only need the `count`
      // db-js returns alongside the (empty) response body.
      const { count: unreadCount, error } = await db
        .from('notifications')
        .select('*', { count: 'exact', head: true })
        .is('read_at', null);
      if (cancelled || error) return;
      setCount(unreadCount ?? 0);
    };
    void resync();

    const channel = db
      .channel('notifications-unread-count')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'notifications' },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            const row = payload.new as unknown as Notification;
            if (!row.read_at) setCount((n) => n + 1);
          } else if (payload.eventType === 'UPDATE') {
            // Updates here only ever set read_at (marking a notification
            // read). Derive purely from the new row so we don't rely on
            // payload.old columns, which require REPLICA IDENTITY FULL.
            const newRow = payload.new as unknown as Notification;
            if (newRow.read_at) setCount((n) => Math.max(0, n - 1));
          } else if (payload.eventType === 'DELETE') {
            const oldRow = payload.old as Partial<Notification>;
            if (!oldRow.read_at) setCount((n) => Math.max(0, n - 1));
          }
        }
      )
      .onResync(() => void resync())
      .subscribe();

    return () => {
      cancelled = true;
      db.removeChannel(channel);
    };
  }, []);

  return count;
}
