import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ explicit: vi.fn(), flow: vi.fn(), resume: vi.fn(), automations: vi.fn(), ai: vi.fn(), webhook: vi.fn(), stages: new Map<string, unknown>(),
  contact: { blocked_at: null as string | null }, consentUpdates: [] as Record<string, unknown>[], message: null as Record<string, unknown> | null, recipients: [] as unknown[] }));
vi.mock('@/lib/data/admin', () => ({ createAdminClient: () => ({ from: (table: string) => {
  const b = { select: () => b, eq: () => b, in: () => b, is: () => b, order: () => b, limit: async () => ({ data: table === 'broadcast_recipients' ? h.recipients : [], error: null }),
    update: (row: Record<string, unknown>) => { h.consentUpdates.push(row); return b; },
    maybeSingle: async () => ({ data: table === 'messages' ? h.message : h.contact, error: null }), then: (resolve: (r: { error: null }) => unknown) => resolve({ error: null }) }; return b;
} }) }));
vi.mock('@/lib/jobs/scope', () => ({ withJobScope: (_scope: unknown, action: () => unknown) => action() }));
vi.mock('./quick-reply-actions', () => ({ dispatchQuickReplyAction: h.explicit }));
vi.mock('@/lib/automations/engine', () => ({ resumeAwaitingReply: h.resume, runAutomationsForTrigger: h.automations }));
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: h.flow }));
vi.mock('@/lib/ai/auto-reply', () => ({ dispatchInboundToAiReply: h.ai }));
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: h.webhook }));
vi.mock('./ingest', () => ({ runInboundStage: async (_account: string, _message: string, stage: string, action: () => Promise<unknown>) => {
  if (h.stages.has(stage)) return h.stages.get(stage);
  const result = await action(); h.stages.set(stage, result); return result;
} }));
import { processInboundActions } from './inbound-actions';
import type { MessageActionsPayload } from './ingest';
const id = '00000000-0000-4000-8000-000000000001';
const input: MessageActionsPayload = { kind: 'message', accountId: id, conversationId: id, contactId: id, userId: id, messageId: id, metaMessageId: 'wamid.tap', interactiveReplyId: 'qr_token', contentType: 'interactive', contentText: 'Start', wasContactCreated: true, wasConversationCreated: true, isFirstInboundMessage: true };
beforeEach(() => { vi.clearAllMocks(); h.stages.clear(); h.contact = { blocked_at: null }; h.consentUpdates = []; h.message = null; h.recipients = []; h.explicit.mockResolvedValue({ handled: true, outcome: 'started' }); h.flow.mockResolvedValue({ consumed: false }); h.resume.mockResolvedValue(false); });

const text = (contentText: string) => ({ ...input, interactiveReplyId: null, contentType: 'text', contentText, wasContactCreated: false, isFirstInboundMessage: false });
it.each([['STOP', 'opt_out'], ['start', 'opt_in']])('records a %s keyword without any automated response', async (word, kind) => {
  await processInboundActions(text(word));
  expect(h.consentUpdates).toEqual([kind === 'opt_out' ? { opted_out_at: expect.any(String), opt_out_source: 'keyword' } : { opted_out_at: null, opt_out_source: null }]);
  expect(h.explicit).not.toHaveBeenCalled(); expect(h.flow).not.toHaveBeenCalled(); expect(h.automations).not.toHaveBeenCalled(); expect(h.ai).not.toHaveBeenCalled();
  expect(h.webhook).toHaveBeenCalledWith(expect.anything(), id, 'message.received', expect.anything());
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

it('rejects a malformed context id in a queued job', async () => {
  await expect(processInboundActions({ ...input, contextMetaId: 42 as never })).rejects.toThrow('Invalid message actions contract');
});
