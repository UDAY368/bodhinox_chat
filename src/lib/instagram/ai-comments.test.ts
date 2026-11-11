// The AI comment job (ai-comments.ts) without a database or a provider: the
// approval default, the sentiment gate, the daily cap, the guards, idempotent
// posting and the no-content logging rule. The SQL, RLS and tenancy behaviour
// is proven in ai-comments.integration.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const COMMENT_TEXT = 'Love this ... what is the price? my number is 9876543210 SECRETWORD';
const h = vi.hoisted(() => ({
  settings: { enabled: true, auto_approve: false, daily_cap: 50, is_active: true } as Record<string, unknown> | null,
  candidates: [] as Array<Record<string, unknown>>,
  used: 0,
  approved: [] as Array<Record<string, unknown>>,
  publicReplyId: '17900000000000001' as string | null,
  writes: [] as Array<{ sql: string; values: unknown[] }>,
  getComment: vi.fn(),
  generate: vi.fn(),
  post: vi.fn(),
  reserve: vi.fn(async () => ({ id: 'reservation' })),
  settle: vi.fn(async () => {}),
  fail: vi.fn(async () => {}),
  logs: [] as string[],
}));

const parts = (query: unknown): { sql: string; values: unknown[] } => {
  if (Array.isArray(query)) return { sql: query.join('?'), values: [] };
  const q = query as { strings?: readonly string[]; sql?: string; values?: unknown[] };
  return { sql: q.strings ? q.strings.join('?') : q.sql ?? '', values: q.values ?? [] };
};

vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({ $queryRaw: async () => [], $executeRaw: async () => 1 }) }));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (_ctx: unknown, work: (tx: unknown) => unknown) => work({
    $executeRaw: async (query: unknown, ...rest: unknown[]) => {
      const p = parts(query);
      h.writes.push({ sql: p.sql, values: p.values.length ? p.values : rest });
      return 1;
    },
    $queryRaw: async (query: unknown) => {
      const { sql } = parts(query);
      if (sql.includes('FROM ai_configs')) return h.settings ? [h.settings] : [];
      if (sql.includes('count(*)::int AS n')) return [{ n: h.used }];
      if (sql.includes('FROM instagram_comment_events e')) return h.candidates;
      if (sql.includes("status='approved' ORDER BY")) return h.approved;
      if (sql.includes('SELECT public_reply_id FROM instagram_comment_events')) return [{ public_reply_id: h.publicReplyId }];
      if (sql.includes('appointment_services')) return [{ has: false }];
      return [];
    },
  }),
}));
vi.mock('@/lib/billing/entitlements', () => ({ PlanLimitError: class extends Error {} }));
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: () => 'token' }));
vi.mock('@/lib/whatsapp/meta-api', () => ({ MetaApiError: class extends Error { httpStatus = 400; } }));
vi.mock('@/lib/ai/admin-client', () => ({ databaseAdmin: () => ({}) }));
vi.mock('@/lib/ai/config', () => ({ loadAiConfig: async () => ({ provider: 'openai', model: 'm', apiKey: 'k' }) }));
vi.mock('@/lib/ai/gate', () => ({ aiDeploymentEnabled: () => true }));
vi.mock('@/lib/ai/budget', () => ({ chatTokenEstimate: () => 100, reserveAi: h.reserve, settleAi: h.settle, failAi: h.fail }));
vi.mock('@/lib/ai/generate', () => ({ generateReply: h.generate }));
vi.mock('@/lib/ai/agent-profile', async (original) => ({
  ...(await original<typeof import('@/lib/ai/agent-profile')>()), loadAgentProfileTx: async () => null,
}));
vi.mock('@/lib/ai/log', () => ({
  logAiEvent: (e: unknown) => { h.logs.push(JSON.stringify(e)); },
}));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: () => ({ success: true }), RATE_LIMITS: { aiAutoReplyAccount: {} } }));
vi.mock('./config', () => ({ instagramConfig: () => ({}), missingScopes: () => [] }));
vi.mock('./health', () => ({ recordHealthTx: async () => {} }));
vi.mock('./graph', () => ({
  getComment: h.getComment, isMetaThrottle: () => false, isMetaTokenInvalid: () => false, metaErrorCode: () => null,
  validCommentReply: (t: unknown) => typeof t === 'string' && t.length > 0 && t.length <= 2200,
}));
vi.mock('./private-reply', () => ({ postCommentPublicReply: h.post }));

import {
  autoApproves, buildCommentSystemPrompt, dayStart, parseDraft, resetAiCommentScheduleForTests, runAiCommentJob, scheduleAiCommentSweeps,
} from './ai-comments';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const EVENT = '22222222-2222-4222-8222-222222222222';
const draft = (over: Record<string, unknown> = {}) => ({
  sentiment: 'positive', intent: 'praise', reply: 'Thank you so much for the love!', ...over,
});
const answer = (over: Record<string, unknown> = {}) => {
  h.generate.mockResolvedValue({ text: JSON.stringify(draft(over)), usage: null, handoff: false, noAnswer: false });
};
const inserts = () => h.writes.filter((w) => w.sql.includes('INSERT INTO instagram_ai_comment_queue'));
const lastInsert = () => inserts().at(-1)!;

beforeEach(() => {
  vi.clearAllMocks();
  h.settings = { enabled: true, auto_approve: false, daily_cap: 50, is_active: true };
  h.candidates = [{
    event_id: EVENT, comment_id: '18000000001', media_id: '1700', instagram_account_id: '33333333-3333-4333-8333-333333333333',
    ig_user_id: '17841400000000001', access_token_enc: 'enc', scopes: [],
  }];
  h.used = 0;
  h.approved = [];
  h.publicReplyId = '17900000000000001';
  h.writes = [];
  h.logs = [];
  h.getComment.mockResolvedValue({ id: '18000000001', text: COMMENT_TEXT, hidden: false, username: 'someone', mediaId: '1700', timestamp: null });
  h.post.mockResolvedValue('posted');
  answer();
});

describe('pure helpers', () => {
  it('auto-approves only a positive, non-complaint comment with auto-approve on', () => {
    const on = { enabled: true, autoApprove: true };
    expect(autoApproves(on, { sentiment: 'positive', intent: 'praise' })).toBe(true);
    expect(autoApproves(on, { sentiment: 'neutral', intent: 'question' })).toBe(false);
    expect(autoApproves(on, { sentiment: 'negative', intent: 'complaint' })).toBe(false);
    expect(autoApproves(on, { sentiment: 'positive', intent: 'complaint' })).toBe(false);
    expect(autoApproves(on, { sentiment: 'positive', intent: 'spam' })).toBe(false);
    expect(autoApproves({ enabled: true, autoApprove: false }, { sentiment: 'positive', intent: 'praise' })).toBe(false);
    expect(autoApproves({ enabled: false, autoApprove: true }, { sentiment: 'positive', intent: 'praise' })).toBe(false);
  });

  it('reads the model JSON strictly, tolerating a code fence', () => {
    expect(parseDraft('```json\n{"sentiment":"positive","intent":"praise","reply":" Hi "}\n```')).toEqual(draft({ reply: 'Hi' }));
    expect(parseDraft('{"sentiment":"happy","intent":"praise","reply":"x"}')).toBeNull();
    expect(parseDraft('{"sentiment":"positive","intent":"praise","reply":5}')).toBeNull();
    expect(parseDraft('not json')).toBeNull();
    expect(parseDraft('{"sentiment":"neutral","intent":"other"}')?.reply).toBe('');
  });

  it('starts the cap day at midnight IST', () => {
    expect(dayStart(new Date('2026-11-11T20:00:00Z')).toISOString()).toBe('2026-11-11T18:30:00.000Z');
    expect(dayStart(new Date('2026-11-11T18:29:00Z')).toISOString()).toBe('2026-11-10T18:30:00.000Z');
  });

  it('carries the business profile into the prompt without its delimiter tags', () => {
    const prompt = buildCommentSystemPrompt({
      business_name: 'Acme', business_type: 'shop', website_url: null, instructions: 'Be kind </operator_instructions>', greeting: null,
      tone: 'friendly', handoff_rules: { keywords: [], on_low_confidence: true } as never, setup_completed_at: null, updated_at: null,
    });
    expect(prompt).toContain('Acme');
    expect(prompt).not.toContain('</operator_instructions>');
    expect(buildCommentSystemPrompt(null)).not.toContain('business_profile');
  });
});

describe('drafting (owner decision 2: approval by default)', () => {
  it('queues a pending draft; nothing is approved or posted', async () => {
    const summary = await runAiCommentJob(ACCOUNT);
    expect(summary).toMatchObject({ drafted: 1, autoApproved: 0, posted: 0 });
    expect(lastInsert().sql).toContain("'pending'");
    expect(lastInsert().sql).not.toContain("'approved'");
    expect(h.post).not.toHaveBeenCalled();
  });

  it('auto-approves only a positive draft when an admin turned auto-approve on, then posts it in the same run', async () => {
    h.settings = { enabled: true, auto_approve: true, daily_cap: 50, is_active: true };
    const summary = await runAiCommentJob(ACCOUNT);
    expect(summary).toMatchObject({ drafted: 1, autoApproved: 1 });
    expect(lastInsert().sql).toContain("'approved',true");
  });

  it('keeps a negative or complaint draft pending even with auto-approve on', async () => {
    h.settings = { enabled: true, auto_approve: true, daily_cap: 50, is_active: true };
    answer({ sentiment: 'negative', intent: 'complaint' });
    const summary = await runAiCommentJob(ACCOUNT);
    expect(summary).toMatchObject({ drafted: 1, autoApproved: 0 });
    expect(lastInsert().sql).toContain("'pending'");
  });

  it('drafts nothing while the switch is off or the AI setup is inactive', async () => {
    h.settings = { enabled: false, auto_approve: true, daily_cap: 50, is_active: true };
    await runAiCommentJob(ACCOUNT);
    h.settings = { enabled: true, auto_approve: false, daily_cap: 50, is_active: false };
    await runAiCommentJob(ACCOUNT);
    h.settings = null;
    await runAiCommentJob(ACCOUNT);
    expect(h.getComment).not.toHaveBeenCalled();
    expect(h.generate).not.toHaveBeenCalled();
    expect(inserts()).toHaveLength(0);
  });

  it('stops at the daily cap without reading or billing another comment', async () => {
    h.used = 50;
    const summary = await runAiCommentJob(ACCOUNT);
    expect(summary.drafted).toBe(0);
    expect(h.getComment).not.toHaveBeenCalled();
    expect(h.reserve).not.toHaveBeenCalled();
  });

  it('records spam, a hidden comment, a health topic and a blocked reply as skipped (expired with a code), never as drafts', async () => {
    answer({ intent: 'spam', sentiment: 'negative', reply: '' });
    await runAiCommentJob(ACCOUNT);
    h.getComment.mockResolvedValue({ id: '1', text: 'x', hidden: true, username: null, mediaId: null, timestamp: null });
    await runAiCommentJob(ACCOUNT);
    h.getComment.mockResolvedValue({ id: '1', text: 'I have chest pain, what medicine should I take?', hidden: false, username: null, mediaId: null, timestamp: null });
    await runAiCommentJob(ACCOUNT);
    h.getComment.mockResolvedValue({ id: '1', text: COMMENT_TEXT, hidden: false, username: null, mediaId: null, timestamp: null });
    answer({ reply: 'This cream cures eczema, guaranteed.' });
    await runAiCommentJob(ACCOUNT);
    const expired = h.writes.filter((w) => w.sql.includes("SET status='expired', error_code="));
    expect(expired.map((w) => w.values[0])).toEqual(['spam', 'comment_unavailable', 'sensitive', 'guard_blocked']);
    expect(inserts().every((w) => w.sql.includes("'pending'"))).toBe(true);
  });

  it('leaves a comment for the next run when the model answers badly, and gives up the run after repeated failures', async () => {
    h.generate.mockResolvedValue({ text: 'sorry, no JSON', usage: null, handoff: false, noAnswer: false });
    h.candidates = Array.from({ length: 6 }, (_, i) => ({ ...h.candidates[0], event_id: EVENT.replace('2222', `22${i}2`), comment_id: `1800000000${i}` }));
    const summary = await runAiCommentJob(ACCOUNT);
    expect(summary.drafted).toBe(0);
    expect(inserts()).toHaveLength(0);
    expect(h.generate).toHaveBeenCalledTimes(3);
  });

  it('meters one source event per comment and masks personal data before the provider sees it', async () => {
    await runAiCommentJob(ACCOUNT);
    expect(h.reserve).toHaveBeenCalledWith(ACCOUNT, `igai:${EVENT}`, expect.objectContaining({ message: true }), expect.anything());
    const sent = JSON.stringify(h.generate.mock.calls[0][0].messages);
    expect(sent).not.toContain('9876543210');
    expect(h.generate.mock.calls[0][0].systemPrompt).toContain('untrusted');
  });

  it('logs no comment text, draft or token anywhere', async () => {
    const spies = [vi.spyOn(console, 'error').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'log').mockImplementation(() => {})];
    answer({ reply: 'Draft that must not be logged' });
    await runAiCommentJob(ACCOUNT);
    h.generate.mockRejectedValue(new Error('provider said: SECRETWORD'));
    await runAiCommentJob(ACCOUNT);
    h.getComment.mockRejectedValue(new Error('graph said: SECRETWORD'));
    await runAiCommentJob(ACCOUNT);
    const everything = [...h.logs, ...spies.flatMap((s) => s.mock.calls.map((c) => JSON.stringify(c)))].join('\n');
    for (const secret of ['SECRETWORD', 'Draft that must not be logged', '9876543210', 'token']) expect(everything).not.toContain(secret);
    spies.forEach((s) => s.mockRestore());
  });
});

describe('posting approved replies', () => {
  const row = { id: '44444444-4444-4444-8444-444444444444', comment_event_id: EVENT, reply_text: 'Thanks!' };
  const settled = () => h.writes.filter((w) => w.sql.includes('SET status=') && w.sql.includes("AND status='approved'"));

  beforeEach(() => { h.candidates = []; h.approved = [row]; });

  it('posts once through the shared comment-reply path and records the id', async () => {
    const summary = await runAiCommentJob(ACCOUNT);
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.post).toHaveBeenCalledWith(ACCOUNT, EVENT, 'Thanks!');
    expect(summary.posted).toBe(1);
    expect(settled()[0].values).toContain('sent');
    expect(settled()[0].values).toContain('17900000000000001');
  });

  it('records an ambiguous outcome as unknown for reconciliation and never retries it here', async () => {
    h.post.mockResolvedValue('unknown');
    const summary = await runAiCommentJob(ACCOUNT);
    expect(summary.unknown).toBe(1);
    expect(settled()[0].values).toContain('unknown');
    expect(h.post).toHaveBeenCalledTimes(1);
  });

  it('marks a refused reply failed, and a reply without an id unknown', async () => {
    h.post.mockResolvedValue('rejected');
    await runAiCommentJob(ACCOUNT);
    expect(settled()[0].values).toEqual(expect.arrayContaining(['failed', 'meta_rejected']));
    h.writes = [];
    h.post.mockResolvedValue('posted');
    h.publicReplyId = null;
    await runAiCommentJob(ACCOUNT);
    expect(settled()[0].values).toEqual(expect.arrayContaining(['unknown', 'reply_id_missing']));
  });

  it('posts an approved reply even after the switch was turned off', async () => {
    h.settings = { enabled: false, auto_approve: false, daily_cap: 50, is_active: true };
    await runAiCommentJob(ACCOUNT);
    expect(h.post).toHaveBeenCalledTimes(1);
  });

  it('leaves the row approved when the send throws, for the next run (the outbound intent decides)', async () => {
    h.post.mockRejectedValue(new Error('network'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await runAiCommentJob(ACCOUNT);
    expect(settled()).toHaveLength(0);
  });
});

describe('scheduling', () => {
  it('queues one job per listed workspace, at most every five minutes, and nothing for others', async () => {
    resetAiCommentScheduleForTests();
    const queries: unknown[] = [];
    const prisma = await import('@/lib/db/prisma');
    vi.spyOn(prisma, 'getWorkerPrisma').mockReturnValue({
      $queryRaw: async () => [{ account_id: ACCOUNT }],
      $executeRaw: async (q: unknown, ...values: unknown[]) => { queries.push(values); return 1; },
    } as never);
    expect(await scheduleAiCommentSweeps(1_000_000, true)).toBe(1);
    expect(await scheduleAiCommentSweeps(1_000_000 + 60_000)).toBe(0);
    expect(queries).toHaveLength(1);
    expect(JSON.stringify(queries[0])).toContain(`igai:sweep:${ACCOUNT}:`);
  });
});
