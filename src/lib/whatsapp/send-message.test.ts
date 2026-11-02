import { describe, expect, it, vi } from 'vitest';
import type { DataClient } from '@/lib/data/types';

import {
  sendMessageToConversation,
  SendMessageError,
  type SendMessageParams,
} from './send-message';

// A db that explodes if touched — these tests cover the param
// validation that MUST short-circuit before any query runs.
function noDb(): DataClient {
  return {
    from() {
      throw new Error('db should not be queried for invalid params');
    },
  } as unknown as DataClient;
}

async function expectSendError(
  params: SendMessageParams,
  status: number,
  messageMatch?: RegExp
) {
  await expect(
    sendMessageToConversation(noDb(), 'acct-1', params)
  ).rejects.toBeInstanceOf(SendMessageError);
  await sendMessageToConversation(noDb(), 'acct-1', params).catch(
    (e: SendMessageError) => {
      expect(e.status).toBe(status);
      if (messageMatch) expect(e.message).toMatch(messageMatch);
    }
  );
}

describe('sendMessageToConversation — param validation (pre-DB)', () => {
  const base = { conversationId: 'cv-1' };

  it('requires conversation_id and message_type', async () => {
    await expectSendError({ conversationId: '', messageType: 'text' }, 400);
    await expectSendError({ conversationId: 'cv-1', messageType: '' }, 400);
  });

  it('rejects an unsupported message_type', async () => {
    await expectSendError(
      { ...base, messageType: 'carrier-pigeon' },
      400,
      /Unsupported message_type/
    );
  });

  it('requires content_text for text messages', async () => {
    await expectSendError(
      { ...base, messageType: 'text' },
      400,
      /content_text is required/
    );
  });

  it('requires template_name for template messages', async () => {
    await expectSendError(
      { ...base, messageType: 'template' },
      400,
      /template_name is required/
    );
  });

  it('requires media_url for media kinds', async () => {
    for (const kind of ['image', 'video', 'document', 'audio']) {
      await expectSendError(
        { ...base, messageType: kind },
        400,
        /media_url is required/
      );
    }
  });

  it('rejects an over-long media caption (non-audio)', async () => {
    await expectSendError(
      {
        ...base,
        messageType: 'image',
        mediaUrl: 'https://x/y.jpg',
        contentText: 'a'.repeat(1025),
      },
      400,
      /1024-character limit/
    );
  });

  it('requires a valid interactive payload for interactive messages', async () => {
    // Missing payload entirely.
    await expectSendError(
      { ...base, messageType: 'interactive' },
      400,
      /payload is required/
    );
    // Too many buttons.
    await expectSendError(
      {
        ...base,
        messageType: 'interactive',
        interactivePayload: {
          kind: 'buttons',
          body: 'Pick one',
          buttons: [
            { id: 'a', title: 'A' },
            { id: 'b', title: 'B' },
            { id: 'c', title: 'C' },
            { id: 'd', title: 'D' },
          ],
        },
      },
      400,
      /at most 3 buttons/
    );
    // Over-long button title.
    await expectSendError(
      {
        ...base,
        messageType: 'interactive',
        interactivePayload: {
          kind: 'buttons',
          body: 'Pick one',
          buttons: [{ id: 'a', title: 'x'.repeat(21) }],
        },
      },
      400,
      /20-character limit/
    );
  });

  it('allows a long "caption" on audio (audio carries none) — so it reaches the DB', async () => {
    // Audio is exempt from the caption cap, so validation passes and we
    // proceed to the conversation lookup — proven by the stub throwing.
    const spy = vi.fn(() => {
      throw new Error('reached DB');
    });
    const db = { from: spy } as unknown as DataClient;
    await expect(
      sendMessageToConversation(db, 'acct-1', {
        ...base,
        messageType: 'audio',
        mediaUrl: 'https://x/y.ogg',
        contentText: 'a'.repeat(2000),
      })
    ).rejects.toThrow('reached DB');
    expect(spy).toHaveBeenCalledWith('conversations');
  });
});

describe('SendMessageError', () => {
  it('carries a machine code and an HTTP status', () => {
    const e = new SendMessageError('meta_error', 'boom', 502);
    expect(e.code).toBe('meta_error');
    expect(e.status).toBe(502);
    expect(e).toBeInstanceOf(Error);
  });
});

// ============================================================
// Full send path — what actually lands in `messages` (issue #483).
// ============================================================

const sendTemplateMessage = vi.fn(async () => ({ messageId: 'wamid.1' }));

vi.mock('@/lib/storage/server', () => ({ providerMediaUrl: vi.fn(async (_account: string, url: string) => `signed:${url}`) }));

describe('sendMessageToConversation — enriched interactive persistence', () => {
  it('preserves URL action and original media in history while sending a signed native header', async () => {
    const captured: CapturedWrites = {};
    const payload = { kind: 'buttons' as const, body: 'Visit', media: { type: 'image' as const, url: 'https://cdn.test/image.jpg' }, buttons: [{ id: 'link', title: 'Website', action: { type: 'url' as const, url: 'https://example.com' } }] };
    await sendMessageToConversation(sendPathDb([], captured), 'acct-1', { conversationId: 'cv-1', messageType: 'interactive', interactivePayload: payload });
    const { sendInteractiveButtons } = await import('./meta-api');
    expect(sendInteractiveButtons).toHaveBeenLastCalledWith(expect.objectContaining({ media: { type: 'image', url: 'signed:https://cdn.test/image.jpg' }, buttons: payload.buttons }));
    expect(captured.message?.interactive_payload).toEqual(payload);
  });
});

// Stub only the senders — the module also exports INTERACTIVE_LIMITS,
// which `interactive.ts` needs for the payload validation covered above.
vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendTextMessage: vi.fn(async () => ({ messageId: 'wamid.text' })),
  sendTemplateMessage: (...args: unknown[]) =>
    (sendTemplateMessage as unknown as (...a: unknown[]) => unknown)(...args),
  sendMediaMessage: vi.fn(async () => ({ messageId: 'wamid.media' })),
  sendInteractiveButtons: vi.fn(async () => ({ messageId: 'wamid.btn' })),
  sendInteractiveList: vi.fn(async () => ({ messageId: 'wamid.list' })),
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => v,
  encrypt: (v: string) => v,
  isLegacyFormat: () => false,
}));

// Records the best-effort "pause active flow run" write so tests can assert its scope.
const flowRunPause = vi.hoisted(() => ({ calls: [] as Array<{ table: string; patch: Record<string, unknown>; filters: Record<string, unknown> }> }));
vi.mock('@/lib/flows/admin-client', () => ({
  databaseAdmin: () => ({
    from: (table: string) => ({
      update: (patch: Record<string, unknown>) => {
        const call = { table, patch, filters: {} as Record<string, unknown> };
        flowRunPause.calls.push(call);
        const builder = {
          eq: (key: string, value: unknown) => { call.filters[key] = value; return builder; },
          then: (resolve: (r: { error: null }) => unknown) => Promise.resolve({ error: null }).then(resolve),
        };
        return builder;
      },
    }),
  }),
}));

interface CapturedWrites {
  message?: Record<string, unknown>;
  conversation?: Record<string, unknown>;
}

/**
 * Supabase fake covering the tables the send path touches. Each table
 * gets a builder that is both chainable and awaitable, so the same
 * object serves `.single()` lookups and the bare `select().eq().eq()`
 * the template resolver uses.
 */
function sendPathDb(
  templateRows: unknown[],
  captured: CapturedWrites,
  contact: Record<string, unknown> = { id: 'ct-1', phone: '+15551234567' },
  numbers: { configs?: Record<string, unknown>[]; conversationConfigId?: string | null } = {}
): DataClient {
  const conversation = {
    id: 'cv-1',
    contact,
    whatsapp_config_id: numbers.conversationConfigId ?? null,
  };
  const configs = numbers.configs ?? [{
    id: 'cfg-1',
    phone_number_id: 'pn-1',
    access_token: 'token',
  }];

  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (field: string, value: unknown) => {
          filters[field] = value;
          return builder;
        },
        insert: (row: Record<string, unknown>) => {
          if (table === 'messages') captured.message = row;
          return builder;
        },
        update: (row: Record<string, unknown>) => {
          if (table === 'conversations') captured.conversation = row;
          return builder;
        },
        maybeSingle: async () => {
          if (table === 'whatsapp_config') {
            return { data: configs.find((c) => c.id === filters.id) ?? null, error: null };
          }
          return { data: null, error: null };
        },
        single: async () => {
          if (table === 'conversations') {
            return { data: conversation, error: null };
          }
          if (table === 'messages') {
            return { data: { id: 'msg-1' }, error: null };
          }
          return { data: null, error: null };
        },
        // Bare-await result: templates and the workspace's numbers.
        then: (resolve: (r: { data: unknown[]; error: null }) => unknown) =>
          resolve({
            data: table === 'message_templates' ? templateRows : table === 'whatsapp_config' ? configs : [],
            error: null,
          }),
      };
      return builder;
    },
  } as unknown as DataClient;
}

const TEMPLATE_ROW = {
  id: 'tpl-1',
  user_id: 'u-1',
  name: 'order_update',
  category: 'Utility',
  language: 'en',
  body_text: 'Your order {{1}} ships on {{2}}',
  created_at: '2026-01-01T00:00:00Z',
};

describe('sendMessageToConversation — template persistence (#483)', () => {
  it('stores the substituted body when the caller sends no text', async () => {
    const captured: CapturedWrites = {};
    const result = await sendMessageToConversation(
      sendPathDb([TEMPLATE_ROW], captured),
      'acct-1',
      {
        conversationId: 'cv-1',
        messageType: 'template',
        templateName: 'order_update',
        templateParams: ['A123', 'Friday'],
      }
    );

    expect(result.whatsappMessageId).toBe('wamid.1');
    // Was NULL before the fix — the Inbox rendered an empty bubble.
    expect(captured.message?.content_text).toBe(
      'Your order A123 ships on Friday'
    );
    expect(captured.message?.template_name).toBe('order_update');
    // …and the conversation-list preview reads the body, not '[template]'.
    expect(captured.conversation?.last_message_text).toBe(
      'Your order A123 ships on Friday'
    );
  });

  it('reads body values out of the structured params shape too', async () => {
    const captured: CapturedWrites = {};
    await sendMessageToConversation(sendPathDb([TEMPLATE_ROW], captured), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'template',
      templateName: 'order_update',
      templateMessageParams: { body: ['B456', 'Monday'] },
    });
    expect(captured.message?.content_text).toBe(
      'Your order B456 ships on Monday'
    );
  });

  it("does not override the composer's pre-rendered text", async () => {
    const captured: CapturedWrites = {};
    await sendMessageToConversation(sendPathDb([TEMPLATE_ROW], captured), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'template',
      templateName: 'order_update',
      templateParams: ['A123', 'Friday'],
      contentText: 'rendered by the composer',
    });
    expect(captured.message?.content_text).toBe('rendered by the composer');
  });

  it("sends the local row's language when the caller names none", async () => {
    sendTemplateMessage.mockClear();
    const captured: CapturedWrites = {};
    await sendMessageToConversation(sendPathDb([TEMPLATE_ROW], captured), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'template',
      templateName: 'order_update',
      templateParams: ['A123', 'Friday'],
    });
    // Previously pinned to 'en_US', which matched no row and made Meta
    // reject the send as a missing translation.
    expect(
      (sendTemplateMessage.mock.calls[0] as unknown as [{ language: string }])[0]
        .language
    ).toBe('en');
  });

  it('leaves content_text null when the account has no local template row', async () => {
    const captured: CapturedWrites = {};
    await sendMessageToConversation(sendPathDb([], captured), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'template',
      templateName: 'never_synced',
      templateParams: ['A123'],
    });
    // Nothing to render from — the bubble falls back to the template
    // name rather than inventing a body.
    expect(captured.message?.content_text).toBeNull();
    expect(captured.conversation?.last_message_text).toBe('[template]');
  });
});

// ============================================================
// Business-scoped user IDs (issue #519)
//
// Meta withholds the phone number for a customer who has adopted a
// WhatsApp username, so their contact row carries only `wa_user_id`.
// The send path used to reject those outright with "Contact phone
// number not found" — the business could receive their messages but
// never answer them.
// ============================================================

const BSUID = 'US.13491208655302741918';

describe('sendMessageToConversation — BSUID recipients (#519)', () => {
  it('sends to the BSUID when the contact has no phone number', async () => {
    const captured: CapturedWrites = {};
    const { sendTextMessage } = await import('@/lib/whatsapp/meta-api');
    vi.mocked(sendTextMessage).mockClear();

    await sendMessageToConversation(
      sendPathDb([], captured, { id: 'ct-1', phone: '', wa_user_id: BSUID }),
      'acct-1',
      { conversationId: 'cv-1', messageType: 'text', contentText: 'hi' }
    );

    expect(vi.mocked(sendTextMessage)).toHaveBeenCalledWith(
      expect.objectContaining({ to: BSUID })
    );
  });

  it('still prefers the phone number when the contact has both', async () => {
    const captured: CapturedWrites = {};
    const { sendTextMessage } = await import('@/lib/whatsapp/meta-api');
    vi.mocked(sendTextMessage).mockClear();

    await sendMessageToConversation(
      sendPathDb([], captured, {
        id: 'ct-1',
        phone: '+15551234567',
        wa_user_id: BSUID,
      }),
      'acct-1',
      { conversationId: 'cv-1', messageType: 'text', contentText: 'hi' }
    );

    // Only the phone path supports the trunk-prefix variant retry, so
    // it wins whenever we have a usable number.
    expect(vi.mocked(sendTextMessage)).toHaveBeenCalledWith(
      expect.objectContaining({ to: '15551234567' })
    );
  });

  it('falls back to the BSUID when the stored phone is unusable', async () => {
    const captured: CapturedWrites = {};
    const { sendTextMessage } = await import('@/lib/whatsapp/meta-api');
    vi.mocked(sendTextMessage).mockClear();

    await sendMessageToConversation(
      sendPathDb([], captured, {
        id: 'ct-1',
        phone: 'not-a-number',
        wa_user_id: BSUID,
      }),
      'acct-1',
      { conversationId: 'cv-1', messageType: 'text', contentText: 'hi' }
    );

    expect(vi.mocked(sendTextMessage)).toHaveBeenCalledWith(
      expect.objectContaining({ to: BSUID })
    );
  });

  it('400s when the contact has neither a usable phone nor a BSUID', async () => {
    const captured: CapturedWrites = {};
    await expect(
      sendMessageToConversation(
        sendPathDb([], captured, { id: 'ct-1', phone: '' }),
        'acct-1',
        { conversationId: 'cv-1', messageType: 'text', contentText: 'hi' }
      )
    ).rejects.toThrow(/no phone number or WhatsApp user ID/);
  });

  it('ignores a wa_user_id that is not BSUID-shaped', async () => {
    const captured: CapturedWrites = {};
    await expect(
      sendMessageToConversation(
        sendPathDb([], captured, {
          id: 'ct-1',
          phone: '',
          wa_user_id: 'garbage',
        }),
        'acct-1',
        { conversationId: 'cv-1', messageType: 'text', contentText: 'hi' }
      )
    ).rejects.toThrow(/no phone number or WhatsApp user ID/);
  });
});

describe('sendMessageToConversation — agent reply pauses only the replied conversation run', () => {
  it('pauses the active run on the replied conversation, not every run for the contact', async () => {
    flowRunPause.calls.length = 0;
    await sendMessageToConversation(sendPathDb([], {}), 'acct-1', { conversationId: 'cv-1', messageType: 'text', contentText: 'hi' });
    expect(flowRunPause.calls).toEqual([{
      table: 'flow_runs',
      patch: expect.objectContaining({ status: 'paused_by_agent', end_reason: 'agent_replied' }),
      filters: { account_id: 'acct-1', contact_id: 'ct-1', conversation_id: 'cv-1', status: 'active' },
    }]);
  });
});

describe('sendMessageToConversation — two numbers in one workspace', () => {
  const NUMBERS = [
    { id: '11111111-1111-4111-8111-111111111111', phone_number_id: 'pn-default', access_token: 'token', waba_id: 'waba-a', is_default: true, created_at: '2026-01-01T00:00:00Z' },
    { id: '22222222-2222-4222-8222-222222222222', phone_number_id: 'pn-second', access_token: 'token', waba_id: 'waba-b', is_default: false, created_at: '2026-02-01T00:00:00Z' },
  ];

  it("replies from the conversation's number", async () => {
    const { sendTextMessage } = await import('@/lib/whatsapp/meta-api');
    vi.mocked(sendTextMessage).mockClear();
    await sendMessageToConversation(
      sendPathDb([], {}, undefined, { configs: NUMBERS, conversationConfigId: NUMBERS[1].id }),
      'acct-1',
      { conversationId: 'cv-1', messageType: 'text', contentText: 'hi' }
    );
    expect(vi.mocked(sendTextMessage)).toHaveBeenCalledWith(expect.objectContaining({ phoneNumberId: 'pn-second' }));
  });

  it('falls back to the default number for a legacy conversation without one', async () => {
    const { sendTextMessage } = await import('@/lib/whatsapp/meta-api');
    vi.mocked(sendTextMessage).mockClear();
    await sendMessageToConversation(
      sendPathDb([], {}, undefined, { configs: [NUMBERS[1], NUMBERS[0]], conversationConfigId: null }),
      'acct-1',
      { conversationId: 'cv-1', messageType: 'text', contentText: 'hi' }
    );
    expect(vi.mocked(sendTextMessage)).toHaveBeenCalledWith(expect.objectContaining({ phoneNumberId: 'pn-default' }));
  });

  it("refuses a template from another number's WABA before calling Meta", async () => {
    vi.mocked(sendTemplateMessage).mockClear();
    const error = await sendMessageToConversation(
      sendPathDb([{ ...TEMPLATE_ROW, waba_id: 'waba-a' }], {}, undefined, { configs: NUMBERS, conversationConfigId: NUMBERS[1].id }),
      'acct-1',
      { conversationId: 'cv-1', messageType: 'template', templateName: 'order_update', templateParams: ['A', 'B'] }
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SendMessageError);
    expect((error as SendMessageError).code).toBe('template_wrong_number');
    expect((error as SendMessageError).status).toBe(422);
    expect(vi.mocked(sendTemplateMessage)).not.toHaveBeenCalled();
  });

  it('sends a template from its own WABA', async () => {
    vi.mocked(sendTemplateMessage).mockClear();
    await sendMessageToConversation(
      sendPathDb([{ ...TEMPLATE_ROW, waba_id: 'waba-b' }], {}, undefined, { configs: NUMBERS, conversationConfigId: NUMBERS[1].id }),
      'acct-1',
      { conversationId: 'cv-1', messageType: 'template', templateName: 'order_update', templateParams: ['A', 'B'] }
    );
    expect(vi.mocked(sendTemplateMessage)).toHaveBeenCalledWith(expect.objectContaining({ phoneNumberId: 'pn-second' }));
  });

  it('asks which number to use when several exist and none is the default', async () => {
    const error = await sendMessageToConversation(
      sendPathDb([], {}, undefined, { configs: NUMBERS.map((n) => ({ ...n, is_default: false })), conversationConfigId: null }),
      'acct-1',
      { conversationId: 'cv-1', messageType: 'text', contentText: 'hi' }
    ).catch((e: unknown) => e);
    expect((error as SendMessageError).code).toBe('whatsapp_number_unavailable');
    expect((error as SendMessageError).status).toBe(400);
  });
});
