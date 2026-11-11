// The comment-flow job (private-reply.ts runCommentFlowJob) without a database:
// which path answers a comment when the offered flows cannot take it. The SQL,
// RLS and tenancy behaviour is proven in comment-flow.integration.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  startCommentFlow: vi.fn<(args: Record<string, unknown>) => Promise<string>>(),
  sendPrivateReply: vi.fn(async () => ({ messageId: 'mid.1', recipientId: '9001' })),
  listMedia: vi.fn(async () => [] as Array<{ id: string; timestamp: string | null }>),
  executeRaw: vi.fn(async () => 1),
  event: {} as Record<string, unknown>,
}));

const sqlOf = (query: unknown): string => {
  if (Array.isArray(query)) return query.join('?');
  const q = query as { strings?: readonly string[]; sql?: string };
  return q.strings ? q.strings.join('?') : q.sql ?? '';
};

vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({}) }));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (_ctx: unknown, work: (tx: unknown) => unknown) => work({
    $executeRaw: h.executeRaw,
    $queryRaw: async (query: unknown) => {
      const sql = sqlOf(query);
      if (sql.includes('count(*)::int AS n')) return [{ n: 0 }];
      if (sql.includes('FROM instagram_comment_events e')) return [h.event];
      if (sql.includes('v.trigger_config')) return [{ trigger_type: 'ig_comment', extra_triggers: [], trigger_config: { post_scope: 'next', next_after: '2026-11-01T00:00:00Z' } }];
      return [];
    },
  }),
}));
vi.mock('@/lib/jobs/dispatch', () => ({
  dispatchOnce: async (_account: string, _key: string, send: () => Promise<unknown>) => send(),
  UncertainDispatchError: class extends Error {},
}));
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: () => 'token' }));
vi.mock('@/lib/whatsapp/meta-api', () => ({ MetaApiError: class extends Error { httpStatus = 400; } }));
vi.mock('./config', () => ({ instagramConfig: () => ({}), missingScopes: () => [] }));
vi.mock('./health', () => ({ recordHealthTx: async () => {} }));
vi.mock('./graph', () => ({
  isMetaThrottle: () => false, isMetaTokenInvalid: () => false, metaErrorCode: () => null, listMedia: h.listMedia,
  quickRepliesFit: () => true, replyToComment: vi.fn(), sendPrivateReply: h.sendPrivateReply,
  validCommentReply: () => true, validInstagramText: (t: unknown) => typeof t === 'string' && t.length > 0,
}));
vi.mock('@/lib/flows/engine', () => ({ startCommentFlow: h.startCommentFlow }));

import { runCommentFlowJob } from './private-reply';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const EVENT = '22222222-2222-4222-8222-222222222222';
const FLOW = '33333333-3333-4333-8333-333333333333';
const RULE = '44444444-4444-4444-8444-444444444444';
const statusWrites = () => (h.executeRaw.mock.calls as unknown as unknown[][])
  .filter((c) => sqlOf(c[0]).includes('SET private_reply_status')).map((c) => c[1]);

beforeEach(() => {
  vi.clearAllMocks();
  h.event = {
    status: 'queued', flow_run_id: null, media_id: '1700', received_at: new Date(), ig_user_id: '17841400000000001',
    account_status: 'active', access_token_enc: 'enc', comment_id: '18000000001', instagram_account_id: 'ig-acct',
    reply_text: 'Rule reply', rule_active: true, scopes: [], contact_blocked: false,
  };
});

describe('runCommentFlowJob', () => {
  it('starts the first flow that takes the comment; the rule never sends', async () => {
    h.startCommentFlow.mockResolvedValue('started');
    await expect(runCommentFlowJob(ACCOUNT, { eventId: EVENT, flows: [{ flowId: FLOW, check: false }], fallbackRuleId: RULE }))
      .resolves.toBe('flow');
    expect(h.sendPrivateReply).not.toHaveBeenCalled();
  });

  it('a busy or paused conversation falls back to the legacy rule, exactly as before comment flows', async () => {
    for (const outcome of ['busy', 'paused']) {
      vi.clearAllMocks();
      h.startCommentFlow.mockResolvedValue(outcome);
      await expect(runCommentFlowJob(ACCOUNT, { eventId: EVENT, flows: [{ flowId: FLOW, check: false }, { flowId: RULE, check: false }],
        fallbackRuleId: RULE })).resolves.toBe('sent');
      // The second flow would meet the same conversation: it is not tried.
      expect(h.startCommentFlow).toHaveBeenCalledTimes(1);
      expect(h.sendPrivateReply).toHaveBeenCalledTimes(1);
      expect(h.sendPrivateReply).toHaveBeenCalledWith('17841400000000001', 'token', '18000000001', 'Rule reply', undefined);
      expect(statusWrites()).toContain('sent');
    }
  });

  it('a busy conversation with no rule to fall back on records the comment as rejected and sends nothing', async () => {
    h.startCommentFlow.mockResolvedValue('busy');
    await expect(runCommentFlowJob(ACCOUNT, { eventId: EVENT, flows: [{ flowId: FLOW, check: false }], fallbackRuleId: null }))
      .resolves.toBe('rejected');
    expect(h.sendPrivateReply).not.toHaveBeenCalled();
    expect(statusWrites()).toEqual(['rejected']);
  });

  it('a "next post" flow is skipped when the post is not the next one, and the rule answers', async () => {
    h.listMedia.mockResolvedValue([{ id: '1800', timestamp: '2026-11-02T00:00:00Z' }, { id: '1700', timestamp: '2026-10-01T00:00:00Z' }]);
    await expect(runCommentFlowJob(ACCOUNT, { eventId: EVENT, flows: [{ flowId: FLOW, check: true }], fallbackRuleId: RULE }))
      .resolves.toBe('sent');
    expect(h.listMedia).toHaveBeenCalledTimes(1);
    expect(h.startCommentFlow).not.toHaveBeenCalled();
    expect(h.sendPrivateReply).toHaveBeenCalledTimes(1);

    // The same comment on the post that is the next one: the flow takes it.
    vi.clearAllMocks();
    h.event.media_id = '1800';
    h.startCommentFlow.mockResolvedValue('started');
    await expect(runCommentFlowJob(ACCOUNT, { eventId: EVENT, flows: [{ flowId: FLOW, check: true }], fallbackRuleId: RULE }))
      .resolves.toBe('flow');
    expect(h.sendPrivateReply).not.toHaveBeenCalled();
  });

  it('a commenter unsubscribed on Instagram gets no flow, no other flow and no rule DM (Stage 5)', async () => {
    h.startCommentFlow.mockResolvedValue('opted_out');
    await expect(runCommentFlowJob(ACCOUNT, { eventId: EVENT, flows: [{ flowId: FLOW, check: false }, { flowId: RULE, check: false }],
      fallbackRuleId: RULE })).resolves.toBe('rejected');
    expect(h.startCommentFlow).toHaveBeenCalledTimes(1);
    expect(h.sendPrivateReply).not.toHaveBeenCalled();
    expect(statusWrites()).toEqual(['rejected']);
  });

  it('the legacy rule sends no DM to a commenter unsubscribed on Instagram, with no flow offered (Stage 5)', async () => {
    h.event.contact_opted_out = true;
    await expect(runCommentFlowJob(ACCOUNT, { eventId: EVENT, flows: [], fallbackRuleId: RULE })).resolves.toBe('rejected');
    expect(h.sendPrivateReply).not.toHaveBeenCalled();
    expect(statusWrites()).toEqual(['rejected']);
  });

  it('passes the matched extra trigger to the engine and refuses a malformed one (Stage 5)', async () => {
    h.startCommentFlow.mockResolvedValue('started');
    await runCommentFlowJob(ACCOUNT, { eventId: EVENT, flows: [{ flowId: FLOW, check: false, trigger: 2 }], fallbackRuleId: null });
    expect(h.startCommentFlow).toHaveBeenCalledWith({ accountId: ACCOUNT, eventId: EVENT, flowId: FLOW, trigger: 2 });
    // A job queued before Stage 5 means the primary trigger.
    await runCommentFlowJob(ACCOUNT, { eventId: EVENT, flows: [{ flowId: FLOW, check: false }], fallbackRuleId: null });
    expect(h.startCommentFlow).toHaveBeenLastCalledWith({ accountId: ACCOUNT, eventId: EVENT, flowId: FLOW, trigger: 0 });
    for (const trigger of [-1, 1.5, 9, 'x']) {
      await expect(runCommentFlowJob(ACCOUNT, { eventId: EVENT, flows: [{ flowId: FLOW, check: false, trigger }], fallbackRuleId: null }))
        .rejects.toThrow('Invalid private reply job');
    }
  });
});
