import { beforeEach, expect, it, vi } from 'vitest';

// "BOOK <CODE>" confirms a public booking hold and keeps the bots silent.
const h = vi.hoisted(() => ({
  flow: vi.fn(), automations: vi.fn(), ai: vi.fn(), booking: vi.fn(), away: vi.fn(), consent: vi.fn(), stages: [] as string[],
  contact: { blocked_at: null as string | null },
}));
vi.mock('@/lib/data/admin', () => ({ createAdminClient: () => ({ from: (table: string) => {
  const b = { select: () => b, eq: () => b, in: () => b, is: () => b, gte: () => b, order: () => b, limit: async () => ({ data: [], error: null }),
    update: () => b, maybeSingle: async () => ({ data: table === 'messages' ? null : h.contact, error: null }),
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
vi.mock('@/lib/inbox/away-message', () => ({ sendAwayMessage: h.away }));
vi.mock('@/lib/contacts/consent', async (orig) => ({ ...(await orig<typeof import('@/lib/contacts/consent')>()), applyConsentKeyword: h.consent }));
vi.mock('@/lib/appointments/inbound', () => ({ handleBookingCode: h.booking }));

import { processInboundActions } from './inbound-actions';
import type { MessageActionsPayload } from './ingest';

const id = '00000000-0000-4000-8000-000000000001';
const cfg = '00000000-0000-4000-8000-000000000002';
const message = (text: string, patch: Partial<MessageActionsPayload> = {}): MessageActionsPayload => ({
  kind: 'message', accountId: id, conversationId: id, contactId: id, userId: id, messageId: id, metaMessageId: 'wamid.in',
  interactiveReplyId: null, contentType: 'text', contentText: text, whatsappConfigId: cfg,
  wasContactCreated: false, wasConversationCreated: false, isFirstInboundMessage: false, ...patch,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.stages = [];
  h.contact = { blocked_at: null };
  h.flow.mockResolvedValue({ consumed: false });
  h.automations.mockResolvedValue(false);
  h.away.mockResolvedValue('off');
  h.booking.mockResolvedValue({ handled: true });
});

it('hands a BOOK code to the booking hook and skips flows, automations, AI and the away message', async () => {
  await processInboundActions(message('  book  abc234 '));
  expect(h.booking).toHaveBeenCalledWith({ accountId: id, userId: id, contactId: id, conversationId: id, messageId: id,
    whatsappConfigId: cfg, code: 'ABC234' });
  expect(h.flow).not.toHaveBeenCalled();
  expect(h.automations).not.toHaveBeenCalled();
  expect(h.ai).not.toHaveBeenCalled();
  expect(h.away).not.toHaveBeenCalled();
  expect(h.stages).toContain('message_webhook');
  expect(h.stages).not.toContain('booking');
});

it('lets the bots answer when the hook does not handle the code', async () => {
  h.booking.mockResolvedValue({ handled: false });
  await processInboundActions(message('BOOK ABC234'));
  expect(h.booking).toHaveBeenCalled();
  expect(h.flow).toHaveBeenCalled();
});

it('ignores ordinary text and malformed codes', async () => {
  await processInboundActions(message('BOOK ABC12O')); // O and 1 are not in the code alphabet
  await processInboundActions(message('please book ABC234'));
  expect(h.booking).not.toHaveBeenCalled();
  expect(h.flow).toHaveBeenCalledTimes(2);
});

it('does not process a code from a blocked contact', async () => {
  h.contact = { blocked_at: '2026-11-01T00:00:00Z' };
  await processInboundActions(message('BOOK ABC234'));
  expect(h.booking).not.toHaveBeenCalled();
});

it('does not treat an interactive reply as a code', async () => {
  await processInboundActions(message('BOOK ABC234', { interactiveReplyId: 'btn-1' }));
  expect(h.booking).not.toHaveBeenCalled();
});

it('passes a null number for jobs queued before multi-number', async () => {
  await processInboundActions(message('BOOK ABC234', { whatsappConfigId: undefined }));
  expect(h.booking).toHaveBeenCalledWith(expect.objectContaining({ whatsappConfigId: null }));
});

it('"book sunday" that the hook does not handle still reaches the flows and the away message', async () => {
  h.booking.mockResolvedValue({ handled: false, outcome: 'code_unknown' });
  await processInboundActions(message('book sunday'));
  expect(h.booking).toHaveBeenCalledWith(expect.objectContaining({ code: 'SUNDAY' }));
  expect(h.flow).toHaveBeenCalled();
  expect(h.away).toHaveBeenCalled();
});
