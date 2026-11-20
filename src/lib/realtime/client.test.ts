import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRealtimeChannel, HUB_REOPEN_DEBOUNCE_MS, resetRealtimeHub } from './client';
const h = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('@/lib/auth/client', () => ({ authFetch: h.authFetch }));
class Source {
  static all: Source[] = [];
  onopen?: () => void;
  onerror?: () => void;
  closed = false;
  listeners: Record<string, ((event: unknown) => void)[]> = {};
  constructor(readonly url: string) {
    Source.all.push(this);
  }
  addEventListener(name: string, callback: (event: unknown) => void) {
    (this.listeners[name] ??= []).push(callback);
  }
  close() {
    this.closed = true;
  }
  emit(name: string, data: unknown, id = '') {
    for (const callback of this.listeners[name] ?? [])
      callback({ data: JSON.stringify(data), lastEventId: id });
  }
  get tables() {
    return new URL(this.url, 'https://x.test').searchParams.get('tables');
  }
}
const live = () => Source.all.filter((s) => !s.closed);
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('EventSource', Source);
});
afterEach(() => {
  resetRealtimeHub();
  vi.useRealTimers();
  h.authFetch.mockReset();
  vi.unstubAllGlobals();
  Source.all = [];
});
const flush = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

it('opens one stream for many channels and fans events out to the matching ones', async () => {
  const contacts: unknown[] = [];
  const messages: unknown[] = [];
  const statuses: string[] = [];
  const a = createRealtimeChannel('a')
    .on('postgres_changes', { table: 'contacts' }, (e) => contacts.push(e))
    .subscribe((s) => statuses.push(`a:${s}`));
  const b = createRealtimeChannel('b')
    .on('postgres_changes', { table: 'messages' }, (e) => messages.push(e))
    .subscribe((s) => statuses.push(`b:${s}`));
  const c = createRealtimeChannel('c')
    .on('postgres_changes', { table: 'messages', event: 'INSERT' }, () => {})
    .subscribe();
  await flush();
  expect(Source.all).toHaveLength(1);
  expect(Source.all[0].tables).toBe('contacts,messages');
  Source.all[0].onopen!();
  expect(statuses).toEqual(['a:SUBSCRIBED', 'b:SUBSCRIBED']);
  Source.all[0].emit('change', { table: 'messages', eventType: 'UPDATE', new: { id: 'm' }, old: {} }, 'c1');
  Source.all[0].emit('change', { table: 'contacts', eventType: 'INSERT', new: { id: 'k' }, old: {} }, 'c2');
  expect(messages).toHaveLength(1);
  expect(contacts).toHaveLength(1);
  await Promise.all([a.unsubscribe(), b.unsubscribe(), c.unsubscribe()]);
});

it('re-opens once, debounced, with the cursor when the table union changes, and resyncs only the new channel', async () => {
  let resyncA = 0;
  let resyncB = 0;
  const a = createRealtimeChannel('a')
    .on('postgres_changes', { table: 'contacts' }, () => {})
    .onResync(() => resyncA++)
    .subscribe();
  await flush();
  const first = Source.all[0];
  first.onopen!();
  first.emit('resync', { reason: 'snapshot-required', cursor: 'start' });
  first.emit('change', { table: 'contacts', eventType: 'UPDATE', new: { id: 'a' }, old: {} }, 'cur-1');
  expect(resyncA).toBe(1);
  const b = createRealtimeChannel('b')
    .on('postgres_changes', { table: 'deals' }, () => {})
    .onResync(() => resyncB++)
    .subscribe();
  createRealtimeChannel('b2').on('postgres_changes', { table: 'notifications' }, () => {}).subscribe();
  await flush(HUB_REOPEN_DEBOUNCE_MS - 1);
  expect(Source.all).toHaveLength(1);
  await flush(1);
  expect(Source.all).toHaveLength(2);
  expect(first.closed).toBe(true);
  const second = Source.all[1];
  expect(second.tables).toBe('contacts,deals,notifications');
  expect(second.url).toContain('cursor=cur-1');
  second.onopen!();
  second.emit('resync', { reason: 'snapshot-required', cursor: 'cur-1' });
  expect(resyncB).toBe(1);
  expect(resyncA).toBe(1); // served continuously, no reload
  // The periodic snapshot reaches every channel.
  second.emit('resync', { reason: 'periodic-snapshot', cursor: 'cur-1' });
  expect(resyncA).toBe(2);
  expect(resyncB).toBe(2);
  // A channel whose tables are already open joins without a re-open and still gets its snapshot.
  let resyncC = 0;
  createRealtimeChannel('c').on('postgres_changes', { table: 'deals' }, () => {}).onResync(() => resyncC++).subscribe();
  await flush(HUB_REOPEN_DEBOUNCE_MS);
  expect(Source.all).toHaveLength(2);
  expect(resyncC).toBe(1);
  await b.unsubscribe();
  await a.unsubscribe();
});

it('closes the stream only when the last channel leaves, and narrows the union when one leaves', async () => {
  const a = createRealtimeChannel('a').on('postgres_changes', { table: 'contacts' }, () => {}).subscribe();
  const b = createRealtimeChannel('b').on('postgres_changes', { table: 'deals' }, () => {}).subscribe();
  await flush();
  Source.all[0].onopen!();
  await b.unsubscribe();
  await flush(HUB_REOPEN_DEBOUNCE_MS);
  expect(live()).toHaveLength(1);
  expect(live()[0].tables).toBe('contacts');
  await a.unsubscribe();
  expect(live()).toHaveLength(1); // a remount within the debounce keeps the stream
  await flush(HUB_REOPEN_DEBOUNCE_MS);
  expect(live()).toHaveLength(0);
});

it('a remount inside the debounce keeps the same stream', async () => {
  const a = createRealtimeChannel('a').on('postgres_changes', { table: 'contacts' }, () => {}).subscribe();
  await flush();
  Source.all[0].onopen!();
  await a.unsubscribe();
  let resync = 0;
  const again = createRealtimeChannel('a').on('postgres_changes', { table: 'contacts' }, () => {}).onResync(() => resync++).subscribe();
  await flush(HUB_REOPEN_DEBOUNCE_MS * 2);
  expect(Source.all).toHaveLength(1);
  expect(Source.all[0].closed).toBe(false);
  expect(resync).toBe(1);
  await again.unsubscribe();
});

it('refreshes expired authentication before resuming a cursor, resyncs every channel, and stops when refresh is denied', async () => {
  h.authFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));
  const statuses: string[] = [];
  let resyncA = 0;
  let resyncB = 0;
  const a = createRealtimeChannel('resume')
    .on('postgres_changes', { table: 'contacts' }, () => {})
    .onResync(() => resyncA++)
    .subscribe((status) => statuses.push(status));
  createRealtimeChannel('other').on('postgres_changes', { table: 'contacts' }, () => {}).onResync(() => resyncB++).subscribe();
  await flush();
  Source.all[0].emit('resync', { reason: 'snapshot-required', cursor: 'x' });
  Source.all[0].emit(
    'change',
    { table: 'contacts', eventType: 'UPDATE', new: { id: 'a' }, old: {} },
    'resume-cursor'
  );
  Source.all[0].emit('expired', {});
  expect(Source.all[0].closed).toBe(true);
  expect(statuses.at(-1)).toBe('CHANNEL_ERROR');
  expect(Source.all).toHaveLength(1);
  await flush(1000);
  expect(h.authFetch).toHaveBeenCalledWith('/api/auth/session', {
    cache: 'no-store',
  });
  expect(Source.all).toHaveLength(2);
  expect(Source.all[1].url).toContain('cursor=resume-cursor');
  Source.all[1].emit('resync', { reason: 'snapshot-required', cursor: 'resume-cursor' });
  expect([resyncA, resyncB]).toEqual([2, 2]);
  h.authFetch.mockResolvedValueOnce(new Response('{}', { status: 401 }));
  Source.all[1].emit('expired', {});
  await flush(2000);
  expect(statuses.at(-1)).toBe('CLOSED');
  expect(Source.all).toHaveLength(2);
  await a.unsubscribe();
});

it('filters changes and deduplicates replay IDs', async () => {
  const changes: unknown[] = [];
  const channel = createRealtimeChannel('test')
    .on(
      'postgres_changes',
      { table: 'contacts', event: '*', filter: 'id=eq.a' },
      (event) => changes.push(event)
    )
    .subscribe();
  await flush();
  const source = Source.all[0];
  const payload = {
    table: 'contacts',
    eventType: 'UPDATE',
    new: { id: 'a' },
    old: { id: 'a' },
  };
  source.emit('change', payload, 'cursor1');
  source.emit('change', payload, 'cursor1');
  source.emit(
    'change',
    { ...payload, new: { id: 'b' }, old: { id: 'b' } },
    'cursor2'
  );
  expect(changes).toHaveLength(1);
  await channel.unsubscribe();
});

it('reports honest degraded state without EventSource and closes every channel when the session is revoked', async () => {
  vi.stubGlobal('EventSource', undefined);
  const statuses: string[] = [];
  createRealtimeChannel('missing')
    .on('postgres_changes', { table: 'contacts' }, () => {})
    .subscribe((status) => statuses.push(status));
  expect(statuses).toEqual(['CHANNEL_ERROR']);
  vi.stubGlobal('EventSource', Source);
  createRealtimeChannel('revoked')
    .on('postgres_changes', { table: 'contacts' }, () => {})
    .subscribe((status) => statuses.push(`a:${status}`));
  createRealtimeChannel('revoked2')
    .on('postgres_changes', { table: 'deals' }, () => {})
    .subscribe((status) => statuses.push(`b:${status}`));
  await flush();
  Source.all[0].emit('revoked', {});
  expect(Source.all[0].closed).toBe(true);
  expect(statuses.slice(-2)).toEqual(['a:CLOSED', 'b:CLOSED']);
  await flush(60_000);
  expect(Source.all).toHaveLength(1);
});

it('subscribes to note events for one conversation and delivers inserts', async () => {
  const changes: unknown[] = [];
  const channel = createRealtimeChannel('notes')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'conversation_notes', filter: 'conversation_id=eq.c1' },
      (event) => changes.push(event)
    )
    .subscribe();
  await flush();
  const source = Source.all[0];
  expect(source.url).toContain('tables=conversation_notes');
  source.emit('change', { table: 'conversation_notes', eventType: 'INSERT', new: { id: 'n1', conversation_id: 'c1' }, old: {} }, 'n-1');
  source.emit('change', { table: 'conversation_notes', eventType: 'INSERT', new: { id: 'n2', conversation_id: 'c2' }, old: {} }, 'n-2');
  expect(changes).toHaveLength(1);
  await channel.unsubscribe();
});
