// Phase 11 design 3.4: WhatsApp paths ignore or refuse Instagram conversations.
// Unit level (mocked I/O). The SQL paths (pickers, adopt update, send core,
// catalogue, forms, storefront, booking-code reply) are proven on PostgreSQL in
// src/lib/instagram/conversation-channel.integration.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  conversation: { whatsapp_config_id: null as string | null, channel: 'instagram' as string },
  tables: [] as string[],
  dispatch: vi.fn(),
  send: vi.fn(),
  getNumberConfig: vi.fn(),
  flow: vi.fn(),
  automations: vi.fn(),
  resume: vi.fn(),
  ai: vi.fn(),
  away: vi.fn(),
  webhook: vi.fn(),
  lifecycle: vi.fn(),
  explicit: vi.fn(),
  orderConfirmation: vi.fn(),
  booking: vi.fn(),
  consent: [] as unknown[],
  igConsent: vi.fn(),
}));

// Stage 5: Instagram STOP is per channel (src/lib/contacts/channel-consent.ts).
vi.mock('@/lib/contacts/channel-consent', async (original) => {
  const actual = await original<typeof import('@/lib/contacts/channel-consent')>();
  return { ...actual, applyInstagramConsent: h.igConsent, workerConsentSettings: async () => ({ ...actual.DEFAULT_CONSENT_SETTINGS }) };
});

vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => 'worker' }));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (_context: unknown, op: (tx: unknown) => unknown) => op({
    $queryRaw: async () => [{ created_at: new Date('2026-11-02T20:00:00Z') }],
    $executeRaw: async () => 1,
    conversations: { findFirst: async () => h.conversation },
  }),
}));
vi.mock('@/lib/whatsapp/numbers', async (original) => ({
  ...(await original<typeof import('@/lib/whatsapp/numbers')>()),
  getNumberConfig: h.getNumberConfig,
}));
vi.mock('@/lib/inbox/inbox-settings', () => ({
  readInboxSettings: async () => ({ timezone: 'UTC', working_hours: { mon: [{ start: '09:00', end: '18:00' }] },
    away_message_enabled: true, away_message: 'Back at 9' }),
}));
vi.mock('@/lib/whatsapp/bot-pause', () => ({ botRepliesPaused: async () => false }));
vi.mock('@/lib/jobs/dispatch', () => ({ dispatchOnce: h.dispatch }));
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.send }));
vi.mock('@/lib/automations/meta-send', () => ({ engineSendText: h.send, engineSendTemplate: h.send }));
vi.mock('@/lib/commerce/orders', () => ({
  loadOrderSettingsForWorker: async () => ({ confirmation_mode: 'text', confirmation_text: 'Thanks!' }),
}));

// inbound-actions collaborators
vi.mock('@/lib/data/admin', () => ({ createAdminClient: () => ({ from: (table: string) => {
  h.tables.push(table);
  const b = { select: () => b, eq: () => b, in: () => b, is: () => b, gte: () => b, order: () => b,
    limit: async () => ({ data: [], error: null }),
    update: (row: unknown) => { h.consent.push(row); return b; },
    maybeSingle: async () => ({ data: table === 'conversations' ? h.conversation : { blocked_at: null }, error: null }),
    then: (resolve: (r: { error: null }) => unknown) => resolve({ error: null }) };
  return b;
} }) }));
vi.mock('@/lib/jobs/scope', () => ({ withJobScope: (_scope: unknown, action: () => unknown) => action() }));
vi.mock('@/lib/whatsapp/quick-reply-actions', () => ({ dispatchQuickReplyAction: h.explicit }));
vi.mock('@/lib/automations/engine', () => ({ resumeAwaitingReply: h.resume, runAutomationsForTrigger: h.automations }));
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: h.flow }));
vi.mock('@/lib/ai/auto-reply', () => ({ dispatchInboundToAiReply: h.ai }));
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: h.webhook }));
vi.mock('@/lib/inbox/lifecycle', () => ({ applyInboundLifecycle: h.lifecycle }));
vi.mock('@/lib/appointments/inbound', () => ({ handleBookingCode: h.booking }));
vi.mock('@/lib/whatsapp/ingest', () => ({ runInboundStage: async (_a: string, _m: string, _s: string, action: () => Promise<unknown>) => action() }));

import { assertWhatsAppConversation, NoNumberError } from '@/lib/whatsapp/numbers';
import { loadConversationSenderConfig, numberErrorText } from '@/lib/whatsapp/sender-config';
import { sendAwayMessage } from '@/lib/inbox/away-message';
import { sendOrderConfirmation } from '@/lib/commerce/order-confirmation';
import { processInboundActions } from '@/lib/whatsapp/inbound-actions';
import type { MessageActionsPayload } from '@/lib/whatsapp/ingest';
import type { DataClient } from '@/lib/data/types';

const ID = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  vi.clearAllMocks();
  h.conversation = { whatsapp_config_id: null, channel: 'instagram' };
  h.tables = [];
  h.consent = [];
  h.getNumberConfig.mockResolvedValue({ id: 'cfg', status: 'connected', access_token: 'enc', phone_number_id: '1' });
  h.flow.mockResolvedValue({ consumed: false });
  h.lifecycle.mockResolvedValue({ botOwned: false, botReplied: false });
});

describe('the other_channel guard', () => {
  it('refuses a non-WhatsApp row with a translated message and passes WhatsApp rows', () => {
    expect(() => assertWhatsAppConversation({ channel: 'instagram' })).toThrow(NoNumberError);
    try { assertWhatsAppConversation({ channel: 'instagram' }); } catch (error) {
      expect(error).toMatchObject({ reason: 'other_channel', messageKey: 'whatsappNumbers.errors.otherChannel' });
      expect(numberErrorText(error as NoNumberError)).toBe('This conversation is not on WhatsApp.');
    }
    expect(assertWhatsAppConversation({ channel: 'whatsapp' })).toEqual({ channel: 'whatsapp' });
  });

  it('loadConversationSenderConfig (flows, automations) refuses before reading any number', async () => {
    const tables: string[] = [];
    const db = { from: (table: string) => {
      tables.push(table);
      const b = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: { whatsapp_config_id: null, channel: 'instagram' }, error: null }) };
      return b;
    } } as unknown as DataClient;
    await expect(loadConversationSenderConfig(db, ID, ID)).rejects.toMatchObject({ reason: 'other_channel' });
    expect(tables).toEqual(['conversations']);
  });
});

describe('automated WhatsApp sends on an Instagram conversation', () => {
  it('the away message follows the Instagram switch (off here), never the WhatsApp one, and never reads a number', async () => {
    // Stage 2: the WhatsApp switch is on in these settings; the Instagram switch is not.
    expect(await sendAwayMessage({ accountId: ID, userId: ID, conversationId: ID, contactId: ID, messageId: ID },
      new Date('2026-11-02T20:05:00Z'))).toBe('off');
    expect(h.getNumberConfig).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('the order confirmation reports number_unavailable and never dispatches', async () => {
    expect(await sendOrderConfirmation({ accountId: ID, userId: ID, conversationId: ID, contactId: ID,
      order: { catalog_id: '1', items: [], text: null } as never })).toBe('number_unavailable');
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('a WhatsApp conversation still goes through', async () => {
    h.conversation = { whatsapp_config_id: 'cfg', channel: 'whatsapp' };
    h.dispatch.mockResolvedValue({ whatsapp_message_id: 'wamid.ok' });
    expect(await sendAwayMessage({ accountId: ID, userId: ID, conversationId: ID, contactId: ID, messageId: ID },
      new Date('2026-11-02T20:05:00Z'))).toBe('sent');
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });
});

describe('inbound actions on an Instagram conversation', () => {
  const input = (text: string): MessageActionsPayload => ({ kind: 'message', accountId: ID, conversationId: ID, contactId: ID, userId: ID,
    messageId: ID, metaMessageId: 'mid.1', interactiveReplyId: null, contentType: 'text', contentText: text,
    wasContactCreated: true, wasConversationCreated: true, isFirstInboundMessage: true });

  it('runs flows, Instagram automations, lifecycle and Instagram-only webhooks: no booking codes, campaign credit or WhatsApp sends', async () => {
    await processInboundActions(input('BOOK ABC123'));
    expect(h.flow).toHaveBeenCalledTimes(1);
    expect(h.lifecycle).toHaveBeenCalledTimes(1);
    // Stage 1: only Instagram automations, which send through the Instagram window checks.
    expect(h.resume).toHaveBeenCalledWith(expect.objectContaining({ channel: 'instagram' }));
    expect(h.automations.mock.calls.map((call) => [call[0].channel, call[0].triggerType])).toEqual([
      ['instagram', 'first_inbound_message'], ['instagram', 'new_contact_created'],
      ['instagram', 'new_message_received'], ['instagram', 'keyword_match'],
    ]);
    // Stage 2: the webhooks go only to endpoints that opted into Instagram, with Instagram ids.
    expect(h.webhook.mock.calls.map((call) => [call[2], call[4]])).toEqual([
      ['conversation.created', { channel: 'instagram' }], ['message.received', { channel: 'instagram' }],
    ]);
    expect(h.webhook.mock.calls[1][3]).toEqual(expect.objectContaining({ channel: 'instagram', instagram_message_id: 'mid.1' }));
    expect(h.webhook.mock.calls[1][3]).not.toHaveProperty('whatsapp_message_id');
    // The automations' outcome is unknown here (the mock returns nothing), so the AI stays quiet.
    for (const fn of [h.ai, h.explicit, h.booking, h.dispatch, h.send]) expect(fn).not.toHaveBeenCalled();
    // No broadcast-reply or number lookups.
    expect(h.tables).not.toContain('broadcast_recipients');
    expect(h.tables).not.toContain('whatsapp_config');
  });

  it('still applies STOP, with no automated response', async () => {
    await processInboundActions(input('STOP'));
    // Stage 5: on Instagram, STOP unsubscribes from Instagram only.
    expect(h.igConsent).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'opted_out');
    expect(h.flow).not.toHaveBeenCalled();
    expect(h.lifecycle).not.toHaveBeenCalled();
  });

  it('keeps the WhatsApp path for a WhatsApp conversation', async () => {
    h.conversation = { whatsapp_config_id: 'cfg', channel: 'whatsapp' };
    h.explicit.mockResolvedValue({ handled: false });
    h.resume.mockResolvedValue(false);
    h.automations.mockResolvedValue(false);
    h.booking.mockResolvedValue({ handled: false });
    await processInboundActions({ ...input('hello'), wasConversationCreated: false });
    expect(h.webhook).toHaveBeenCalledWith(expect.anything(), ID, 'message.received', expect.anything());
    expect(h.automations).toHaveBeenCalled();
  });
});
