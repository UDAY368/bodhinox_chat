import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generateReply: vi.fn(),
  dispatchOnce: vi.fn(async (_a: string, _k: string, work: () => Promise<unknown>) => work()),
  reserveAi: vi.fn(async () => ({ id: 'r' })),
  deployment: vi.fn(() => true),
}));

vi.mock('./generate', async (importOriginal) => ({ ...(await importOriginal<typeof import('./generate')>()), generateReply: mocks.generateReply }));
vi.mock('./config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config')>()),
  loadAiConfig: vi.fn(async () => ({ provider: 'openai', model: 'test-model', systemPrompt: null })),
}));
vi.mock('./budget', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./budget')>()),
  reserveAi: mocks.reserveAi, settleAi: vi.fn(async () => {}), failAi: vi.fn(async () => {}),
}));
vi.mock('./gate', async (importOriginal) => ({ ...(await importOriginal<typeof import('./gate')>()), aiDeploymentEnabled: mocks.deployment }));
vi.mock('./admin-client', async (importOriginal) => ({ ...(await importOriginal<typeof import('./admin-client')>()), databaseAdmin: vi.fn(() => ({})) }));
vi.mock('@/lib/jobs/dispatch', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/jobs/dispatch')>()), dispatchOnce: mocks.dispatchOnce }));

import { PlanLimitError } from '@/lib/billing/entitlements';
import { clearIntentCacheForTests, INTENT_TIMEOUT_MS, intentMatches, intentSystemPrompt, parseIntentAnswer, usableCandidates, withTimeout } from './intent-match';

const A = '11111111-1111-4111-8111-111111111111';
const F1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const F2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const candidates = [{ flowId: F1, intent: 'asks about prices' }, { flowId: F2, intent: 'wants to book a table' }];
const answer = (text: string) => mocks.generateReply.mockResolvedValueOnce({ text, usage: { inputTokens: 1, outputTokens: 1 } });

beforeEach(() => {
  vi.clearAllMocks();
  clearIntentCacheForTests();
  mocks.deployment.mockReturnValue(true);
});
afterEach(() => vi.useRealTimers());

describe('pure helpers', () => {
  it('drops invalid, empty and repeated candidates', () => {
    expect(usableCandidates([...candidates, { flowId: F1, intent: 'again' }, { flowId: 'x', intent: 'y' }, { flowId: F2.replace('b', 'c'), intent: '  ' }]))
      .toEqual(candidates);
  });
  it('numbers the intents on one line each and reads only a plain number back', () => {
    expect(intentSystemPrompt([{ flowId: F1, intent: 'a\nb' }], '')).toContain('1. a b');
    expect(parseIntentAnswer('2', 2)).toBe(1);
    expect(parseIntentAnswer(' 1. ', 2)).toBe(0);
    expect(parseIntentAnswer('0', 2)).toBeNull();
    expect(parseIntentAnswer('3', 2)).toBeNull();
    expect(parseIntentAnswer('I think 1', 2)).toBeNull();
  });
  it('answers the fallback after the timeout', async () => {
    vi.useFakeTimers();
    const pending = withTimeout(new Promise<string>(() => {}), 50, 'late');
    await vi.advanceTimersByTimeAsync(60);
    await expect(pending).resolves.toBe('late');
  });
});

describe('intentMatches', () => {
  it('one classification per message covers every candidate, and the answer is cached by message id', async () => {
    answer('2');
    expect(await intentMatches(A, 'mid.1', 'can I reserve for 4 tonight?', candidates)).toBe(F2);
    expect(await intentMatches(A, 'mid.1', 'can I reserve for 4 tonight?', candidates)).toBe(F2);
    expect(mocks.generateReply).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchOnce).toHaveBeenCalledWith(A, 'ai-intent:mid.1', expect.any(Function));
  });
  it('no match when AI is off, nothing matches, the budget is used up or the provider fails', async () => {
    mocks.deployment.mockReturnValue(false);
    expect(await intentMatches(A, 'mid.2', 'hello', candidates)).toBeNull();
    mocks.deployment.mockReturnValue(true);
    answer('0');
    expect(await intentMatches(A, 'mid.3', 'hello', candidates)).toBeNull();
    mocks.reserveAi.mockRejectedValueOnce(new PlanLimitError('AI tokens used up'));
    expect(await intentMatches(A, 'mid.4', 'hello', candidates)).toBeNull();
    mocks.generateReply.mockRejectedValueOnce(new Error('boom'));
    expect(await intentMatches(A, 'mid.5', 'hello', candidates)).toBeNull();
    expect(await intentMatches(A, 'mid.6', 'hello', [])).toBeNull();
  });
  it('a stored answer whose flow is no longer a candidate is no match', async () => {
    mocks.dispatchOnce.mockResolvedValueOnce({ flow_id: F2 });
    expect(await intentMatches(A, 'mid.7', 'hello', [candidates[0]])).toBeNull();
  });
  it('a slow provider is no match after the timeout', async () => {
    vi.useFakeTimers();
    mocks.generateReply.mockImplementationOnce(() => new Promise(() => {}));
    const pending = intentMatches(A, 'mid.8', 'hello', candidates);
    await vi.advanceTimersByTimeAsync(INTENT_TIMEOUT_MS + 10);
    await expect(pending).resolves.toBeNull();
  });
});
