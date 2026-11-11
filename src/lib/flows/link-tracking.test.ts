// Stage 5 (5F) link tracking without a database: the CTR maths, which
// destinations may be tracked, and the cases where trackedUrl sends the link
// untracked instead of writing a row (dry run, a bad URL, malformed run ids).
// The SQL paths (token reuse, click counting, tenancy) are covered by
// link-tracking.integration.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ dryRun: false, writes: 0 }));
vi.mock('@/lib/runtime/dry-run-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/runtime/dry-run-guard')>()),
  isDryRun: () => h.dryRun,
}));
vi.mock('@/lib/db/tenant', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db/tenant')>()),
  withTenant: async () => { h.writes++; return [{ token: 'a'.repeat(32) }]; },
}));
vi.mock('@/lib/db/prisma', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db/prisma')>()),
  getWorkerPrisma: () => ({}),
}));

import { clickThroughRate, flowLinkUrl, linkClicked, trackedUrl, validFlowLinkUrl, type TrackedLinkRun } from './link-tracking';

const run: TrackedLinkRun = {
  id: '33333333-3333-4333-8333-333333333333',
  account_id: '11111111-1111-4111-8111-111111111111',
  flow_id: '22222222-2222-4222-8222-222222222222',
  contact_id: null,
  conversation_id: null,
};

afterEach(() => { h.dryRun = false; h.writes = 0; vi.unstubAllEnvs(); });

describe('clickThroughRate', () => {
  it('is runs with a click over runs sent a tracked link, as a whole percent', () => {
    expect(clickThroughRate({ sent: 4, clicked: 1 })).toBe(25);
    expect(clickThroughRate({ sent: 3, clicked: 1 })).toBe(33);
    expect(clickThroughRate({ sent: 3, clicked: 2 })).toBe(67);
    expect(clickThroughRate({ sent: 5, clicked: 5 })).toBe(100);
    expect(clickThroughRate({ sent: 5, clicked: 0 })).toBe(0);
  });

  it('is null (a dash, not 0%) for a flow that never sent a tracked link', () => {
    expect(clickThroughRate({ sent: 0, clicked: 0 })).toBeNull();
    expect(clickThroughRate(null)).toBeNull();
    expect(clickThroughRate(undefined)).toBeNull();
  });

  it('never goes above 100% or below 0%', () => {
    expect(clickThroughRate({ sent: 2, clicked: 9 })).toBe(100);
    expect(clickThroughRate({ sent: 2, clicked: -1 })).toBe(0);
  });
});

describe('tracked destinations', () => {
  it('accepts absolute http(s) URLs only, without credentials, up to 2,048 characters', () => {
    expect(validFlowLinkUrl('https://shop.example/p?x=1')).toBe(true);
    expect(validFlowLinkUrl('http://shop.example/')).toBe(true);
    expect(validFlowLinkUrl('javascript:alert(1)')).toBe(false);
    expect(validFlowLinkUrl('ftp://shop.example/')).toBe(false);
    expect(validFlowLinkUrl('/relative')).toBe(false);
    expect(validFlowLinkUrl('https://user:pass@shop.example/')).toBe(false);
    expect(validFlowLinkUrl(`https://shop.example/${'a'.repeat(2048)}`)).toBe(false);
  });

  it('builds the public redirect from the app origin', () => {
    expect(flowLinkUrl('a'.repeat(32), 'https://app.example.test')).toBe(`https://app.example.test/r/${'a'.repeat(32)}`);
  });
});

describe('trackedUrl', () => {
  it('returns the stored token as the redirect link', async () => {
    vi.stubEnv('APP_URL', 'https://app.example.test');
    expect(await trackedUrl(run, 'card', 'button:0', 'https://shop.example/')).toMatch(/\/r\/a{32}$/);
    expect(h.writes).toBe(1);
  });

  it('sends the link untracked, writing nothing, in a dry run or for a bad URL or run', async () => {
    h.dryRun = true;
    expect(await trackedUrl(run, 'card', 'button:0', 'https://shop.example/')).toBe('https://shop.example/');
    h.dryRun = false;
    expect(await trackedUrl(run, 'card', 'button:0', 'javascript:alert(1)')).toBe('javascript:alert(1)');
    expect(await trackedUrl({ ...run, account_id: 'not-a-uuid' }, 'card', 'button:0', 'https://shop.example/')).toBe('https://shop.example/');
    expect(await trackedUrl(run, '', 'button:0', 'https://shop.example/')).toBe('https://shop.example/');
    expect(await trackedUrl(run, 'card', 'x'.repeat(201), 'https://shop.example/')).toBe('https://shop.example/');
    expect(h.writes).toBe(0);
  });
});

describe('linkClicked', () => {
  it('is false for malformed ids without asking the database', async () => {
    expect(await linkClicked('a', run.id, 'card')).toBe(false);
    expect(await linkClicked(run.account_id, 'r', 'card')).toBe(false);
    expect(h.writes).toBe(0);
  });
});
