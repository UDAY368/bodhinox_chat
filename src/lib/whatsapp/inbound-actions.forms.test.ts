import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  flow: vi.fn(), automations: vi.fn(), ai: vi.fn(), saveTo: vi.fn(), definition: { version: 1, screens: [] } as unknown,
  message: null as Record<string, unknown> | null, contact: { blocked_at: null as string | null },
}));
vi.mock('@/lib/data/admin', () => ({ createAdminClient: () => ({ from: (table: string) => {
  const b = { select: () => b, eq: () => b, in: () => b, is: () => b, order: () => b, limit: async () => ({ data: [], error: null }),
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
vi.mock('./ingest', () => ({ runInboundStage: async (_a: string, _m: string, _s: string, action: () => Promise<unknown>) => action() }));
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => 'worker' }));
vi.mock('@/lib/db/tenant', () => ({ withTenant: async (_c: unknown, op: (tx: unknown) => unknown) => op({}) }));
vi.mock('@/lib/inbox/lifecycle', () => ({ applyInboundLifecycle: async () => ({ state: 'requesting', botOwned: false, botReplied: false, routedTo: null, ruleId: null }) }));
vi.mock('@/lib/inbox/away-message', () => ({ sendAwayMessage: async () => 'off' }));
vi.mock('./forms/responses', () => ({ loadFormDefinition: async () => h.definition, applyFormSaveTo: h.saveTo }));

import { processInboundActions } from './inbound-actions';
import type { MessageActionsPayload } from './ingest';

const id = '00000000-0000-4000-8000-000000000001';
const FORM = '00000000-0000-4000-8000-000000000002';
const input: MessageActionsPayload = { kind: 'message', accountId: id, conversationId: id, contactId: id, userId: id, messageId: id,
  metaMessageId: 'wamid.form', interactiveReplyId: null, contentType: 'interactive', contentText: 'Form submitted: Lead\nName: Ana',
  wasContactCreated: false, wasConversationCreated: false, isFirstInboundMessage: false };
const stored = (patch: Record<string, unknown> = {}) => ({ interactive_payload: { form: {
  form_id: FORM, form_name: 'Lead', answers: { name: 'Ana' }, trusted: true, flow_run_id: 'run-1', node_key: 'ask', ...patch } } });

beforeEach(() => {
  vi.clearAllMocks();
  h.flow.mockResolvedValue({ consumed: false });
  h.automations.mockResolvedValue(false);
  h.contact = { blocked_at: null };
  h.message = stored();
});

it('hands a trusted submission to the flow engine and applies its save_to mappings', async () => {
  await processInboundActions(input);
  expect(h.saveTo).toHaveBeenCalledWith(expect.anything(), id, id, h.definition, { name: 'Ana' });
  expect(h.flow).toHaveBeenCalledWith(expect.objectContaining({ message: {
    kind: 'form', form_id: FORM, answers: { name: 'Ana' }, summary: input.contentText, trusted: true,
    flow_run_id: 'run-1', node_key: 'ask', meta_message_id: 'wamid.form' } }));
});

it('never writes contact fields from an untrusted submission', async () => {
  h.message = stored({ trusted: false, flow_run_id: null, node_key: null });
  await processInboundActions(input);
  expect(h.saveTo).not.toHaveBeenCalled();
  expect(h.flow).toHaveBeenCalledWith(expect.objectContaining({ message: expect.objectContaining({ kind: 'form', trusted: false }) }));
});

it('still saves answers for a blocked contact but sends nothing automated', async () => {
  h.contact = { blocked_at: '2026-11-01T00:00:00Z' };
  await processInboundActions(input);
  expect(h.saveTo).toHaveBeenCalledOnce();
  expect(h.flow).not.toHaveBeenCalled();
  expect(h.automations).not.toHaveBeenCalled();
});

it('does not run keyword automations or the AI on a form summary', async () => {
  await processInboundActions(input);
  expect(h.automations.mock.calls.map((call) => call[0].triggerType)).toEqual(['new_message_received']);
  expect(h.ai).not.toHaveBeenCalled();
});
