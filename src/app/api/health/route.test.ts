import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  appOk: true,
  platformConfigured: true,
  opsRow: null as Record<string, unknown> | null,
  opsCalls: 0,
}));
vi.mock('@/lib/db/prisma', () => {
  const app = { $queryRaw: vi.fn(async () => { if (!db.appOk) throw new Error('connect ECONNREFUSED db.internal:5432'); return []; }) };
  const tx = { $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
    if (!strings.join('').includes('crm_ops_health')) return [];
    db.opsCalls += 1;
    return [db.opsRow];
  }) };
  const platform = { $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)) };
  return { getPrisma: () => app, getPlatformPrisma: () => platform, platformDatabaseConfigured: () => db.platformConfigured };
});

import { GET } from './route';
import { __resetRateLimitForTests } from '@/lib/rate-limit';

const TOKEN = 'h'.repeat(48);
const row = { last_beat_age_s: 4, pending_due: BigInt(0), oldest_due_age_s: null, expired_running_leases: BigInt(0), failed_jobs_1h: BigInt(0),
  unknown_intents: BigInt(0), unprocessed_webhooks_15m: BigInt(0), latest_migration: '20261113090100_ops_health_fn' };
const call = (path = '/api/health', headers: Record<string, string> = {}) => GET(new Request(`https://app.example.com${path}`, { headers }));
const PLAIN = { status: 'ok', application: 'Bodhinox Chat' };

beforeEach(() => {
  db.appOk = true; db.platformConfigured = true; db.opsRow = { ...row }; db.opsCalls = 0;
  process.env.HEALTH_TOKEN = TOKEN;
  __resetRateLimitForTests();
});

describe('[OPS-01] GET /api/health', () => {
  it('plain liveness is unchanged: shape, no-store, 503 body when the database is down', async () => {
    const ok = await call();
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual(PLAIN);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    db.appOk = false;
    const down = await call();
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ status: 'unavailable' });
  });

  it('missing, wrong, URL-borne or unconfigured tokens get the plain response and never run the ops query', async () => {
    const attempts: Array<[string, Record<string, string>]> = [
      ['/api/health?deep=1', {}],
      ['/api/health?deep=1', { authorization: `Bearer ${TOKEN}x` }],
      ['/api/health?deep=1', { authorization: TOKEN }],
      [`/api/health?deep=1&token=${TOKEN}`, {}],
      [`/api/health?deep=1&authorization=Bearer%20${TOKEN}`, {}],
      ['/api/health', { authorization: `Bearer ${TOKEN}` }],
    ];
    for (const [path, headers] of attempts) {
      const response = await call(path, headers);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(PLAIN);
    }
    process.env.HEALTH_TOKEN = '';
    expect(await (await call('/api/health?deep=1', { authorization: 'Bearer ' })).json()).toEqual(PLAIN);
    delete process.env.HEALTH_TOKEN;
    expect(await (await call('/api/health?deep=1', { authorization: 'Bearer undefined' })).json()).toEqual(PLAIN);
    expect(db.opsCalls).toBe(0);
  });

  it('deep check with the token: shape, no-store, and no secret-looking strings', async () => {
    const response = await call('/api/health?deep=1', { authorization: `Bearer ${TOKEN}` });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body).toEqual({ status: 'ok', checks: { appDb: true, ops: 'ok', worker: { ageS: 4, ok: true },
      queue: { pendingDue: 0, oldestDueS: null, expiredLeases: 0, failed1h: 0 }, intents: { unknown: 0 },
      webhooks: { unprocessed15m: 0 }, migrations: { latest: '20261113090100_ops_health_fn' } } });
    const text = JSON.stringify(body);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toMatch(/postgres|password|secret|token|@|https?:|[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });

  it('a stale worker is 503 down; a failing app database or ops query leaks no error text', async () => {
    db.opsRow = { ...row, last_beat_age_s: 600 };
    const stale = await call('/api/health?deep=1', { authorization: `Bearer ${TOKEN}` });
    expect(stale.status).toBe(503);
    expect((await stale.json()).status).toBe('down');

    db.appOk = false; db.opsRow = null;
    const broken = await call('/api/health?deep=1', { authorization: `Bearer ${TOKEN}` });
    const text = await broken.text();
    expect(broken.status).toBe(503);
    expect(text).not.toMatch(/ECONNREFUSED|db\.internal|5432/);

    db.appOk = true; db.platformConfigured = false;
    const unconfigured = await (await call('/api/health?deep=1', { authorization: `Bearer ${TOKEN}` })).json();
    expect(unconfigured).toMatchObject({ status: 'degraded', checks: { ops: 'unconfigured' } });
  });

  it('the deep check is rate limited', async () => {
    let last: Response | undefined;
    for (let i = 0; i < 31; i++) last = await call('/api/health?deep=1', { authorization: `Bearer ${TOKEN}` });
    expect(last!.status).toBe(429);
    expect(db.opsCalls).toBe(30);
    // Liveness is never rate limited (Railway healthchecks).
    expect((await call()).status).toBe(200);
  });
});
