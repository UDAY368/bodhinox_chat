import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanLimitError } from '@/lib/billing/entitlements';

const h = vi.hoisted(() => ({
  limits: { ai_messages: null as number | null, ai_tokens_monthly: null as number | null },
  cap: null as number | null,
  counters: [] as { metric: string; value: bigint }[],
  reserve: vi.fn(),
  settle: vi.fn(),
  release: vi.fn(),
  record: vi.fn(),
  notices: vi.fn(),
  refused: vi.fn(),
  logInserts: 0,
  failSettle: false,
}));

vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({ worker: true }) }));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (_ctx: unknown, fn: (tx: unknown) => unknown) => {
    if (h.failSettle) throw new Error('db down: secret value');
    return fn({
      $queryRaw: async (sql: TemplateStringsArray) => {
        const text = sql.join('');
        if (text.includes('monthly_token_cap')) return h.cap === null ? [] : [{ cap: BigInt(h.cap) }];
        if (text.includes('FROM usage_counters')) return h.counters;
        return [];
      },
      $executeRaw: async () => { h.logInserts++; return 1; },
    });
  },
}));
vi.mock('@/lib/billing/entitlements', async (original) => ({
  ...(await original<typeof import('@/lib/billing/entitlements')>()),
  getEntitlements: async () => ({ planId: 'free', planName: 'Free', features: {}, limits: h.limits }),
}));
vi.mock('@/lib/billing/usage-ledger', async (original) => ({
  ...(await original<typeof import('@/lib/billing/usage-ledger')>()),
  reserveUsage: h.reserve, settleUsage: h.settle, releaseUsage: h.release, recordUsage: h.record,
}));
vi.mock('@/lib/billing/usage-notices', () => ({ recordUsageNotices: h.notices, notifyLimitRefused: h.refused }));
vi.mock('@/lib/billing/limits', () => ({ aiTokensUsed: async () => 0, requireAiMessageRoom: async () => {} }));

import { AiWorkspaceCapError, billedOnFailure, failAi, releaseAi, requestMeter, reserveAi, settleAi } from './budget';
import { AiError } from './types';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const log = { conversationId: null, mode: 'draft' as const, provider: 'openai' as const, model: 'm', promptTokens: 3, completionTokens: 4, totalTokens: 7 };

beforeEach(() => {
  h.limits = { ai_messages: null, ai_tokens_monthly: null };
  h.cap = null;
  h.counters = [];
  h.logInserts = 0;
  h.failSettle = false;
  for (const f of [h.reserve, h.settle, h.release, h.record, h.notices, h.refused]) f.mockReset();
  h.reserve.mockResolvedValue('reserved');
  h.settle.mockResolvedValue(true);
  h.release.mockResolvedValue(true);
  h.record.mockResolvedValue(true);
});

describe('reserveAi', () => {
  it('reserves nothing on the unlimited fast path; settle records the usage once per source event', async () => {
    const r = await reserveAi(ACCOUNT, 'inbound:wamid.1', { message: true, tokens: 500 });
    expect(h.reserve).not.toHaveBeenCalled();
    expect(r.held).toEqual({ ai_messages: false, ai_tokens: false });
    await settleAi(r, { tokens: 42, log });
    expect(h.record).toHaveBeenCalledWith(expect.anything(), 'ai_messages', 'inbound:wamid.1', 1);
    expect(h.record).toHaveBeenCalledWith(expect.anything(), 'ai_tokens', 'inbound:wamid.1', 42);
    expect(h.settle).not.toHaveBeenCalled();
    expect(h.notices).not.toHaveBeenCalled();
    expect(h.logInserts).toBe(1);
  });

  it('holds both metrics against finite limits, the token limit being the smaller of plan and workspace cap', async () => {
    h.limits = { ai_messages: 100, ai_tokens_monthly: 50_000 };
    h.cap = 20_000;
    const r = await reserveAi(ACCOUNT, 'task:1', { message: true, tokens: 900.2, workspaceCap: true });
    expect(h.reserve).toHaveBeenCalledWith(expect.anything(), 'ai_messages', 'task:1', 1, 100);
    expect(h.reserve).toHaveBeenCalledWith(expect.anything(), 'ai_tokens', 'task:1', 901, 20_000);
    expect(r.held).toEqual({ ai_messages: true, ai_tokens: true });
    await settleAi(r, { tokens: 300 });
    expect(h.settle).toHaveBeenCalledWith(expect.anything(), 'ai_messages', 'task:1', 1);
    expect(h.settle).toHaveBeenCalledWith(expect.anything(), 'ai_tokens', 'task:1', 300);
    expect(h.notices).toHaveBeenCalledWith(expect.anything(), ACCOUNT, expect.objectContaining({ key: 'ai_messages', limit: 100 }));
    expect(h.notices).toHaveBeenCalledWith(expect.anything(), ACCOUNT, expect.objectContaining({ key: 'ai_tokens_monthly', limit: 50_000 }));
  });

  it('a feature that is not customer text holds no AI message', async () => {
    h.limits = { ai_messages: 100, ai_tokens_monthly: null };
    const r = await reserveAi(ACCOUNT, 'task:2', { message: false, tokens: 10 });
    expect(h.reserve).not.toHaveBeenCalled();
    expect(r.held).toEqual({ ai_messages: false, ai_tokens: false });
  });

  it('refuses over the plan messages, the plan tokens, or the workspace cap with the right error', async () => {
    h.limits = { ai_messages: 100, ai_tokens_monthly: 1_000 };
    h.reserve.mockResolvedValueOnce('over_limit');
    await expect(reserveAi(ACCOUNT, 'k1', { message: true, tokens: 1 })).rejects.toThrow(/AI replies this month/);
    expect(h.refused).toHaveBeenLastCalledWith(ACCOUNT, 'ai_messages');
    h.reserve.mockResolvedValueOnce('reserved').mockResolvedValueOnce('over_limit');
    await expect(reserveAi(ACCOUNT, 'k2', { message: true, tokens: 1 })).rejects.toThrow(/AI tokens this month/);
    expect(h.refused).toHaveBeenLastCalledWith(ACCOUNT, 'ai_tokens_monthly');
    h.cap = 500;
    h.refused.mockReset();
    h.reserve.mockResolvedValueOnce('reserved').mockResolvedValueOnce('over_limit');
    const capped = reserveAi(ACCOUNT, 'k3', { message: true, tokens: 1, workspaceCap: true });
    await expect(capped).rejects.toBeInstanceOf(AiWorkspaceCapError);
    await expect(capped).rejects.toBeInstanceOf(PlanLimitError);
    // The workspace's own cap sends no plan-limit notice.
    expect(h.refused).not.toHaveBeenCalled();
  });

  it('applies the workspace cap only to the assistant features (workspaceCap); auto-replies and routes keep the plan limit', async () => {
    h.limits = { ai_messages: null, ai_tokens_monthly: null };
    h.cap = 500;
    const r = await reserveAi(ACCOUNT, 'inbound:1', { message: true, tokens: 900 });
    expect(h.reserve).not.toHaveBeenCalled();
    expect(r.held).toEqual({ ai_messages: false, ai_tokens: false });
    h.reserve.mockResolvedValueOnce('over_limit');
    await expect(reserveAi(ACCOUNT, 'task:9', { message: false, tokens: 900, workspaceCap: true })).rejects.toBeInstanceOf(AiWorkspaceCapError);
    expect(h.reserve).toHaveBeenCalledWith(expect.anything(), 'ai_tokens', 'task:9', 900, 500);
  });

  it('treats a replayed (already settled) source event as reserved: the provider may run, the meter does not move twice', async () => {
    h.limits = { ai_messages: 1, ai_tokens_monthly: null };
    h.reserve.mockResolvedValue('replay');
    const r = await reserveAi(ACCOUNT, 'inbound:wamid.1', { message: true, tokens: 1 });
    h.settle.mockResolvedValue(false);
    await settleAi(r, { tokens: 5 });
    expect(h.settle).toHaveBeenCalledWith(expect.anything(), 'ai_messages', 'inbound:wamid.1', 1);
    expect(h.record).toHaveBeenCalledWith(expect.anything(), 'ai_tokens', 'inbound:wamid.1', 5);
  });

  it('hashes a source key the ledger cannot store', async () => {
    const r = await reserveAi(ACCOUNT, `flow-ai:${'x'.repeat(250)}`, { message: true, tokens: 1 });
    expect(r.sourceKey).toMatch(/^h:[0-9a-f]{64}$/);
  });
});

describe('settle, release and failure', () => {
  it('releases what was held, and settles tokens but no message after a billable failure', async () => {
    h.limits = { ai_messages: 10, ai_tokens_monthly: 10_000 };
    const r = await reserveAi(ACCOUNT, 'req:1', { message: true, tokens: 100 });
    await releaseAi(r);
    expect(h.release).toHaveBeenCalledWith(expect.anything(), 'ai_messages', 'req:1');
    expect(h.release).toHaveBeenCalledWith(expect.anything(), 'ai_tokens', 'req:1');

    h.release.mockClear();
    await failAi(r, new AiError('timed out', { code: 'timeout', status: 504 }), 400);
    expect(h.release).toHaveBeenCalledWith(expect.anything(), 'ai_messages', 'req:1');
    expect(h.settle).toHaveBeenCalledWith(expect.anything(), 'ai_tokens', 'req:1', 100);

    h.release.mockClear();
    h.settle.mockClear();
    await failAi(r, new AiError('bad key', { code: 'auth', status: 401 }), 400);
    expect(h.settle).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledTimes(2);
  });

  it('decides what a failed call may have cost', () => {
    expect(billedOnFailure(new AiError('t', { code: 'timeout', status: 504 }))).toBe(true);
    expect(billedOnFailure(new AiError('x', { status: 503 }))).toBe(true);
    expect(billedOnFailure(new AiError('x', { code: 'ai_disabled', status: 503 }))).toBe(false);
    expect(billedOnFailure(new AiError('x', { status: 429 }))).toBe(false);
    expect(billedOnFailure(new Error('network'))).toBe(false);
  });

  it('never throws and never logs the error text when accounting fails', async () => {
    const r = await reserveAi(ACCOUNT, 'req:2', { message: true, tokens: 1 });
    h.failSettle = true;
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(settleAi(r, { tokens: 3, log })).resolves.toBeUndefined();
    await expect(releaseAi({ ...r, held: { ai_messages: true, ai_tokens: false } })).resolves.toBeUndefined();
    expect(JSON.stringify([...info.mock.calls, ...error.mock.calls, ...warn.mock.calls])).not.toContain('secret value');
    for (const s of [info, error, warn]) s.mockRestore();
  });
});

describe('requestMeter', () => {
  it('reserves on the first attempt only and settles every attempt once at the end', async () => {
    h.limits = { ai_messages: 5, ai_tokens_monthly: null };
    const meter = requestMeter(ACCOUNT, 1000, { conversationId: null, mode: 'draft', provider: 'openai', model: 'm' });
    await meter.hooks.beforeAttempt();
    meter.hooks.afterAttempt({ promptTokens: 1, completionTokens: 2, totalTokens: 3 }, { promptChars: 0, outputChars: 0 });
    await meter.hooks.beforeAttempt();
    meter.hooks.afterAttempt(null, { promptChars: 40, outputChars: 8 });
    await meter.finish();
    expect(h.reserve).toHaveBeenCalledTimes(1);
    const key = h.reserve.mock.calls[0][2];
    expect(key).toMatch(/^req:/);
    expect(h.settle).toHaveBeenCalledWith(expect.anything(), 'ai_messages', key, 1);
    // 3 reported + 12 + 2 estimated (characters / 4).
    expect(h.record).toHaveBeenCalledWith(expect.anything(), 'ai_tokens', key, 15);
    expect(h.logInserts).toBe(2);
  });

  it('releases the hold when the first call failed before any usage', async () => {
    h.limits = { ai_messages: 5, ai_tokens_monthly: null };
    const meter = requestMeter(ACCOUNT, 1000, { conversationId: null, mode: 'draft', provider: 'openai', model: 'm' });
    await meter.hooks.beforeAttempt();
    await meter.finish(new AiError('bad request', { status: 400 }));
    expect(h.release).toHaveBeenCalledWith(expect.anything(), 'ai_messages', expect.stringMatching(/^req:/));
    expect(h.settle).not.toHaveBeenCalled();
  });
});
