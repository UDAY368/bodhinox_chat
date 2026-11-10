'use client';

import { useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/data/client';
import type { Channel, Conversation } from '@/types';

/** Conversations with at least one unread inbound message: per channel, and in all. */
export interface UnreadCounts {
  all: number;
  whatsapp: number;
  instagram: number;
}

type Row = { unread: number; channel: Channel };

export const NO_UNREAD: UnreadCounts = { all: 0, whatsapp: 0, instagram: 0 };

/** A conversation's channel; legacy rows with no channel are WhatsApp. */
export function rowChannel(channel: unknown): Channel {
  return channel === 'instagram' ? 'instagram' : 'whatsapp';
}

/** Pure: the counts from the {id: row} mirror. */
export function countUnread(rows: Iterable<Row>): UnreadCounts {
  const counts = { ...NO_UNREAD };
  for (const row of rows) {
    if (row.unread <= 0) continue;
    counts.all += 1;
    counts[row.channel] += 1;
  }
  return counts;
}

/**
 * Pure: applies one realtime change to the mirror. An update without the
 * channel column keeps the channel already known for that conversation (a
 * conversation never changes channel).
 */
export function applyUnreadChange(
  rows: Map<string, Row>,
  change: { eventType: string; new?: unknown; old?: unknown },
): void {
  if (change.eventType === 'DELETE') {
    const oldRow = (change.old ?? {}) as Partial<Conversation>;
    if (oldRow.id) rows.delete(oldRow.id);
    return;
  }
  const row = (change.new ?? {}) as Partial<Conversation>;
  if (!row.id) return;
  const channel = row.channel !== undefined ? rowChannel(row.channel) : (rows.get(row.id)?.channel ?? 'whatsapp');
  rows.set(row.id, { unread: row.unread_count ?? 0, channel });
}

/**
 * Unread conversations for the current user, split by channel, so each
 * inbox in the sidebar carries its own badge and "All inboxes" the total.
 *
 * Lives on its own realtime channel (distinct from the inbox page's
 * "inbox-realtime") so both can coexist without sharing state. Reads only
 * ids, counts and channels: no message content.
 */
export function useTotalUnread(): UnreadCounts {
  const [counts, setCounts] = useState<UnreadCounts>(NO_UNREAD);

  // A live local mirror of {id: {unread, channel}} so INSERT/UPDATE/DELETE
  // events adjust the counts without refetching.
  const rowsRef = useRef<Map<string, Row>>(new Map());

  useEffect(() => {
    const db = createClient();
    let cancelled = false;

    // Initial load. RLS scopes this to the signed-in user's workspace.
    const resync = async () => {
      const { data, error } = await db
        .from('conversations')
        .select('id, unread_count, channel');
      if (cancelled || error || !data) return;

      const rows = new Map<string, Row>();
      for (const row of data as { id: string; unread_count: number | null; channel: string | null }[])
        rows.set(row.id, { unread: row.unread_count ?? 0, channel: rowChannel(row.channel) });
      rowsRef.current = rows;
      setCounts(countUnread(rows.values()));
    };
    void resync();

    const channel = db
      .channel('total-unread-realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'conversations' },
        (payload) => {
          applyUnreadChange(rowsRef.current, payload);
          // Recompute: cheap, conversations per workspace stay small.
          setCounts(countUnread(rowsRef.current.values()));
        }
      )
      .onResync(() => void resync())
      .subscribe();

    return () => {
      cancelled = true;
      db.removeChannel(channel);
    };
  }, []);

  return counts;
}
