import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeEventCursor } from '@/lib/realtime/cursor';
import {
  LISTEN_SAFETY_MS,
  MAX_STREAMS_PER_USER,
  POLL_IDLE_MAX_MS,
  SESSION_RECHECK_MS,
} from '@/lib/realtime/stream-limits';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const h = vi.hoisted(() => ({
  session: null as null | Record<string, unknown>,
  requireSession: vi.fn(),
  resolveSession: vi.fn(),
  reads: [] as { at: number; values: unknown[] }[],
  pending: [] as { id: string; at: string; payload: unknown }[][],
  healthy: false,
  wakes: new Map<string, Set<() => void>>(),
}));
vi.mock('@/lib/auth/session', () => ({ requireSession: h.requireSession, resolveSession: h.resolveSession }));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (_context: unknown, operation: (tx: unknown) => unknown) =>
    operation({
      $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        h.reads.push({ at: Date.now(), values });
        return h.pending.shift() ?? [];
      },
    }),
}));
vi.mock('@/lib/inbox/masking-apply', () => ({
  loadPhoneMask: async () => false,
  maskRealtimePayload: (payload: unknown) => payload,
}));
vi.mock('@/lib/inbox/inbox-scope', () => ({
  conversationIdVisibleSql: () => 'true',
  visibilityRestricted: () => false,
}));
vi.mock('@/lib/realtime/outbox-listener', () => ({
  outboxListenerHealthy: () => h.healthy,
  onOutboxActivity: (accountId: string, wake: () => void) => {
    const set = h.wakes.get(accountId) ?? new Set();
    h.wakes.set(accountId, set);
    set.add(wake);
    return () => set.delete(wake);
  },
}));
const { GET } = await import('./route');

const cursor = encodeEventCursor({ at: '2026-11-19T00:00:00.000000Z', id: '00000000-0000-0000-0000-000000000000' });
const open: { abort: AbortController; output: () => string }[] = [];
async function stream(user = USER) {
  const abort = new AbortController();
  h.requireSession.mockResolvedValueOnce({ ...h.session, userId: user });
  const response = await GET(
    new Request(`https://app.test/api/events?tables=contacts,messages&cursor=${cursor}`, { signal: abort.signal })
  );
  let output = '';
  if (response.status === 200) {
    const reader = response.body!.getReader();
    void (async () => {
      for (;;) {
        const item = await reader.read().catch(() => ({ done: true as const, value: undefined }));
        if (item.done) break;
        output += new TextDecoder().decode(item.value);
      }
    })();
  }
  const handle = { abort, output: () => output, response };
  open.push(handle);
  return handle;
}
const flush = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const readsBetween = (from: number, to: number) => h.reads.filter((r) => r.at >= from && r.at < to).length;
const row = (n: number) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  at: '2026-11-19T00:00:01.000000Z',
  payload: { table: 'contacts', eventType: 'UPDATE', new: { id: `c${n}` }, old: {} },
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-19T00:00:00Z'));
  h.session = {
    userId: USER,
    accountId: ACCOUNT,
    role: 'agent',
    sessionId: 's',
    expiresAt: Date.now() / 1000 + 3600,
  };
  h.resolveSession.mockImplementation(async () => h.session);
  h.reads = [];
  h.pending = [];
  h.healthy = false;
  h.wakes.clear();
});
afterEach(async () => {
  for (const handle of open.splice(0)) handle.abort.abort();
  await flush(0);
  vi.useRealTimers();
  h.requireSession.mockReset();
  h.resolveSession.mockReset();
});

describe('/api/events idle back-off', () => {
  it('waits 2, 4, 8 then at most 10 s between empty reads, and resets to 2 s on activity', async () => {
    const start = Date.now();
    await stream();
    await flush(19_000);
    const gaps = h.reads.slice(1).map((r, i) => r.at - h.reads[i].at);
    expect(gaps.slice(0, 3)).toEqual([2000, 4000, 8000]);
    await flush(60_000);
    const all = h.reads.slice(1).map((r, i) => r.at - h.reads[i].at);
    expect(Math.max(...all)).toBeLessThanOrEqual(POLL_IDLE_MAX_MS);
    // Steady idle minute: at most one read per 10 s (was 30 per minute).
    expect(readsBetween(start + 60_000, start + 120_000)).toBeLessThanOrEqual(6);
    h.pending.push([row(1)]);
    const before = h.reads.length;
    await flush(10_000);
    const activityAt = h.reads[before].at;
    await flush(2000);
    expect(h.reads.find((r) => r.at > activityAt)!.at - activityAt).toBe(2000);
  });

  it('with a healthy listener sleeps until NOTIFY wakes it and reads within the wake gap', async () => {
    h.healthy = true;
    const start = Date.now();
    const handle = await stream();
    await flush(120_000);
    // Idle: one safety read per LISTEN_SAFETY_MS (the session re-check shares it).
    expect(readsBetween(start + 60_000, start + 120_000)).toBeLessThanOrEqual(60_000 / LISTEN_SAFETY_MS + 1);
    h.pending.push([row(7)]);
    const before = h.reads.length;
    for (const wake of h.wakes.get(ACCOUNT)!) wake();
    await flush(300);
    expect(h.reads.length).toBe(before + 1);
    expect(handle.output()).toContain('"c7"');
  });

  it('measures database round trips for one idle tab per minute', async () => {
    h.healthy = false;
    const start = Date.now();
    await stream();
    await flush(180_000);
    const polled = readsBetween(start + 120_000, start + 180_000);
    const sessions = h.resolveSession.mock.calls.length;
    h.healthy = true;
    h.reads = [];
    h.resolveSession.mockClear();
    const listened = Date.now();
    await stream('33333333-3333-4333-8333-333333333333');
    await flush(180_000);
    // Only the second stream reads now; the first keeps polling in parallel.
    const both = readsBetween(listened + 120_000, listened + 180_000);
    console.info(`[measure] idle tab reads/min: polling=${polled} (session checks so far ${sessions}), listen+poll streams=${both}`);
    expect(polled).toBeLessThanOrEqual(7);
  });
});

describe('/api/events session re-check', () => {
  it('does not resolve the session every read, and stops a revoked session within the re-check interval', async () => {
    const handle = await stream();
    await flush(SESSION_RECHECK_MS - 1);
    expect(h.resolveSession).not.toHaveBeenCalled();
    expect(h.reads.length).toBeGreaterThan(1);
    await flush(1);
    expect(h.resolveSession).toHaveBeenCalledTimes(1);
    h.resolveSession.mockResolvedValue(null);
    await flush(SESSION_RECHECK_MS);
    expect(handle.output()).toContain('event: revoked');
    const reads = h.reads.length;
    await flush(60_000);
    expect(h.reads.length).toBe(reads);
  });

  it('stops a revoked session within the interval even when the listener keeps the stream asleep', async () => {
    h.healthy = true;
    h.resolveSession.mockResolvedValue({ ...h.session, accountId: '44444444-4444-4444-8444-444444444444' });
    const handle = await stream();
    await flush(SESSION_RECHECK_MS);
    expect(handle.output()).toContain('event: revoked');
  });

  it('checks token expiry on time, not at the next poll', async () => {
    h.healthy = true;
    h.session!.expiresAt = Date.now() / 1000 + 5;
    const handle = await stream();
    await flush(5000);
    expect(handle.output()).toContain('event: expired');
  });
});

describe('/api/events per-user stream cap', () => {
  it(`allows ${MAX_STREAMS_PER_USER} concurrent streams per user, refuses the next with 429, and frees a slot on disconnect`, async () => {
    const streams = [];
    for (let i = 0; i < MAX_STREAMS_PER_USER; i++) streams.push(await stream());
    expect(streams.every((s) => s.response.status === 200)).toBe(true);
    const over = await stream();
    expect(over.response.status).toBe(429);
    expect(over.response.headers.get('Retry-After')).toBe('10');
    // Another user is not affected.
    expect((await stream('55555555-5555-4555-8555-555555555555')).response.status).toBe(200);
    streams[0].abort.abort();
    await flush(0);
    expect((await stream()).response.status).toBe(200);
  });

  it('frees the slot when the session is revoked', async () => {
    const streams = [];
    for (let i = 0; i < MAX_STREAMS_PER_USER; i++) streams.push(await stream());
    h.resolveSession.mockResolvedValue(null);
    await flush(SESSION_RECHECK_MS);
    h.resolveSession.mockImplementation(async () => h.session);
    expect((await stream()).response.status).toBe(200);
  });
});

describe('/api/events query scope', () => {
  it("reads only the session's account and user", async () => {
    await stream();
    expect(h.reads[0].values).toContain(ACCOUNT);
    expect(h.reads[0].values).toContain(USER);
  });
});
