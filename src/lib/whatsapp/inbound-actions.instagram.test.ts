// Stage 2 (plan item 1): an Instagram inbound runs the full pipeline. After
// flows and Instagram automations: the AI auto-reply, lifecycle, the away
// message and the webhooks, each behind its own stage checkpoint. The AI and
// away steps decide their own switches and windows (their modules are tested
// separately); here: the order, the hand-offs between steps, Instagram-only
// webhooks with Instagram ids, and no customer content in logs.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as string[],
  flow: vi.fn(), resume: vi.fn(), automations: vi.fn(), ai: vi.fn(), mediaSkip: vi.fn(), lifecycle: vi.fn(), away: vi.fn(), webhook: vi.fn(),
  stages: new Map<string, unknown>(),
  contact: { blocked_at: null as string | null },
  consent: [] as Record<string, unknown>[],
}));
vi.mock('@/lib/data/admin', () => ({ createAdminClient: () => ({ from: (table: string) => {
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    select: () => b, eq: () => b, in: () => b, is: () => b, gte: () => b, order: () => b, limit: async () => ({ data: [], error: null }),
    update: (row: Record<string, unknown>) => { h.consent.push(row); return b; },
    maybeSingle: async () => ({ data: table === 'conversations' ? { channel: 'instagram', contact_id: ID } : table === 'messages' ? null : h.contact, error: null }),
    then: (resolve: (r: { error: null }) => unknown) => resolve({ error: null }),
  });
  return b;
} }) }));
vi.mock('@/lib/jobs/scope', () => ({ withJobScope: (_scope: unknown, action: () => unknown) => action() }));
vi.mock('./quick-reply-actions', () => ({ dispatchQuickReplyAction: vi.fn() }));
vi.mock('@/lib/automations/engine', () => ({ resumeAwaitingReply: h.resume, runAutomationsForTrigger: h.automations }));
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: h.flow }));
vi.mock('@/lib/ai/auto-reply', () => ({ dispatchInboundToAiReply: h.ai, recordUnreadableInbound: h.mediaSkip }));
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: h.webhook }));
vi.mock('@/lib/inbox/lifecycle', () => ({ applyInboundLifecycle: h.lifecycle }));
vi.mock('@/lib/inbox/away-message', () => ({ sendAwayMessage: h.away }));
vi.mock('@/lib/appointments/inbound', () => ({ handleBookingCode: vi.fn() }));
vi.mock('./ingest', () => ({ runInboundStage: async (_account: string, _message: string, stage: string, action: () => Promise<unknown>) => {
  h.calls.push(stage);
  if (h.stages.has(stage)) return h.stages.get(stage);
  const result = await action(); h.stages.set(stage, result); return result;
} }));

import { processInboundActions } from './inbound-actions';
import type { MessageActionsPayload } from './ingest';

const ID = '00000000-0000-4000-8000-000000000001';
const SECRET_TEXT = 'my card is 4111 1111';
const message = (overrides: Partial<MessageActionsPayload> = {}): MessageActionsPayload => ({
  kind: 'message', accountId: ID, conversationId: ID, contactId: ID, userId: ID, messageId: ID, metaMessageId: 'mid.in-1',
  interactiveReplyId: null, contentType: 'text', contentText: SECRET_TEXT,
  wasContactCreated: false, wasConversationCreated: false, isFirstInboundMessage: false, ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.calls = [];
  h.stages.clear();
  h.contact = { blocked_at: null };
  h.consent = [];
  h.flow.mockResolvedValue({ consumed: false });
  h.resume.mockResolvedValue(false);
  h.automations.mockResolvedValue(false);
  h.lifecycle.mockResolvedValue({ state: 'requesting', botOwned: false, botReplied: false, routedTo: null, ruleId: null });
  h.away.mockResolvedValue('off');
});

describe('Instagram inbound pipeline', () => {
  it('runs flow, automations, AI, lifecycle, away message and webhooks in the WhatsApp order', async () => {
    await processInboundActions(message({ wasConversationCreated: true }));
    expect(h.calls).toEqual(['conversation_webhook', 'flow', 'reply_resume', 'automation:new_message_received', 'automation:keyword_match',
      'ai_reply', 'away_message', 'message_webhook']);
    expect(h.ai).toHaveBeenCalledWith({ accountId: ID, conversationId: ID, contactId: ID, configOwnerUserId: ID,
      inboundMessageId: 'mid.in-1', inboundRowId: ID, routingChecked: true, requireHandoffOnUnavailable: false });
    expect(h.away).toHaveBeenCalledWith({ accountId: ID, userId: ID, conversationId: ID, contactId: ID, messageId: ID });
    // A typed message lets a parked menu reserve it for the AI, as on WhatsApp.
    expect(h.resume).toHaveBeenCalledWith(expect.objectContaining({ channel: 'instagram', reserveMenuTextForAi: true }));
  });

  it('sends the webhooks only to Instagram endpoints, with Instagram ids and never a WhatsApp id', async () => {
    await processInboundActions(message({ wasConversationCreated: true }));
    expect(h.webhook.mock.calls.map((call) => [call[2], call[3], call[4]])).toEqual([
      ['conversation.created', { conversation_id: ID, contact_id: ID, channel: 'instagram' }, { channel: 'instagram' }],
      ['message.received', { conversation_id: ID, contact_id: ID, channel: 'instagram', instagram_message_id: 'mid.in-1',
        content_type: 'text', content_text: SECRET_TEXT }, { channel: 'instagram' }],
    ]);
  });

  it('keeps the AI quiet when an automation answered, and lets it answer a menu reserved for it', async () => {
    h.automations.mockImplementation(async (input: { triggerType: string }) => input.triggerType === 'keyword_match');
    await processInboundActions(message());
    expect(h.ai).not.toHaveBeenCalled();
    vi.clearAllMocks(); h.stages.clear();
    h.lifecycle.mockResolvedValue({ botOwned: false, botReplied: false });
    h.resume.mockResolvedValue('ai_fallback');
    await processInboundActions(message());
    expect(h.automations).not.toHaveBeenCalled();
    expect(h.ai).toHaveBeenCalledWith(expect.objectContaining({ requireHandoffOnUnavailable: true }));
  });

  it('lets a flow AI fallback reach the AI, and a flow that answered keeps every other responder quiet', async () => {
    h.flow.mockResolvedValue({ consumed: true, outcome: 'ai_fallback' });
    await processInboundActions(message());
    expect(h.ai).toHaveBeenCalledWith(expect.objectContaining({ requireHandoffOnUnavailable: true }));
    vi.clearAllMocks(); h.stages.clear();
    h.lifecycle.mockResolvedValue({ botOwned: true, botReplied: true });
    h.flow.mockResolvedValue({ consumed: true, outcome: 'started' });
    await processInboundActions(message());
    expect(h.resume).not.toHaveBeenCalled();
    expect(h.automations).not.toHaveBeenCalled();
    expect(h.ai).not.toHaveBeenCalled();
    // The bot answered, so the away message stays quiet.
    expect(h.away).not.toHaveBeenCalled();
    expect(h.webhook).toHaveBeenCalledWith(expect.anything(), ID, 'message.received', expect.anything(), { channel: 'instagram' });
  });

  it('records a photo for the AI activity log instead of answering it, and never answers a quick-reply tap', async () => {
    await processInboundActions(message({ contentType: 'image', contentText: null }));
    expect(h.ai).not.toHaveBeenCalled();
    expect(h.mediaSkip).toHaveBeenCalledTimes(1);
    vi.clearAllMocks(); h.stages.clear();
    h.lifecycle.mockResolvedValue({ botOwned: false, botReplied: false });
    await processInboundActions(message({ interactiveReplyId: 'qr_1', contentText: 'Yes' }));
    expect(h.ai).not.toHaveBeenCalled();
    expect(h.mediaSkip).not.toHaveBeenCalled();
  });

  it('gives STOP and a blocked contact no automated response but still emits message.received', async () => {
    await processInboundActions(message({ contentText: 'STOP' }));
    expect(h.consent).toEqual(expect.arrayContaining([expect.objectContaining({ opt_out_source: 'keyword' })]));
    h.stages.clear();
    h.contact = { blocked_at: '2026-11-01T00:00:00Z' };
    await processInboundActions(message({ contentText: 'hello' }));
    for (const fn of [h.flow, h.automations, h.ai, h.lifecycle, h.away]) expect(fn).not.toHaveBeenCalled();
    expect(h.webhook.mock.calls.filter((call) => call[2] === 'message.received')).toHaveLength(2);
  });

  it('replays completed stages on a retried job without a second AI reply, away message or webhook', async () => {
    await processInboundActions(message());
    await processInboundActions(message());
    expect(h.ai).toHaveBeenCalledTimes(1);
    expect(h.away).toHaveBeenCalledTimes(1);
    expect(h.webhook).toHaveBeenCalledTimes(1);
  });

  it('never logs customer content', async () => {
    const spies = (['log', 'info', 'warn', 'error'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    await processInboundActions(message({ contactId: '00000000-0000-4000-8000-000000000009' }));
    expect(JSON.stringify(spies.flatMap((spy) => spy.mock.calls))).not.toContain('4111');
    for (const spy of spies) spy.mockRestore();
  });
});
