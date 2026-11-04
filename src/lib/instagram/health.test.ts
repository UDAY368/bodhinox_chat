// Phase 11 T2: health check and token sweep without a database. While
// Instagram is off neither touches the database nor Instagram; the sweep keeps
// going after one account fails and never logs Meta's text.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const graph = vi.hoisted(() => ({ getMe: vi.fn(), refreshToken: vi.fn() }));
const db = vi.hoisted(() => ({ withTenant: vi.fn(), queryRaw: vi.fn(), executeRaw: vi.fn() }));

vi.mock('./graph', async (original) => ({ ...(await original<typeof import('./graph')>()), ...graph }));
vi.mock('@/lib/db/tenant', () => ({ withTenant: db.withTenant }));
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({ $queryRaw: db.queryRaw, $executeRaw: db.executeRaw }) }));

import { checkHealth } from './health';
import { resetInstagramScheduleForTests, scheduleInstagramSweeps, sweepInstagramTokens } from './token-sweep';
import { InstagramError } from './errors';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const IG = '44444444-4444-4444-8444-444444444444';

function enable() {
  vi.stubEnv('INSTAGRAM_ENABLED', 'true');
  vi.stubEnv('INSTAGRAM_APP_ID', '1234567890');
  vi.stubEnv('INSTAGRAM_APP_SECRET', 'test-only-ig-secret');
  vi.stubEnv('INSTAGRAM_WEBHOOK_VERIFY_TOKEN', 'test-only-verify');
  vi.stubEnv('APP_URL', 'https://app.example.test');
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('INSTAGRAM_ENABLED', '');
  for (const fn of [...Object.values(graph), ...Object.values(db)]) fn.mockReset();
  resetInstagramScheduleForTests();
});
afterEach(() => vi.unstubAllEnvs());

describe('while Instagram is off', () => {
  it('health, sweep and scheduling do nothing', async () => {
    await expect(checkHealth(ACCOUNT, IG)).rejects.toMatchObject({ code: 'instagram_not_enabled' });
    expect(await sweepInstagramTokens(ACCOUNT)).toEqual({ refreshed: 0, checked: 0, failures: 0 });
    expect(await scheduleInstagramSweeps(Date.now(), true)).toBe(0);
    for (const fn of [...Object.values(graph), ...Object.values(db)]) expect(fn).not.toHaveBeenCalled();
  });
});

describe('when enabled', () => {
  it('a missing account is not_found with no Instagram call', async () => {
    enable();
    db.withTenant.mockImplementation(async (_ctx: unknown, work: (tx: unknown) => unknown) =>
      work({ $queryRaw: async () => [], $executeRaw: async () => 0 }));
    const error = await checkHealth(ACCOUNT, IG).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InstagramError);
    expect((error as InstagramError).code).toBe('not_found');
    expect(graph.getMe).not.toHaveBeenCalled();
  });

  it('the scheduler acts at most once an hour and queues one deduped job per listed workspace', async () => {
    enable();
    db.queryRaw.mockResolvedValue([{ account_id: ACCOUNT }]);
    db.executeRaw.mockResolvedValue(1);
    const now = Date.UTC(2026, 10, 4, 12);
    expect(await scheduleInstagramSweeps(now)).toBe(1);
    expect(await scheduleInstagramSweeps(now + 30 * 60_000)).toBe(0);
    expect(db.executeRaw).toHaveBeenCalledTimes(1);
    const values = db.executeRaw.mock.calls[0].slice(1);
    expect(values).toContain(`igsweep:${ACCOUNT}:${Math.floor(now / 86_400_000)}`);
  });

  it('a sweep keeps going after one account fails and logs no Meta text', async () => {
    enable();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rows = [
      { id: IG, status: 'active', access_token_enc: null, token_refreshed_at: new Date(), token_expires_at: new Date() },
      { id: '55555555-5555-4555-8555-555555555555', status: 'active', access_token_enc: null, token_refreshed_at: new Date(), token_expires_at: new Date() },
    ];
    let call = 0;
    db.withTenant.mockImplementation(async (_ctx: unknown, work: (tx: unknown) => unknown) => {
      call++;
      if (call === 1) return work({ $queryRaw: async () => rows });
      // Each health lookup fails: the database is down.
      throw new Error('secret Meta text');
    });
    expect(await sweepInstagramTokens(ACCOUNT)).toEqual({ refreshed: 0, checked: 0, failures: 2 });
    expect(JSON.stringify(errors.mock.calls)).not.toContain('secret Meta text');
    errors.mockRestore();
  });
});
