import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ lifecycle: vi.fn(), away: vi.fn(), explicit: vi.fn(), flow: vi.fn(), resume: vi.fn(), automations: vi.fn(), ai: vi.fn(), mediaSkip: vi.fn(), webhook: vi.fn(), stages: new Map<string, unknown>(),
  contact: { blocked_at: null as string | null }, consentUpdates: [] as Record<string, unknown>[], runUpdates: [] as Record<string, unknown>[], message: null as Record<string, unknown> | null, conversation: null as Record<string, unknown> | null, recipients: [] as unknown[], messageError: false }));
vi.mock('@/lib/data/admin', () => ({ createAdminClient: () => ({ from: (table: string) => {
  const b = { select: () => b, eq: () => b, in: () => b, is: () => b, gte: () => b, order: () => b, limit: async () => ({ data: table === 'broadcast_recipients' ? h.recipients : [], error: null }),
    update: (row: Record<string, unknown>) => { (table === 'flow_runs' ? h.runUpdates : h.consentUpdates).push(row); return b; },
    maybeSingle: async () => (table === 'messages' && h.messageError ? { data: null, error: { message: 'connection reset' } }
      : { data: table === 'messages' ? h.message : table === 'conversations' && h.conversation ? h.conversation : h.contact, error: null }), then: (resolve: (r: { error: null }) => unknown) => resolve({ error: null }) }; return b;
} }) }));
// Stage 5: Instagram consent reads the workspace's own keywords (none here) and records STOP per channel.
vi.mock('@/lib/contacts/channel-consent', async (original) => {
  const actual = await original<typeof import('@/lib/contacts/channel-consent')>();
  return { ...actual, applyInstagramConsent: vi.fn(), workerConsentSettings: async () => ({ ...actual.DEFAULT_CONSENT_SETTINGS }) };
});
vi.mock('@/lib/jobs/scope', () => ({ withJobScope: (_scope: unknown, action: () => unknown) => action() }));
vi.mock('./quick-reply-actions', () => ({ dispatchQuickReplyAction: h.explicit }));
vi.mock('@/lib/automations/engine', () => ({ resumeAwaitingReply: h.resume, runAutomationsForTrigger: h.automations }));
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: h.flow }));
vi.mock('@/lib/ai/auto-reply', () => ({ dispatchInboundToAiReply: h.ai, recordUnreadableInbound: h.mediaSkip }));
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: h.webhook }));
vi.mock('@/lib/inbox/lifecycle', () => ({ applyInboundLifecycle: h.lifecycle }));
vi.mock('@/lib/inbox/away-message', () => ({ sendAwayMessage: h.away }));
vi.mock('./ingest', () => ({ runInboundStage: async (_account: string, _message: string, stage: string, action: () => Promise<unknown>) => {
  if (h.stages.has(stage)) return h.stages.get(stage);
  const result = await action(); h.stages.set(stage, result); return result;
} }));
import { processInboundActions } from './inbound-actions';
import type { MessageActionsPayload } from './ingest';
const id = '00000000-0000-4000-8000-000000000001';
const input: MessageActionsPayload = { kind: 'message', accountId: id, conversationId: id, contactId: id, userId: id, messageId: id, metaMessageId: 'wamid.tap', interactiveReplyId: 'qr_token', contentType: 'interactive', contentText: 'Start', wasContactCreated: true, wasConversationCreated: true, isFirstInboundMessage: true };
beforeEach(() => { vi.clearAllMocks(); h.stages.clear(); h.contact = { blocked_at: null }; h.consentUpdates = []; h.runUpdates = []; h.message = null; h.conversation = null; h.recipients = []; h.messageError = false; h.explicit.mockResolvedValue({ handled: true, outcome: 'started' }); h.lifecycle.mockResolvedValue({ state: 'requesting', botOwned: false, botReplied: false, routedTo: null, ruleId: null }); h.away.mockResolvedValue('sent'); h.flow.mockResolvedValue({ consumed: false }); h.resume.mockResolvedValue(false); });

const text = (contentText: string) => ({ ...input, interactiveReplyId: null, contentType: 'text', contentText, wasContactCreated: false, isFirstInboundMessage: false });
it.each([['STOP', 'opt_out'], ['start', 'opt_in']])('records a %s keyword without any automated response', async (word, kind) => {
  await processInboundActions(text(word));
  expect(h.consentUpdates).toEqual([kind === 'opt_out' ? { opted_out_at: expect.any(String), opt_out_source: 'keyword' } : { opted_out_at: null, opt_out_source: null }]);
  expect(h.explicit).not.toHaveBeenCalled(); expect(h.flow).not.toHaveBeenCalled(); expect(h.automations).not.toHaveBeenCalled(); expect(h.ai).not.toHaveBeenCalled();
  expect(h.webhook).toHaveBeenCalledWith(expect.anything(), id, 'message.received', expect.anything());
  // STOP also cancels the contact's running flows (A15); START leaves them alone.
  expect(h.runUpdates).toEqual(kind === 'opt_out' ? [expect.objectContaining({ status: 'cancelled', end_reason: 'contact_opted_out' })] : []);
});
it.each([['Stop promotions', 'STOP_PROMO'], ['No more offers', 'UNSUBSCRIBE']])('opts out on a template quick-reply tap %j / %j, like typed STOP', async (label, payload) => {
  await processInboundActions({ ...input, templateQuickReply: true, contentText: label, interactiveReplyId: payload });
  expect(h.consentUpdates).toEqual([{ opted_out_at: expect.any(String), opt_out_source: 'keyword' }]);
  expect(h.runUpdates).toEqual([expect.objectContaining({ status: 'cancelled', end_reason: 'contact_opted_out' })]);
  expect(h.explicit).not.toHaveBeenCalled(); expect(h.flow).not.toHaveBeenCalled(); expect(h.automations).not.toHaveBeenCalled();
  expect(h.webhook).toHaveBeenCalledWith(expect.anything(), id, 'message.received', expect.anything());
});
it('leaves consent alone for a Start template tap and for a Stop tap on a non-template button', async () => {
  await processInboundActions({ ...input, templateQuickReply: true });
  h.stages.clear();
  await processInboundActions({ ...input, contentText: 'Stop', interactiveReplyId: 'stop' });
  expect(h.consentUpdates).toEqual([]);
  expect(h.explicit).toHaveBeenCalledTimes(2);
});
it('rejects a malformed template tap flag in a queued job', async () => {
  await expect(processInboundActions({ ...input, templateQuickReply: 'yes' as never })).rejects.toThrow('Invalid message actions contract');
});
it('gives a blocked contact no automated response but still emits message.received', async () => {
  h.contact = { blocked_at: '2026-11-01T00:00:00Z' };
  await processInboundActions(text('Hello'));
  expect(h.explicit).not.toHaveBeenCalled(); expect(h.flow).not.toHaveBeenCalled(); expect(h.automations).not.toHaveBeenCalled(); expect(h.ai).not.toHaveBeenCalled();
  expect(h.webhook).toHaveBeenCalledWith(expect.anything(), id, 'message.received', expect.anything());
});
it.each(['started', 'unavailable', 'conflict'])('consumes an explicit CTA with outcome %s and preserves external message events', async outcome => {
  h.explicit.mockResolvedValue({ handled: true, outcome });
  await processInboundActions(input);
  expect(h.flow).not.toHaveBeenCalled(); expect(h.resume).not.toHaveBeenCalled(); expect(h.automations).not.toHaveBeenCalled(); expect(h.ai).not.toHaveBeenCalled();
  expect(h.webhook).toHaveBeenCalledWith(expect.anything(), id, 'message.received', expect.anything());
  expect(h.webhook).toHaveBeenCalledWith(expect.anything(), id, 'conversation.created', expect.anything());
});
it('retains default automations for an unbound interactive reply', async () => {
  h.explicit.mockResolvedValue({ handled: false });
  await processInboundActions(input);
  expect(h.flow).toHaveBeenCalledOnce(); expect(h.resume).toHaveBeenCalledOnce();
  expect(h.automations.mock.calls.map(call => call[0].triggerType)).toEqual(['first_inbound_message', 'new_contact_created', 'new_message_received', 'keyword_match', 'interactive_reply']);
});
it('replays the completed action stage without dispatching the workflow again', async () => {
  await processInboundActions(input); await processInboundActions(input);
  expect(h.explicit).toHaveBeenCalledOnce(); expect(h.automations).not.toHaveBeenCalled();
});

it('routes an opted-in menu question only to AI and replays its durable decision', async () => {
  h.explicit.mockResolvedValue({ handled: false }); h.flow.mockResolvedValue({ consumed: true, outcome: 'ai_fallback' });
  const message = { ...input, interactiveReplyId: null, contentType: 'text', contentText: 'Opening hours?', wasContactCreated: false, isFirstInboundMessage: false };
  await processInboundActions(message); await processInboundActions(message);
  expect(h.resume).not.toHaveBeenCalled(); expect(h.automations).not.toHaveBeenCalled();
  expect(h.ai).toHaveBeenCalledOnce();
  expect(h.ai).toHaveBeenCalledWith(expect.objectContaining({ routingChecked: true, requireHandoffOnUnavailable: true }));
});

it.each([true, false])('suppresses AI only when an automation matches: %s', async matched => {
  h.explicit.mockResolvedValue({ handled: false }); h.automations.mockResolvedValue(matched);
  await processInboundActions({ ...input, interactiveReplyId: null, contentType: 'text', contentText: 'Opening hours?', wasContactCreated: false, isFirstInboundMessage: false });
  expect(h.ai).toHaveBeenCalledTimes(matched ? 0 : 1);
  if (!matched) expect(h.ai).toHaveBeenCalledWith(expect.objectContaining({ routingChecked: true }));
});

it('passes the inbound row id so a rate-limited AI reply can be retried under its stage checkpoint', async () => {
  h.explicit.mockResolvedValue({ handled: false });
  await processInboundActions({ ...input, interactiveReplyId: null, contentType: 'text', contentText: 'Opening hours?', wasContactCreated: false, isFirstInboundMessage: false });
  expect(h.ai).toHaveBeenCalledWith(expect.objectContaining({ inboundMessageId: 'wamid.tap', inboundRowId: id }));
  expect(h.mediaSkip).not.toHaveBeenCalled();
});

it.each(['image', 'audio', 'video', 'document', 'location'])('logs an unanswered %s for the AI activity log once, and never dispatches the AI (audit 27)', async contentType => {
  h.explicit.mockResolvedValue({ handled: false });
  const media = { ...input, interactiveReplyId: null, contentType, contentText: null, wasContactCreated: false, isFirstInboundMessage: false };
  await processInboundActions(media); await processInboundActions(media);
  expect(h.ai).not.toHaveBeenCalled();
  expect(h.mediaSkip).toHaveBeenCalledOnce();
  expect(h.mediaSkip).toHaveBeenCalledWith({ accountId: id, conversationId: id, contactId: id, configOwnerUserId: id, inboundMessageId: 'wamid.tap' });
});

it('logs nothing for a photo a flow or automation already handled', async () => {
  h.explicit.mockResolvedValue({ handled: false }); h.flow.mockResolvedValue({ consumed: true });
  await processInboundActions({ ...input, interactiveReplyId: null, contentType: 'image', contentText: null, wasContactCreated: false, isFirstInboundMessage: false });
  expect(h.mediaSkip).not.toHaveBeenCalled();
});

it('reserves a legacy menu text question for AI without content triggers', async () => {
  h.explicit.mockResolvedValue({ handled: false }); h.resume.mockResolvedValue('ai_fallback');
  await processInboundActions({ ...input, interactiveReplyId: null, contentType: 'text', contentText: 'Opening hours?', wasContactCreated: false, isFirstInboundMessage: false });
  expect(h.automations).not.toHaveBeenCalled();
  expect(h.ai).toHaveBeenCalledWith(expect.objectContaining({ routingChecked: true, requireHandoffOnUnavailable: true }));
});

it.each([
  ['location', { interactive_payload: { location: { latitude: 12.9, longitude: 77.5, name: 'Office' } } }, { kind: 'location', latitude: 12.9, longitude: 77.5, name: 'Office' }],
  ['image', { media_url: 'https://cdn/x.jpg', media_type: 'image/jpeg' }, { kind: 'media', media_type: 'image', url: 'https://cdn/x.jpg', caption: 'Look' }],
  ['interactive', { interactive_payload: { address: { city: 'Pune' } } }, { kind: 'address', values: { city: 'Pune' } }],
  ['image', { media_url: null }, { kind: 'text', text: 'Look' }],
])('hands flows the stored %s message in its structured shape', async (contentType, row, expected) => {
  h.explicit.mockResolvedValue({ handled: false }); h.message = row;
  await processInboundActions({ ...input, interactiveReplyId: null, contentType, contentText: 'Look', wasContactCreated: false, isFirstInboundMessage: false });
  expect(h.flow.mock.calls[0][0].message).toEqual({ ...expected, meta_message_id: 'wamid.tap' });
});

it('tells flows which template a button tap answers: a saved template message, or a broadcast send', async () => {
  h.explicit.mockResolvedValue({ handled: false });
  const tap = { ...input, interactiveReplyId: 'Track', contentType: 'interactive', contentText: 'Track', wasContactCreated: false, isFirstInboundMessage: false };
  h.message = { reply_to_message_id: '00000000-0000-4000-8000-000000000002', content_type: 'template', template_name: 'order_update' };
  await processInboundActions(tap);
  expect(h.flow.mock.calls[0][0].message).toMatchObject({ kind: 'interactive_reply', context_template: 'order_update' });

  h.flow.mockClear(); h.stages.clear();
  h.message = { reply_to_message_id: null };
  h.recipients = [{ id: 'r1', broadcasts: { template_name: 'spring_sale' } }];
  await processInboundActions({ ...tap, contextMetaId: 'wamid.broadcast' });
  expect(h.flow.mock.calls[0][0].message).toMatchObject({ context_template: 'spring_sale' });

  h.flow.mockClear(); h.stages.clear();
  await processInboundActions(tap);
  expect(h.flow.mock.calls[0][0].message.context_template).toBeUndefined();
});

it('[audit-57] reads the replied message before the flow stage claims its checkpoint, so a DB blip retries', async () => {
  h.explicit.mockResolvedValue({ handled: false });
  const tap = { ...input, interactiveReplyId: 'Track', contentType: 'interactive', contentText: 'Track', wasContactCreated: false, isFirstInboundMessage: false };
  h.messageError = true;
  await expect(processInboundActions(tap)).rejects.toThrow('Inbound message lookup failed');
  // The flow stage was never entered, so no checkpoint can turn the failure into an uncertain dispatch.
  expect(h.stages.has('flow')).toBe(false);
  expect(h.flow).not.toHaveBeenCalled(); expect(h.automations).not.toHaveBeenCalled();
  // The job's retry runs the flow and every later stage.
  h.messageError = false; h.message = { reply_to_message_id: null };
  await processInboundActions(tap);
  expect(h.flow).toHaveBeenCalledOnce();
  expect(h.webhook).toHaveBeenCalledWith(expect.anything(), id, 'message.received', expect.anything());
});

it('rejects a malformed context id in a queued job', async () => {
  await expect(processInboundActions({ ...input, contextMetaId: 42 as never })).rejects.toThrow('Invalid message actions contract');
});

it('applies the lifecycle after the bots and sends the away message once through its stage', async () => {
  h.explicit.mockResolvedValue({ handled: false }); h.automations.mockResolvedValue(false);
  const message = text('Are you open?');
  await processInboundActions(message); await processInboundActions(message);
  expect(h.lifecycle).toHaveBeenCalledWith({ accountId: id, conversationId: id, contactId: id, messageId: id, text: 'Are you open?' });
  expect(h.lifecycle.mock.invocationCallOrder[0]).toBeGreaterThan(h.ai.mock.invocationCallOrder[0]);
  expect(h.away).toHaveBeenCalledOnce();
  expect(h.away).toHaveBeenCalledWith({ accountId: id, userId: id, conversationId: id, contactId: id, messageId: id });
});
it.each([[{ botOwned: true, botReplied: false }], [{ botOwned: false, botReplied: true }]])('sends no away message when a bot answered: %o', async flags => {
  h.explicit.mockResolvedValue({ handled: false });
  h.lifecycle.mockResolvedValue({ state: 'bot', routedTo: null, ruleId: null, ...flags });
  await processInboundActions(text('Hello'));
  expect(h.away).not.toHaveBeenCalled();
});
it('neither routes nor sends an away message to a blocked contact or a STOP keyword', async () => {
  await processInboundActions(text('STOP'));
  h.contact = { blocked_at: '2026-11-01T00:00:00Z' };
  await processInboundActions(text('Hello'));
  expect(h.lifecycle).not.toHaveBeenCalled(); expect(h.away).not.toHaveBeenCalled();
});

describe('click-to-WhatsApp ad referrals', () => {
  const adReferral = { id: '00000000-0000-4000-8000-0000000000ad', sourceId: '120211234567890', sourceType: 'ad' as 'ad' | 'post' | 'unknown', headline: 'Summer sale', sourceUrl: 'https://fb.me/x' };
  const fromAd = (patch: Partial<typeof adReferral> = {}) => ({ ...text('Hi'), isFirstInboundMessage: true, adReferral: { ...adReferral, ...patch } });

  it('still accepts jobs queued before the referral existed, and refuses a malformed one', async () => {
    await expect(processInboundActions(text('Hi'))).resolves.toBeUndefined();
    for (const bad of [{ id: 'not-a-uuid' }, { sourceId: 'act_1' }, { sourceType: 'story' }, { headline: 'x'.repeat(257) }, { sourceUrl: 7 }]) {
      await expect(processInboundActions(fromAd(bad as never))).rejects.toThrow('Invalid message actions contract');
    }
    await expect(processInboundActions({ ...text('Hi'), adReferral: null as never })).rejects.toThrow('Invalid message actions contract');
  });

  it('gives flows the referral (never the click id) and runs ad_click ahead of the first-message automations', async () => {
    h.explicit.mockResolvedValue({ handled: false });
    await processInboundActions(fromAd());
    expect(h.flow.mock.calls[0][0].message.referral).toEqual({ source_id: '120211234567890', source_type: 'ad', headline: 'Summer sale', source_url: 'https://fb.me/x' });
    expect(h.automations.mock.calls.map(call => call[0].triggerType)).toEqual(['ad_click', 'first_inbound_message', 'new_message_received', 'keyword_match']);
    expect(h.automations.mock.calls[0][0].context).toMatchObject({ ad_id: '120211234567890' });
    expect(h.automations.mock.calls[1][0].context).not.toHaveProperty('ad_id');
  });

  it('skips ad_click for a boosted post, and keeps it with the first-message triggers when a flow took the message', async () => {
    h.explicit.mockResolvedValue({ handled: false });
    await processInboundActions(fromAd({ sourceType: 'post' }));
    expect(h.automations.mock.calls.map(call => call[0].triggerType)).not.toContain('ad_click');
    vi.clearAllMocks(); h.stages.clear(); h.explicit.mockResolvedValue({ handled: false }); h.flow.mockResolvedValue({ consumed: true, outcome: 'started' }); h.lifecycle.mockResolvedValue({ state: 'requesting', botOwned: false, botReplied: false, routedTo: null, ruleId: null });
    await processInboundActions(fromAd({ id: '00000000-0000-4000-8000-0000000000ae' }));
    expect(h.automations.mock.calls.map(call => call[0].triggerType)).toEqual(['ad_click', 'first_inbound_message']);
  });
});

it('acts on an Instagram message for the contact that owns the conversation now, not the queued one', async () => {
  const moved = '00000000-0000-4000-8000-0000000000b2';
  h.conversation = { channel: 'instagram', contact_id: moved };
  await processInboundActions(text('Hello'));
  expect(h.flow).toHaveBeenCalledOnce();
  expect(h.flow.mock.calls[0][0]).toMatchObject({ contactId: moved, conversationId: id });
  expect(h.lifecycle).toHaveBeenCalledWith(expect.objectContaining({ contactId: moved }));
  // Instagram automations (Stage 1) run for the same current contact, on Instagram only.
  expect(h.automations).toHaveBeenCalled();
  for (const [call] of h.automations.mock.calls) expect(call).toMatchObject({ channel: 'instagram', contactId: moved, context: { conversation_id: id } });
});

it('lets a run parked at an Instagram menu take the reply instead of the Instagram triggers', async () => {
  h.conversation = { channel: 'instagram', contact_id: text('x').contactId };
  h.resume.mockResolvedValueOnce(true);
  await processInboundActions(text('Option A'));
  expect(h.resume).toHaveBeenCalledWith(expect.objectContaining({ channel: 'instagram', context: expect.objectContaining({ message_text: 'Option A' }) }));
  expect(h.automations).not.toHaveBeenCalled();
});

it('runs no Instagram automation when a flow took the message', async () => {
  h.conversation = { channel: 'instagram', contact_id: text('x').contactId };
  h.flow.mockResolvedValueOnce({ consumed: true, outcome: 'started' });
  await processInboundActions(text('Hi'));
  expect(h.resume).not.toHaveBeenCalled();
  expect(h.automations).not.toHaveBeenCalled();
});
