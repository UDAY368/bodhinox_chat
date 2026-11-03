import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  flow: vi.fn(), automations: vi.fn(), ai: vi.fn(), confirm: vi.fn(), stages: [] as string[],
  message: null as Record<string, unknown> | null, contact: { blocked_at: null as string | null },
}));
vi.mock('@/lib/data/admin', () => ({ createAdminClient: () => ({ from: (table: string) => {
  const b = { select: () => b, eq: () => b, in: () => b, is: () => b, gte: () => b, order: () => b, limit: async () => ({ data: [], error: null }),
    update: () => b, maybeSingle: async () => ({ data: table === 'messages' ? h.message : h.contact, error: null }),
    then: (resolve: (r: { error: null }) => unknown) => resolve({ error: null }) };
  return b;
} }) }));
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
vi.mock('@/lib/inbox/away-message', () => ({ sendAwayMessage: async () => 'off' }));
vi.mock('@/lib/commerce/order-confirmation', () => ({ sendOrderConfirmation: h.confirm }));

import { processInboundActions } from './inbound-actions';
import type { MessageActionsPayload } from './ingest';

const id = '00000000-0000-4000-8000-000000000001';
const ORDER = '00000000-0000-4000-8000-000000000009';
const order = { order_id: ORDER, catalog_id: '1', currency: 'INR', subtotal_minor: 109900, note: null,
  items: [{ retailer_id: 'SHIRT', name: 'Blue shirt', quantity: 2, unit_price_minor: 49950 }, { retailer_id: 'CAP', name: null, quantity: 1, unit_price_minor: 10000 }] };
const input: MessageActionsPayload = { kind: 'message', accountId: id, conversationId: id, contactId: id, userId: id, messageId: id,
  metaMessageId: 'wamid.order', interactiveReplyId: null, contentType: 'interactive', contentText: '[Order] 2 × Blue shirt, 1 × CAP — ₹1,099.00',
  wasContactCreated: false, wasConversationCreated: false, isFirstInboundMessage: false };

beforeEach(() => {
  vi.clearAllMocks();
  h.stages = [];
  h.flow.mockResolvedValue({ consumed: false });
  h.automations.mockResolvedValue(false);
  h.confirm.mockResolvedValue('sent');
  h.contact = { blocked_at: null };
  h.message = { interactive_payload: { order } };
});

it('hands the cart to flows as an order with its variables', async () => {
  await processInboundActions(input);
  expect(h.flow).toHaveBeenCalledWith(expect.objectContaining({ message: {
    kind: 'order', summary: input.contentText, meta_message_id: 'wamid.order',
    vars: { order_id: ORDER, order_total: '₹1,099.00', order_currency: 'INR', order_items_count: '3', order_items: '2 × Blue shirt, 1 × CAP' },
  } }));
});

it('sends the confirmation in its own checkpoint after flows and automations, before the webhook', async () => {
  await processInboundActions(input);
  expect(h.confirm).toHaveBeenCalledWith({ accountId: id, userId: id, conversationId: id, contactId: id, order });
  expect(h.stages.indexOf('order_confirmation')).toBeGreaterThan(h.stages.indexOf('flow'));
  expect(h.stages.indexOf('order_confirmation')).toBeLessThan(h.stages.indexOf('message_webhook'));
});

it('does not run keyword automations or the AI on a cart', async () => {
  await processInboundActions(input);
  expect(h.automations.mock.calls.map((call) => call[0].triggerType)).toEqual(['new_message_received']);
  expect(h.ai).not.toHaveBeenCalled();
});

it('sends nothing to a blocked contact', async () => {
  h.contact = { blocked_at: '2026-11-01T00:00:00Z' };
  await processInboundActions(input);
  expect(h.confirm).not.toHaveBeenCalled();
  expect(h.flow).not.toHaveBeenCalled();
});

it('ignores interactive messages without a stored cart', async () => {
  h.message = { interactive_payload: null };
  await processInboundActions(input);
  expect(h.confirm).not.toHaveBeenCalled();
  expect(h.stages).not.toContain('order_confirmation');
});
