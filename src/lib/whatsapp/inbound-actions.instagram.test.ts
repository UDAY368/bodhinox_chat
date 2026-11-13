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
  routeStaff: vi.fn(), autoLabel: vi.fn(),
  stages: new Map<string, unknown>(),
  contact: { blocked_at: null as string | null, instagram_opted_out_at: null as string | null },
  consent: [] as Record<string, unknown>[],
  igConsent: vi.fn(),
  flowSend: vi.fn(),
  startFlow: vi.fn(),
  settings: null as null | Record<string, unknown>,
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
// Stage 5: Instagram consent is per channel (src/lib/contacts/channel-consent.ts; SQL in
// channel-consent.integration.test.ts). The workspace has no own keywords here.
vi.mock('@/lib/contacts/channel-consent', async (original) => {
  const actual = await original<typeof import('@/lib/contacts/channel-consent')>();
  return { ...actual, applyInstagramConsent: h.igConsent,
    workerConsentSettings: async () => ({ ...actual.DEFAULT_CONSENT_SETTINGS, ...(h.settings ?? {}) }) };
});
vi.mock('@/lib/flows/channel-send', () => ({ flowSend: h.flowSend }));
vi.mock('@/lib/jobs/scope', () => ({ withJobScope: (_scope: unknown, action: () => unknown) => action() }));
vi.mock('./quick-reply-actions', () => ({ dispatchQuickReplyAction: vi.fn() }));
vi.mock('@/lib/automations/engine', () => ({ resumeAwaitingReply: h.resume, runAutomationsForTrigger: h.automations }));
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: h.flow, startFlowById: h.startFlow }));
vi.mock('@/lib/ai/auto-reply', () => ({ dispatchInboundToAiReply: h.ai, recordUnreadableInbound: h.mediaSkip }));
vi.mock('@/lib/ai/route-to-staff', () => ({ routeSensitiveInbound: h.routeStaff }));
vi.mock('@/lib/ai/auto-label', () => ({ enqueueAutoLabelForInbound: h.autoLabel }));
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
  h.contact = { blocked_at: null, instagram_opted_out_at: null };
  h.settings = null;
  h.flowSend.mockResolvedValue({ whatsapp_message_id: 'mid.out' });
  h.startFlow.mockResolvedValue({ outcome: 'started' });
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
      'ai_reply', 'away_message', 'message_webhook', 'ai_route_staff', 'ai_label']);
    // Route to staff and auto-labelling run for Instagram too, after the bots (each checks its own switch).
    expect(h.routeStaff).toHaveBeenCalledWith({ accountId: ID, conversationId: ID, contactId: ID, configOwnerUserId: ID, text: expect.any(String) });
    expect(h.autoLabel).toHaveBeenCalledWith(ID, ID);
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
    // Stage 5: an Instagram STOP unsubscribes from Instagram only; the contact-wide opt-out is untouched.
    expect(h.igConsent).toHaveBeenCalledWith(ID, ID, 'opted_out');
    expect(h.consent).toEqual([]);
    h.stages.clear();
    h.contact = { blocked_at: '2026-11-01T00:00:00Z', instagram_opted_out_at: null };
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

  // Stage 5 (5D): per-channel Instagram consent.
  it('gives a contact unsubscribed on Instagram no flow, automation, AI or away reply, but still routes it to the team', async () => {
    h.contact = { blocked_at: null, instagram_opted_out_at: '2026-11-10T00:00:00Z' };
    await processInboundActions(message({ contentText: 'hello again' }));
    for (const fn of [h.flow, h.automations, h.ai, h.away]) expect(fn).not.toHaveBeenCalled();
    expect(h.lifecycle).toHaveBeenCalledTimes(1);
    expect(h.webhook.mock.calls.filter((call) => call[2] === 'message.received')).toHaveLength(1);
  });

  it('lets START through for an unsubscribed contact (the gate sits after the keyword check)', async () => {
    h.contact = { blocked_at: null, instagram_opted_out_at: '2026-11-10T00:00:00Z' };
    await processInboundActions(message({ contentText: 'START' }));
    expect(h.igConsent).toHaveBeenCalledWith(ID, ID, 'opted_in');
    expect(h.flow).not.toHaveBeenCalled();
  });

  it("reads the workspace's own words, confirms once inside the window and runs the attached flow once, even on redelivery", async () => {
    const FLOW = '00000000-0000-4000-8000-0000000000f1';
    h.settings = { opt_out_keywords: ['basta'], opt_out_reply: 'You will not get automated messages here.', opt_out_flow_id: FLOW };
    await processInboundActions(message({ contentText: ' Basta ' }));
    await processInboundActions(message({ contentText: ' Basta ' }));
    expect(h.igConsent).toHaveBeenCalledWith(ID, ID, 'opted_out');
    expect(h.flowSend).toHaveBeenCalledTimes(1);
    expect(h.flowSend).toHaveBeenCalledWith({ account_id: ID, conversation_id: ID }, `consent:${ID}:opt_out`,
      { kind: 'text', args: expect.objectContaining({ conversationId: ID, contactId: ID, text: 'You will not get automated messages here.' }) });
    expect(h.startFlow).toHaveBeenCalledTimes(1);
    expect(h.startFlow).toHaveBeenCalledWith(expect.objectContaining({ accountId: ID, flowId: FLOW, contactId: ID, conversationId: ID }));
    for (const fn of [h.flow, h.automations, h.ai]) expect(fn).not.toHaveBeenCalled();
  });

  it('records the keyword and skips the confirmation when Instagram refuses it (window closed)', async () => {
    const { InstagramError } = await import('@/lib/instagram/errors');
    h.settings = { opt_in_reply: 'Welcome back.' };
    h.flowSend.mockRejectedValueOnce(new InstagramError('instagram_window_closed'));
    await expect(processInboundActions(message({ contentText: 'start' }))).resolves.not.toThrow();
    expect(h.igConsent).toHaveBeenCalledWith(ID, ID, 'opted_in');
    expect(h.stages.get('consent_reply:opt_in')).toBe('skipped');
  });
});
