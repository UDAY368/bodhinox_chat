import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ assess: vi.fn(), webhook: vi.fn(), ai: vi.fn(), route: vi.fn(), label: vi.fn(), stages: [] as string[], completed: new Map<string, unknown>(),
  contact: { blocked_at: null as string | null } }));
vi.mock('@/lib/data/admin', () => ({ createAdminClient: () => ({ from: (table: string) => {
  const b = { select: () => b, eq: () => b, in: () => b, is: () => b, gte: () => b, order: () => b, limit: async () => ({ data: [], error: null }),
    update: () => b, maybeSingle: async () => ({ data: table === 'contacts' ? h.contact : null, error: null }),
    then: (resolve: (r: { error: null }) => unknown) => resolve({ error: null }) }; return b;
} }) }));
vi.mock('@/lib/jobs/scope', () => ({ withJobScope: (_scope: unknown, action: () => unknown) => action() }));
vi.mock('./quick-reply-actions', () => ({ dispatchQuickReplyAction: async () => ({ handled: false }) }));
vi.mock('@/lib/automations/engine', () => ({ resumeAwaitingReply: async () => false, runAutomationsForTrigger: async () => false }));
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: async () => ({ consumed: false }) }));
vi.mock('@/lib/ai/auto-reply', () => ({ dispatchInboundToAiReply: h.ai, recordUnreadableInbound: vi.fn(async () => {}) }));
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: h.webhook }));
vi.mock('@/lib/inbox/lifecycle', () => ({ applyInboundLifecycle: async () => ({ botOwned: false, botReplied: true }) }));
vi.mock('@/lib/inbox/away-message', () => ({ sendAwayMessage: async () => 'skipped' }));
vi.mock('@/lib/contacts/consent', async (original) => ({ ...(await original<typeof import('@/lib/contacts/consent')>()), applyConsentKeyword: async () => {} }));
vi.mock('@/lib/ai/assess/enqueue', () => ({ enqueueAssessmentForInbound: h.assess }));
vi.mock('@/lib/ai/route-to-staff', () => ({ routeSensitiveInbound: h.route }));
vi.mock('@/lib/ai/auto-label', () => ({ enqueueAutoLabelForInbound: h.label }));
vi.mock('./ingest', () => ({ runInboundStage: async (_account: string, _message: string, stage: string, action: () => Promise<unknown>) => {
  h.stages.push(stage);
  if (h.completed.has(stage)) return h.completed.get(stage);
  const result = await action(); h.completed.set(stage, result); return result;
} }));
import { processInboundActions } from './inbound-actions';
import type { MessageActionsPayload } from './ingest';

const id = '00000000-0000-4000-8000-000000000001';
const conv = '00000000-0000-4000-8000-000000000002';
const text = (contentText: string, over: Partial<MessageActionsPayload> = {}): MessageActionsPayload => ({
  kind: 'message', accountId: id, conversationId: conv, contactId: id, userId: id, messageId: id, metaMessageId: 'wamid.1',
  interactiveReplyId: null, contentType: 'text', contentText, wasContactCreated: false, wasConversationCreated: false, isFirstInboundMessage: false, ...over,
} as MessageActionsPayload);

beforeEach(() => { delete process.env.AI_ENABLED; h.stages = []; h.completed.clear(); h.contact = { blocked_at: null }; h.assess.mockReset().mockResolvedValue(true);
  h.route.mockReset().mockResolvedValue(false); h.label.mockReset().mockResolvedValue(true); });
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

it('queues the advisory assessment after the message webhook, once, in its own stage', async () => {
  await processInboundActions(text('How much is the blue mug?'));
  await processInboundActions(text('How much is the blue mug?'));
  expect(h.assess).toHaveBeenCalledOnce();
  expect(h.assess).toHaveBeenCalledWith(id, conv);
  expect(h.stages.indexOf('ai_assess')).toBeGreaterThan(h.stages.indexOf('message_webhook'));
});

it('skips the stage entirely when the deployment switch is off', async () => {
  vi.stubEnv('AI_ENABLED', 'false');
  await processInboundActions(text('How much?'));
  expect(h.assess).not.toHaveBeenCalled();
  expect(h.stages).not.toContain('ai_assess');
});

it.each([
  ['a STOP keyword', text('STOP')],
  ['a button tap', text('Yes', { interactiveReplyId: 'qr', contentType: 'interactive' })],
  ['media', text('look', { contentType: 'image' })],
  ['blank text', text('   ')],
])('does not assess %s', async (_label, input) => {
  await processInboundActions(input);
  expect(h.assess).not.toHaveBeenCalled();
});

it('does not assess a blocked contact', async () => {
  h.contact = { blocked_at: '2026-11-01T00:00:00Z' };
  await processInboundActions(text('How much?'));
  expect(h.assess).not.toHaveBeenCalled();
});

it('routes a sensitive question to staff and queues auto-labelling of a new conversation, each once, after the bots', async () => {
  const first = text('I have a fever, which tablet should I take?', { wasConversationCreated: true, isFirstInboundMessage: true });
  await processInboundActions(first);
  await processInboundActions(first);
  expect(h.route).toHaveBeenCalledOnce();
  expect(h.route).toHaveBeenCalledWith({ accountId: id, conversationId: conv, contactId: id, configOwnerUserId: id,
    text: 'I have a fever, which tablet should I take?' });
  expect(h.label).toHaveBeenCalledOnce();
  expect(h.label).toHaveBeenCalledWith(id, conv);
  expect(h.stages.indexOf('ai_route_staff')).toBeGreaterThan(h.stages.indexOf('ai_reply'));
});

it('labels only new conversations', async () => {
  await processInboundActions(text('Any update on my order?'));
  expect(h.route).toHaveBeenCalledOnce();
  expect(h.label).not.toHaveBeenCalled();
});

it('runs neither for a STOP keyword, a blocked contact or with the deployment switch off', async () => {
  await processInboundActions(text('STOP', { wasConversationCreated: true }));
  h.contact = { blocked_at: '2026-11-01T00:00:00Z' };
  await processInboundActions(text('fever', { messageId: conv, wasConversationCreated: true }));
  vi.stubEnv('AI_ENABLED', 'false');
  h.contact = { blocked_at: null };
  await processInboundActions(text('fever', { metaMessageId: 'wamid.3', wasConversationCreated: true }));
  expect(h.route).not.toHaveBeenCalled();
  expect(h.label).not.toHaveBeenCalled();
});
