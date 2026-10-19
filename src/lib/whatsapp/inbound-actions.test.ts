import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ explicit: vi.fn(), flow: vi.fn(), resume: vi.fn(), automations: vi.fn(), ai: vi.fn(), webhook: vi.fn(), stages: new Map<string, unknown>() }));
vi.mock('@/lib/data/admin', () => ({ createAdminClient: () => ({ from: () => {
  const b = { select: () => b, eq: () => b, in: () => b, order: () => b, limit: async () => ({ data: [], error: null }) }; return b;
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
beforeEach(() => { vi.clearAllMocks(); h.stages.clear(); h.explicit.mockResolvedValue({ handled: true, outcome: 'started' }); h.flow.mockResolvedValue({ consumed: false }); h.resume.mockResolvedValue(false); });
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
