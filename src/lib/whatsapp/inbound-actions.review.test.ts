import { beforeEach, expect, it, vi } from 'vitest';

// Store plan Phase 3: a review star tap, a typed rating after a template request and the words after
// a rating are taken by the review hooks, and then flows, automations, AI and the away message stay
// silent. A shop command, a blocked contact and an unclaimed message fall through to the bots.
const h = vi.hoisted(() => ({
  flow: vi.fn(), automations: vi.fn(), ai: vi.fn(), away: vi.fn(), consent: vi.fn(), rating: vi.fn(), text: vi.fn(), stages: [] as string[],
  contact: { blocked_at: null as string | null },
}));
vi.mock('@/lib/data/admin', () => ({ createAdminClient: () => ({ from: (table: string) => {
  const b = { select: () => b, eq: () => b, in: () => b, is: () => b, gte: () => b, order: () => b, limit: async () => ({ data: [], error: null }),
    update: () => b, maybeSingle: async () => ({ data: table === 'messages' ? null : h.contact, error: null }),
    then: (resolve: (r: { error: null }) => unknown) => resolve({ error: null }) };
  return b;
} }) }));
vi.mock('@/lib/commerce/review-jobs', () => ({ handleReviewRating: h.rating, handleReviewText: h.text }));
vi.mock('@/lib/commerce/public-shop', async (orig) => ({ ...(await orig<typeof import('@/lib/commerce/public-shop')>()), handleShopCartCode: async () => ({ handled: false }) }));
vi.mock('@/lib/commerce/stock-alert-jobs', () => ({ handleStockAlertCode: async () => ({ handled: false }) }));
vi.mock('@/lib/jobs/scope', () => ({ withJobScope: (_scope: unknown, action: () => unknown) => action() }));
vi.mock('./quick-reply-actions', () => ({ dispatchQuickReplyAction: async () => ({ handled: false }) }));
vi.mock('@/lib/automations/engine', () => ({ resumeAwaitingReply: async () => false, runAutomationsForTrigger: h.automations }));
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: h.flow }));
vi.mock('@/lib/ai/auto-reply', () => ({ dispatchInboundToAiReply: h.ai }));
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: vi.fn() }));
vi.mock('./ingest', () => ({ runInboundStage: async (_a: string, _m: string, stage: string, action: () => Promise<unknown>) => {
  h.stages.push(stage);
  return action();
} }));
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => 'worker' }));
vi.mock('@/lib/db/tenant', () => ({ withTenant: async (_c: unknown, op: (tx: unknown) => unknown) => op({}) }));
vi.mock('@/lib/inbox/lifecycle', () => ({ applyInboundLifecycle: async () => ({ state: 'requesting', botOwned: false, botReplied: false, routedTo: null, ruleId: null }) }));
vi.mock('@/lib/inbox/away-message', () => ({ sendAwayMessage: h.away }));
vi.mock('@/lib/contacts/consent', async (orig) => ({ ...(await orig<typeof import('@/lib/contacts/consent')>()), applyConsentKeyword: h.consent }));

import { processInboundActions } from './inbound-actions';
import type { MessageActionsPayload } from './ingest';

const id = '00000000-0000-4000-8000-000000000001';
const product = '00000000-0000-4000-8000-000000000003';
const tapId = `rvw:${id}:${product}:5`;
const message = (text: string, patch: Partial<MessageActionsPayload> = {}): MessageActionsPayload => ({
  kind: 'message', accountId: id, conversationId: id, contactId: id, userId: id, messageId: id, metaMessageId: 'wamid.in',
  interactiveReplyId: null, contentType: 'text', contentText: text, whatsappConfigId: undefined,
  wasContactCreated: false, wasConversationCreated: false, isFirstInboundMessage: false, ...patch,
});
const silent = () => {
  expect(h.flow).not.toHaveBeenCalled();
  expect(h.automations).not.toHaveBeenCalled();
  expect(h.ai).not.toHaveBeenCalled();
  expect(h.away).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  h.stages = [];
  h.contact = { blocked_at: null };
  h.flow.mockResolvedValue({ consumed: false });
  h.automations.mockResolvedValue(false);
  h.away.mockResolvedValue('off');
  h.rating.mockResolvedValue({ handled: false, outcome: 'ignored' });
  h.text.mockResolvedValue({ handled: false, outcome: 'ignored' });
});

it('hands a star tap to the rating hook with its message id and keeps the bots silent when it is taken', async () => {
  h.rating.mockResolvedValue({ handled: true, outcome: 'rated' });
  await processInboundActions(message('★★★★★', { contentType: 'interactive', interactiveReplyId: tapId }));
  expect(h.rating).toHaveBeenCalledWith(expect.objectContaining({ accountId: id, contactId: id, conversationId: id, messageId: id, replyId: tapId }), expect.any(Function));
  expect(h.text).not.toHaveBeenCalled();
  silent();
  expect(h.stages).toContain('message_webhook');
});

it('runs the rating thank-you inside the review_rating_ack stage', async () => {
  h.rating.mockImplementation(async (_input: unknown, run: (send: () => Promise<unknown>) => Promise<unknown>) => { await run(async () => 'sent'); return { handled: true, outcome: 'rated' }; });
  await processInboundActions(message('x', { contentType: 'interactive', interactiveReplyId: tapId }));
  expect(h.stages).toContain('review_rating_ack');
});

it('lets the bots answer a star tap that is not the order\'s own, and never calls the hook for other reply ids', async () => {
  await processInboundActions(message('★', { contentType: 'interactive', interactiveReplyId: tapId }));
  expect(h.rating).toHaveBeenCalledTimes(1);
  expect(h.flow).toHaveBeenCalledTimes(1);
  h.rating.mockClear();
  await processInboundActions(message('Yes', { contentType: 'interactive', interactiveReplyId: 'menu:yes' }));
  expect(h.rating).not.toHaveBeenCalled();
});

it('offers plain text to the review text hook and stays silent when it is taken', async () => {
  h.text.mockResolvedValue({ handled: true, outcome: 'body' });
  await processInboundActions(message('Lovely smell'));
  expect(h.text).toHaveBeenCalledWith(expect.objectContaining({ accountId: id, contactId: id, messageId: id, text: 'Lovely smell' }), expect.any(Function));
  silent();
});

it('does not offer a shop command, a blocked contact or a STOP message to the review hooks', async () => {
  await processInboundActions(message('ORDER ABC234'));
  await processInboundActions(message('NOTIFY ABC234'));
  await processInboundActions(message('STOP'));
  expect(h.text).not.toHaveBeenCalled();
  h.contact = { blocked_at: '2026-11-01T00:00:00Z' };
  await processInboundActions(message('Lovely smell'));
  expect(h.text).not.toHaveBeenCalled();
});

it('lets the bots answer text the review hook does not take', async () => {
  await processInboundActions(message('where is my parcel'));
  expect(h.text).toHaveBeenCalledTimes(1);
  expect(h.flow).toHaveBeenCalledTimes(1);
});
