import { afterEach, describe, expect, it, vi } from 'vitest';

// A fake data client: counts per query shape, and one recorded realtime handler per channel.
const h = vi.hoisted(() => {
  const state = {
    channels: [] as string[],
    removed: 0,
    handler: null as null | ((payload: Record<string, unknown>) => void),
    all: 3,
    bookings: 1,
  };
  const query = () => {
    let booking = false;
    const q = {
      select: () => q,
      in: () => { booking = true; return q; },
      is: () => q,
      gte: () => q,
      then: (resolve: (v: { count: number; error: null }) => void) => resolve({ count: booking ? state.bookings : state.all, error: null }),
    };
    return q;
  };
  const client = {
    from: () => query(),
    channel: (name: string) => {
      state.channels.push(name);
      const ch = {
        on: (_e: string, _f: unknown, cb: (payload: Record<string, unknown>) => void) => { state.handler = cb; return ch; },
        onResync: () => ch,
        subscribe: () => ch,
      };
      return ch;
    },
    removeChannel: () => { state.removed += 1; },
  };
  return { state, client };
});

vi.mock('@/lib/data/client', () => ({ createClient: () => h.client }));

import { subscribeUnreadCounts, unreadCountsSnapshot } from './use-unread-notifications';

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('unread notification counts', () => {
  afterEach(() => {
    h.state.channels = [];
    h.state.removed = 0;
  });

  it('opens one realtime channel for every reader on the page and closes it with the last', async () => {
    const leaveHeader = subscribeUnreadCounts(() => {});
    const leaveSidebar = subscribeUnreadCounts(() => {});
    expect(h.state.channels).toEqual(['notifications-unread-count']);
    await flush();
    expect(unreadCountsSnapshot()).toEqual({ all: 3, bookings: 1 });

    leaveHeader();
    expect(h.state.removed).toBe(0);
    leaveSidebar();
    expect(h.state.removed).toBe(1);
    expect(unreadCountsSnapshot()).toEqual({ all: 0, bookings: 0 });
  });

  it('adjusts the badge on inserts and recounts the booking dot only for booking alerts', async () => {
    const seen: number[] = [];
    const leave = subscribeUnreadCounts(() => seen.push(unreadCountsSnapshot().all));
    await flush();

    h.state.handler?.({ eventType: 'INSERT', new: { type: 'mention', read_at: null }, old: {} });
    expect(unreadCountsSnapshot().all).toBe(4);
    expect(unreadCountsSnapshot().bookings).toBe(1);

    h.state.bookings = 2;
    h.state.handler?.({ eventType: 'INSERT', new: { type: 'appointment_no_show', read_at: null }, old: {} });
    await flush();
    expect(unreadCountsSnapshot()).toEqual({ all: 5, bookings: 2 });

    h.state.handler?.({ eventType: 'UPDATE', new: { type: 'mention', read_at: '2026-11-20T10:00:00Z' }, old: {} });
    expect(unreadCountsSnapshot().all).toBe(4);
    leave();
    h.state.bookings = 1;
  });
});
