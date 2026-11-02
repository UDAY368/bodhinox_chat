import { afterEach, expect, it, vi } from 'vitest';
import { createRealtimeChannel } from './client';
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
}
afterEach(() => {
  vi.useRealTimers();
  h.authFetch.mockReset();
  vi.unstubAllGlobals();
  Source.all = [];
});
it('refreshes expired authentication before resuming a cursor and stops when refresh is denied', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('EventSource', Source);
  h.authFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));
  const statuses: string[] = [];
  const channel = createRealtimeChannel('resume')
    .on('postgres_changes', { table: 'contacts' }, () => {})
    .subscribe((status) => statuses.push(status));
  Source.all[0].emit(
    'change',
    { table: 'contacts', eventType: 'UPDATE', new: { id: 'a' }, old: {} },
    'resume-cursor'
  );
  Source.all[0].emit('expired', {});
  expect(Source.all[0].closed).toBe(true);
  expect(Source.all).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(h.authFetch).toHaveBeenCalledWith('/api/auth/session', {
    cache: 'no-store',
  });
  expect(Source.all).toHaveLength(2);
  expect(Source.all[1].url).toContain('cursor=resume-cursor');
  h.authFetch.mockResolvedValueOnce(new Response('{}', { status: 401 }));
  Source.all[1].emit('expired', {});
  await vi.advanceTimersByTimeAsync(2000);
  expect(statuses.at(-1)).toBe('CLOSED');
  expect(Source.all).toHaveLength(2);
  await channel.unsubscribe();
});
it('filters changes, deduplicates replay IDs and requests authoritative resync', async () => {
  vi.stubGlobal('EventSource', Source);
  const changes: unknown[] = [];
  let resync = 0;
  const channel = createRealtimeChannel('test')
    .on(
      'postgres_changes',
      { table: 'contacts', event: '*', filter: 'id=eq.a' },
      (event) => changes.push(event)
    )
    .onResync(() => resync++)
    .subscribe();
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
  source.emit('resync', { cursor: 'checkpoint' });
  expect(changes).toHaveLength(1);
  expect(resync).toBe(1);
  await channel.unsubscribe();
  expect(source.closed).toBe(true);
});
it('reports honest degraded state without EventSource and closes revoked streams', async () => {
  vi.stubGlobal('EventSource', undefined);
  const statuses: string[] = [];
  createRealtimeChannel('missing')
    .on('postgres_changes', { table: 'contacts' }, () => {})
    .subscribe((status) => statuses.push(status));
  expect(statuses).toEqual(['CHANNEL_ERROR']);
  vi.stubGlobal('EventSource', Source);
  const channel = createRealtimeChannel('revoked')
    .on('postgres_changes', { table: 'contacts' }, () => {})
    .subscribe((status) => statuses.push(status));
  Source.all[0].emit('revoked', {});
  expect(Source.all[0].closed).toBe(true);
  expect(statuses.at(-1)).toBe('CLOSED');
  await channel.unsubscribe();
});
it('subscribes to note events for one conversation and delivers inserts', async () => {
  vi.stubGlobal('EventSource', Source);
  const changes: unknown[] = [];
  const channel = createRealtimeChannel('notes')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'conversation_notes', filter: 'conversation_id=eq.c1' },
      (event) => changes.push(event)
    )
    .subscribe();
  const source = Source.all[0];
  expect(source.url).toContain('tables=conversation_notes');
  source.emit('change', { table: 'conversation_notes', eventType: 'INSERT', new: { id: 'n1', conversation_id: 'c1' }, old: {} }, 'n-1');
  source.emit('change', { table: 'conversation_notes', eventType: 'INSERT', new: { id: 'n2', conversation_id: 'c2' }, old: {} }, 'n-2');
  expect(changes).toHaveLength(1);
  await channel.unsubscribe();
});
