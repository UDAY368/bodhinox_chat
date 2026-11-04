// Phase 11 review fixes I4/I5 without a database: the callback's plan-room
// decision and the unsubscribe after a lost room race. The tenant transaction
// is faked: each SQL statement is answered from a small in-memory state.
//   - a reconnect of an account this workspace holds live skips the room check
//   - a new (or previously disconnected) account still needs room
//   - after a PlanLimitError the subscription is dropped only when no
//     workspace holds the Instagram account live, re-checked at that moment
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanLimitError } from '@/lib/billing/entitlements';

const graph = vi.hoisted(() => ({
  exchangeCode: vi.fn(), exchangeLongLived: vi.fn(), getMe: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(),
}));
const billing = vi.hoisted(() => ({ requireFeature: vi.fn(), requireRoomFor: vi.fn() }));
const state = vi.hoisted(() => ({
  /** ig_user_id rows this workspace holds live. */
  held: new Set<string>(),
  /** Answers of crm_instagram_owner_account, in call order (last one repeats). */
  owners: [] as (string | null)[],
  ownerCalls: 0,
  limit: 1,
  live: 0,
}));

vi.mock('./graph', async (original) => ({ ...(await original<typeof import('./graph')>()), ...graph }));
vi.mock('@/lib/billing/entitlements', async (original) => ({ ...(await original<typeof import('@/lib/billing/entitlements')>()), ...billing }));
vi.mock('@/lib/payments/ledger', () => ({ auditTx: vi.fn() }));
vi.mock('@/lib/whatsapp/encryption', () => ({ encrypt: (v: string) => `enc:${v}`, decrypt: (v: string) => v.replace(/^enc:/, '') }));
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({}) }));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (_ctx: unknown, work: (tx: unknown) => Promise<unknown>) => work({
    $executeRaw: async () => 0,
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('crm_instagram_owner_account')) {
        const answer = state.owners[Math.min(state.ownerCalls++, state.owners.length - 1)] ?? null;
        if (answer === 'throw') throw new Error('database unavailable');
        return [{ owner: answer }];
      }
      if (sql.includes('INSERT INTO instagram_accounts')) return [{ id: 'row-1' }];
      if (sql.includes('SELECT id::text AS id FROM instagram_accounts') && sql.includes('ig_user_id=')) {
        return state.held.has(String(values[1])) ? [{ id: 'row-held' }] : [];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  }),
}));

import { finishConnect, signInstagramState } from './connection';
import { InstagramError } from './errors';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const OTHER_ACCOUNT = '33333333-3333-4333-8333-333333333333';
const USER = '22222222-2222-4222-8222-222222222222';
const admin = { accountId: ACCOUNT, userId: USER, role: 'admin' as const };
const SECRET = 'test-only-ig-secret';
const NONCE = 'n'.repeat(32);
const IG = '17841400000000001';
const SCOPES = ['instagram_business_basic', 'instagram_business_manage_messages'];

const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof InstagramError ? e.code : String(e)));
const callback = () => finishConnect(admin, {
  state: NONCE, code: 'abc',
  cookieState: signInstagramState(SECRET, { nonce: NONCE, accountId: ACCOUNT, userId: USER, expiresAt: Date.now() + 60_000, comments: false }),
});

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('INSTAGRAM_ENABLED', 'true');
  vi.stubEnv('INSTAGRAM_APP_ID', '1234567890');
  vi.stubEnv('INSTAGRAM_APP_SECRET', SECRET);
  vi.stubEnv('INSTAGRAM_WEBHOOK_VERIFY_TOKEN', 'test-only-verify');
  vi.stubEnv('APP_URL', 'https://app.example.test');
  for (const fn of [...Object.values(graph), ...Object.values(billing)]) fn.mockReset();
  Object.assign(state, { held: new Set<string>(), owners: [null], ownerCalls: 0, limit: 1, live: 1 });
  graph.exchangeCode.mockResolvedValue({ accessToken: 'test-only-short', userId: IG, scopes: SCOPES });
  graph.exchangeLongLived.mockResolvedValue({ accessToken: 'test-only-long', expiresInSeconds: 5_184_000 });
  graph.getMe.mockResolvedValue({ userId: IG, username: 'shop', name: 'Shop' });
  graph.subscribe.mockResolvedValue(undefined);
  graph.unsubscribe.mockResolvedValue(undefined);
  billing.requireFeature.mockResolvedValue(undefined);
  // The workspace is full: `live` other accounts against a limit of `limit`.
  billing.requireRoomFor.mockImplementation(async () => {
    if (state.live + 1 > state.limit) throw new PlanLimitError('full');
  });
});

describe('plan room on connect (I4)', () => {
  it('a reconnect of an account the workspace still holds (e.g. token_invalid) never needs room', async () => {
    state.held.add(IG);
    state.owners = [ACCOUNT];
    expect(await codeOf(callback())).toBe('ok');
    expect(billing.requireRoomFor).not.toHaveBeenCalled();
    expect(graph.subscribe).toHaveBeenCalledTimes(1);
  });

  it('a new or previously disconnected account in a full workspace is refused before subscribing', async () => {
    expect(await codeOf(callback())).toBe('limit_reached');
    expect(billing.requireRoomFor).toHaveBeenCalledTimes(1);
    expect(graph.subscribe).not.toHaveBeenCalled();
  });

  it('a new account with room connects after both room checks', async () => {
    state.live = 0;
    expect(await codeOf(callback())).toBe('ok');
    expect(billing.requireRoomFor).toHaveBeenCalledTimes(2);
  });
});

describe('subscription after a lost room race (I5)', () => {
  // The pre-check passes, then the slot is taken while Instagram is called.
  const loseRaceDuringSubscribe = () => graph.subscribe.mockImplementation(async () => { state.live = 1; });

  it('keeps the subscription when another workspace now holds the account live', async () => {
    state.live = 0;
    state.owners = [null, OTHER_ACCOUNT];
    loseRaceDuringSubscribe();
    expect(await codeOf(callback())).toBe('limit_reached');
    expect(state.ownerCalls).toBe(2);
    expect(graph.unsubscribe).not.toHaveBeenCalled();
  });

  it('keeps the subscription when the holder cannot be determined', async () => {
    state.live = 0;
    state.owners = [null, 'throw'];
    loseRaceDuringSubscribe();
    expect(await codeOf(callback())).toBe('limit_reached');
    expect(graph.unsubscribe).not.toHaveBeenCalled();
  });

  it('drops its own subscription when nobody holds the account live', async () => {
    state.live = 0;
    state.owners = [null, null];
    loseRaceDuringSubscribe();
    expect(await codeOf(callback())).toBe('limit_reached');
    expect(graph.unsubscribe).toHaveBeenCalledTimes(1);
    expect(graph.unsubscribe).toHaveBeenCalledWith(IG, 'test-only-long');
  });
});
