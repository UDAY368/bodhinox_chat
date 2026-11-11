// Stage 3: accounts connected before live_comments existed are subscribed again,
// once per workspace, with the full field list for their granted scopes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MetaApiError } from '@/lib/whatsapp/meta-api';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const COMMENTS = 'instagram_business_manage_comments';
const DM = ['instagram_business_basic', 'instagram_business_manage_messages'];

const h = vi.hoisted(() => ({
  rows: [] as unknown[], accounts: [] as unknown[], queued: [] as unknown[][],
  subscribe: vi.fn(), health: vi.fn(), failListing: false,
}));
vi.mock('@/lib/db/prisma', () => ({
  getWorkerPrisma: () => ({
    $queryRaw: async () => {
      if (h.failListing) throw new Error('function crm_instagram_accounts_for_sweep() does not exist 42883');
      return h.accounts;
    },
    $executeRaw: async (...args: unknown[]) => { h.queued.push(args); return 1; },
  }),
}));
vi.mock('./connection', async (original) => ({
  ...(await original<typeof import('./connection')>()),
  asWorker: async (_id: string, work: (tx: unknown) => unknown) => work({ $queryRaw: async () => h.rows }),
  readToken: (row: { access_token_enc: string | null }) => (row.access_token_enc === 'bad' ? null : row.access_token_enc ? `tok-${row.access_token_enc}` : null),
}));
vi.mock('./graph', async (original) => ({ ...(await original<typeof import('./graph')>()), subscribe: h.subscribe }));
vi.mock('./health', () => ({ recordHealthTx: h.health }));

import { RESUBSCRIBE_VERSION, resetInstagramResubscribeForTests, runResubscribe, scheduleInstagramResubscribe } from './resubscribe';
import { webhookFieldsFor } from './connection';

const env = {
  INSTAGRAM_ENABLED: 'true', INSTAGRAM_APP_ID: '123', INSTAGRAM_APP_SECRET: 's',
  INSTAGRAM_WEBHOOK_VERIFY_TOKEN: 'v', APP_URL: 'https://app.example.test',
};
const row = (id: string, scopes: string[], enc: string | null = 'enc') => ({ id, ig_user_id: `1784${id}`, access_token_enc: enc, scopes });

beforeEach(() => {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  h.rows = []; h.accounts = []; h.queued = []; h.failListing = false;
  h.subscribe.mockReset(); h.subscribe.mockResolvedValue(undefined); h.health.mockReset();
  resetInstagramResubscribeForTests();
});
afterEach(() => vi.unstubAllEnvs());

describe('webhookFieldsFor', () => {
  it('adds comments and live_comments only with the comments scope', () => {
    expect(webhookFieldsFor(DM)).toEqual(['messages', 'messaging_postbacks']);
    expect(webhookFieldsFor([...DM, COMMENTS])).toEqual(['messages', 'messaging_postbacks', 'comments', 'live_comments']);
  });
});

describe('runResubscribe', () => {
  it('subscribes each active account that holds the comments scope with the full field list', async () => {
    h.rows = [row('1', [...DM, COMMENTS]), row('2', DM)];
    expect(await runResubscribe(ACCOUNT)).toEqual({ subscribed: 1, skipped: 1, failures: 0 });
    expect(h.subscribe).toHaveBeenCalledTimes(1);
    expect(h.subscribe).toHaveBeenCalledWith('17841', 'tok-enc', ['messages', 'messaging_postbacks', 'comments', 'live_comments']);
  });

  it('skips an account whose token cannot be read, and does nothing while Instagram is off', async () => {
    h.rows = [row('1', [...DM, COMMENTS], 'bad'), row('2', [...DM, COMMENTS], null)];
    expect(await runResubscribe(ACCOUNT)).toEqual({ subscribed: 0, skipped: 2, failures: 0 });
    expect(h.subscribe).not.toHaveBeenCalled();
    vi.stubEnv('INSTAGRAM_ENABLED', '');
    h.rows = [row('3', [...DM, COMMENTS])];
    expect(await runResubscribe(ACCOUNT)).toEqual({ subscribed: 0, skipped: 0, failures: 0 });
    expect(h.subscribe).not.toHaveBeenCalled();
  });

  it('records a rejected token and goes on with the next account', async () => {
    h.rows = [row('1', [...DM, COMMENTS]), row('2', [...DM, COMMENTS])];
    h.subscribe.mockRejectedValueOnce(new MetaApiError('Meta API error', { httpStatus: 400, code: 190 } as never));
    const summary = await runResubscribe(ACCOUNT);
    expect(summary.subscribed).toBe(1);
    expect(summary.failures).toBe(1);
    expect(h.health).toHaveBeenCalledTimes(1);
    expect(h.health.mock.calls[0].slice(2, 5)).toEqual(['1', 'enc', 'token_invalid']);
  });

  it('retries the job after a throttle, and logs another failure by status only', async () => {
    h.rows = [row('1', [...DM, COMMENTS])];
    h.subscribe.mockRejectedValueOnce(new MetaApiError('Meta API error', { httpStatus: 429, code: 4 } as never));
    await expect(runResubscribe(ACCOUNT)).rejects.toThrow('throttled');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.subscribe.mockRejectedValueOnce(new MetaApiError('secret detail from Meta', { httpStatus: 500 } as never));
    expect(await runResubscribe(ACCOUNT)).toMatchObject({ failures: 1 });
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret detail');
    log.mockRestore();
  });
});

describe('scheduleInstagramResubscribe', () => {
  it('queues one job per workspace under a version key, at most once an hour, and nothing while off', async () => {
    h.accounts = [{ account_id: ACCOUNT }, { account_id: '22222222-2222-4222-8222-222222222222' }];
    expect(await scheduleInstagramResubscribe(1_000)).toBe(2);
    expect(h.queued).toHaveLength(2);
    expect(JSON.stringify(h.queued[0])).toContain(`igresub:${RESUBSCRIBE_VERSION}:${ACCOUNT}`);
    expect(await scheduleInstagramResubscribe(2_000)).toBe(0);
    expect(await scheduleInstagramResubscribe(2_000, true)).toBe(2);
    vi.stubEnv('INSTAGRAM_ENABLED', '');
    expect(await scheduleInstagramResubscribe(9_999_999_999, true)).toBe(0);
  });

  it('does nothing when the sweep function is not deployed yet', async () => {
    h.failListing = true;
    expect(await scheduleInstagramResubscribe(1_000)).toBe(0);
    expect(h.queued).toHaveLength(0);
  });
});
