import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowNodeRow, FlowRunRow, ParsedInbound } from '@/lib/flows/types';

const mocks = vi.hoisted(() => ({
  runFlowAiReply: vi.fn(),
  generateReply: vi.fn(),
  writeContactField: vi.fn(async () => true),
  dispatchOnce: vi.fn(async (_a: string, _k: string, work: () => Promise<unknown>) => work()),
  queryRaw: vi.fn(async () => [] as unknown[]),
}));

vi.mock('./flow-reply', async (importOriginal) => ({ ...(await importOriginal<typeof import('./flow-reply')>()), runFlowAiReply: mocks.runFlowAiReply }));
vi.mock('./generate', async (importOriginal) => ({ ...(await importOriginal<typeof import('./generate')>()), generateReply: mocks.generateReply }));
vi.mock('./config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config')>()),
  loadAiConfig: vi.fn(async () => ({ provider: 'openai', model: 'test-model', systemPrompt: null })),
}));
vi.mock('./budget', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./budget')>()),
  reserveAi: vi.fn(async () => ({ id: 'r' })), settleAi: vi.fn(async () => {}), failAi: vi.fn(async () => {}),
}));
vi.mock('./admin-client', async (importOriginal) => ({ ...(await importOriginal<typeof import('./admin-client')>()), databaseAdmin: vi.fn(() => ({})) }));
vi.mock('@/lib/jobs/dispatch', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/jobs/dispatch')>()), dispatchOnce: mocks.dispatchOnce }));
vi.mock('@/lib/contacts/field-write', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/contacts/field-write')>()), writeContactField: mocks.writeContactField,
}));
vi.mock('@/lib/db/tenant', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db/tenant')>()),
  withTenant: vi.fn(async (_ctx: unknown, work: (tx: unknown) => Promise<unknown>) => work({ $queryRaw: mocks.queryRaw })),
}));

import { acceptExtracted, EXTRACTION_MIN_CONFIDENCE, extractContactPoints, runGoalTurn, validLeadValue } from './goals';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const run = (vars: Record<string, unknown> = {}): FlowRunRow => ({
  id: '22222222-2222-4222-8222-222222222222', flow_id: '33333333-3333-4333-8333-333333333333', account_id: ACCOUNT,
  user_id: '44444444-4444-4444-8444-444444444444', contact_id: '55555555-5555-4555-8555-555555555555',
  conversation_id: '66666666-6666-4666-8666-666666666666', status: 'active', current_node_key: 'ai', transition_seq: 3,
  last_prompt_message_id: null, vars, reprompt_count: 0, started_at: '', last_advanced_at: '', ended_at: null, end_reason: null,
} as unknown as FlowRunRow);
const node = (config: Record<string, unknown>): FlowNodeRow =>
  ({ node_key: 'ai', node_type: 'ai_reply', config: { next_node_key: 'n', handoff_next: 'h', finish_next: 'f', ...config } }) as unknown as FlowNodeRow;
const text = (body: string): ParsedInbound => ({ kind: 'text', text: body, meta_message_id: 'wamid.1' }) as ParsedInbound;
const model = (json: unknown) => mocks.generateReply.mockResolvedValueOnce({ text: JSON.stringify(json), usage: { inputTokens: 1, outputTokens: 1 } });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('extraction validation', () => {
  it('keeps only confident values that pass their input format', async () => {
    const result = await acceptExtracted({
      values: { name: 'Asha Rao', company: 'https://spam.example', 'custom:x': 'Pune' },
      confidence: { name: 0.95, company: 0.99, 'custom:x': EXTRACTION_MIN_CONFIDENCE - 0.01 },
    }, ['name', 'company', 'custom:x']);
    expect(result).toEqual({ values: { name: 'Asha Rao' }, refused: false });
  });
  it('a refusal counts only when nothing was given', async () => {
    expect((await acceptExtracted({ refused: true }, ['name'])).refused).toBe(true);
    expect((await acceptExtracted({ refused: true, values: { name: 'A' }, confidence: { name: 1 } }, ['name'])).refused).toBe(false);
    expect(await acceptExtracted('not json', ['name'])).toEqual({ values: {}, refused: false });
  });
  it('reads emails and phones without a model, using the input formats', async () => {
    expect(await extractContactPoints('mail me at Asha@Example.com, thanks', ['email', 'phone'])).toEqual({ email: 'asha@example.com' });
    expect(await validLeadValue('email', 'not-an-email')).toBeNull();
    expect(await validLeadValue('name', 'two\nlines')).toBeNull();
  });
});

describe('runGoalTurn', () => {
  it('finishes at once when the step has no goals', async () => {
    expect(await runGoalTurn(run(), node({}), text('hi'))).toEqual({ outcome: 'finished' });
    expect(mocks.runFlowAiReply).not.toHaveBeenCalled();
  });

  it('writes a captured email to the run contact and finishes without another AI message', async () => {
    model({ values: {}, confidence: {} });
    const result = await runGoalTurn(run(), node({ goals: [{ type: 'capture_lead', fields: ['email'], on_refusal: 'continue' }] }),
      text('sure, it is asha@example.com'));
    expect(mocks.writeContactField).toHaveBeenCalledWith(expect.anything(), ACCOUNT, '55555555-5555-4555-8555-555555555555', 'email', 'asha@example.com');
    expect(result.outcome).toBe('finished');
    expect(result).toMatchObject({ vars: { ai_lead_email: 'asha@example.com' } });
    expect(mocks.runFlowAiReply).not.toHaveBeenCalled();
    // The extraction runs under an outbound intent keyed by run and message: a retry never calls the model twice.
    expect(mocks.dispatchOnce).toHaveBeenCalledWith(ACCOUNT, `ai-goal-extract:${run().id}:wamid.1`, expect.any(Function));
  });

  it('hands off on a refusal when the goal says so, writing nothing', async () => {
    model({ refused: true });
    const result = await runGoalTurn(run(), node({ goals: [{ type: 'capture_lead', fields: ['name'], on_refusal: 'handoff' }] }), text('no thanks'));
    expect(result).toEqual({ outcome: 'handoff' });
    expect(mocks.writeContactField).not.toHaveBeenCalled();
    expect(mocks.runFlowAiReply).not.toHaveBeenCalled();
  });

  it('never writes a low-confidence answer and asks again through the AI sender', async () => {
    model({ values: { name: 'maybe Bob' }, confidence: { name: 0.4 } });
    mocks.runFlowAiReply.mockResolvedValueOnce({ kind: 'answered', text: 'May I have your name?', whatsappMessageId: 'm', score: 1, citations: [] });
    const result = await runGoalTurn(run(), node({ goals: [{ type: 'capture_lead', fields: ['name'], on_refusal: 'continue' }] }), text('hmm'));
    expect(mocks.writeContactField).not.toHaveBeenCalled();
    expect(result.outcome).toBe('continue');
  });

  it('shares the link through the AI sender with the link allowed, then finishes', async () => {
    mocks.runFlowAiReply.mockResolvedValueOnce({ kind: 'answered', text: 'Here: https://shop.example/a', whatsappMessageId: 'm', score: 1, citations: [] });
    const result = await runGoalTurn(run(), node({ goals: [{ type: 'share_link', url: 'https://shop.example/a' }] }), text('price?'));
    const args = mocks.runFlowAiReply.mock.calls[0][0];
    expect(args.allowedUrls).toEqual(['https://shop.example/a']);
    expect(args.goalGuidance).toContain('https://shop.example/a');
    expect(args.intentKey).toBe(`flow-ai-goal:${run().id}:ai:wamid.1`);
    expect(result.outcome).toBe('finished');
  });

  it('an uncertain AI send hands off instead of sending more on top of it', async () => {
    mocks.runFlowAiReply.mockResolvedValueOnce({ kind: 'unavailable', reason: 'send_uncertain' });
    expect(await runGoalTurn(run(), node({ goals: [{ type: 'grow_followers' }] }), text('hi'))).toEqual({ outcome: 'handoff' });
    mocks.runFlowAiReply.mockResolvedValueOnce({ kind: 'unavailable', reason: 'session_closed' });
    expect(await runGoalTurn(run(), node({ goals: [{ type: 'grow_followers' }] }), text('hi'))).toEqual({ outcome: 'unavailable' });
  });
});
