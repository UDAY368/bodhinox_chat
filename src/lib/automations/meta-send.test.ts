import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/whatsapp/bot-pause', () => ({
  assertBotRepliesEnabled: async () => {},
}));

const state = vi.hoisted(() => ({
  templateRows: [] as unknown[],
  insertedMessage: null as Record<string, unknown> | null,
  numbers: [{ id: 'cfg-1', phone_number_id: 'pn-1', access_token: 'token' }] as Record<string, unknown>[],
  conversationNumber: null as string | null,
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => v,
}));

vi.mock('./admin-client', () => ({
  databaseAdmin: () => ({
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (field: string, value: unknown) => {
          filters[field] = value;
          return builder;
        },
        update: () => builder,
        insert: (row: Record<string, unknown>) => {
          if (table === 'messages') state.insertedMessage = row;
          return builder;
        },
        maybeSingle: async () => {
          if (table === 'contacts') {
            return {
              data: { id: 'ct-1', phone: '15551234567', wa_user_id: null },
              error: null,
            };
          }
          if (table === 'conversations')
            return { data: { id: 'cv-1', whatsapp_config_id: state.conversationNumber }, error: null };
          if (table === 'whatsapp_config')
            return { data: state.numbers.find((n) => n.id === filters.id) ?? null, error: null };
          return { data: null, error: null };
        },
        single: async () => {
          if (table === 'whatsapp_config') {
            return {
              data: { phone_number_id: 'pn-1', access_token: 'token' },
              error: null,
            };
          }
          return { data: null, error: null };
        },
        then: (resolve: (r: { data: unknown; error: null }) => unknown) =>
          resolve({
            data: table === 'message_templates' ? state.templateRows : table === 'whatsapp_config' ? state.numbers : null,
            error: null,
          }),
      };
      return builder;
    },
  }),
}));

import { engineSendTemplate } from './meta-send';
import { TemplateSendRefusedError } from '@/lib/whatsapp/template-send-params';

type FetchResult = { ok: boolean; json: () => Promise<unknown> };

const fetchMock = vi.fn<
  (url: string, init?: RequestInit) => Promise<FetchResult>
>(async () => ({
  ok: true,
  json: async () => ({ messages: [{ id: 'wamid.auto' }] }),
}));

function sentTemplate(): Record<string, unknown> {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const init = fetchMock.mock.calls[0][1];
  return JSON.parse(String(init?.body)).template;
}

const BASE_ROW = {
  id: 'tpl-1',
  user_id: 'u-1',
  name: 'order_update',
  category: 'Utility',
  language: 'en_US',
  body_text: 'Your order {{1}} ships on {{2}}',
  created_at: '2026-01-01T00:00:00Z',
};

const SEND_ARGS = {
  accountId: 'acct-1',
  userId: 'u-1',
  conversationId: 'cv-1',
  contactId: 'ct-1',
  templateName: 'order_update',
  language: 'en_US',
  params: ['A123', 'Friday'],
};

const BODY_COMPONENT = {
  type: 'body',
  parameters: [
    { type: 'text', text: 'A123' },
    { type: 'text', text: 'Friday' },
  ],
};

const SINGLE_NUMBER = [{ id: 'cfg-1', phone_number_id: 'pn-1', access_token: 'token' }];

beforeEach(() => {
  state.templateRows = [];
  state.insertedMessage = null;
  state.numbers = SINGLE_NUMBER;
  state.conversationNumber = null;
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('engineSendTemplate — header component', () => {
  it.each(['image', 'video', 'document'] as const)(
    'sends the stored %s header as a header parameter',
    async (headerType) => {
      state.templateRows = [
        {
          ...BASE_ROW,
          header_type: headerType,
          header_media_url: `https://cdn.example.com/header.${headerType}`,
        },
      ];

      await engineSendTemplate(SEND_ARGS);

      expect(sentTemplate()).toEqual({
        name: 'order_update',
        language: { code: 'en_US' },
        components: [
          {
            type: 'header',
            parameters: [
              {
                type: headerType,
                [headerType]: {
                  link: `https://cdn.example.com/header.${headerType}`,
                },
              },
            ],
          },
          BODY_COMPONENT,
        ],
      });
      expect(state.insertedMessage?.media_url).toBe(
        `https://cdn.example.com/header.${headerType}`
      );
    }
  );

  it('fails before calling Meta when a text header variable has no value', async () => {
    state.templateRows = [
      { ...BASE_ROW, header_type: 'text', header_content: 'Hi {{1}}' },
    ];

    await expect(engineSendTemplate(SEND_ARGS)).rejects.toThrow(
      /Header text variable \{\{1\}\} requires a value/
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends no header component for a static text header', async () => {
    state.templateRows = [
      { ...BASE_ROW, header_type: 'text', header_content: 'Order update' },
    ];

    await engineSendTemplate(SEND_ARGS);

    expect(sentTemplate().components).toEqual([BODY_COMPONENT]);
  });
});

describe('engineSendTemplate — templates without a header keep their payload', () => {
  it('sends only the body component for a header-less template', async () => {
    state.templateRows = [BASE_ROW];

    await engineSendTemplate(SEND_ARGS);

    expect(sentTemplate()).toEqual({
      name: 'order_update',
      language: { code: 'en_US' },
      components: [BODY_COMPONENT],
    });
  });

  it('sends no components for a fully static template', async () => {
    state.templateRows = [{ ...BASE_ROW, body_text: 'Thanks for your order' }];

    await engineSendTemplate({ ...SEND_ARGS, params: [] });

    expect(sentTemplate()).toEqual({
      name: 'order_update',
      language: { code: 'en_US' },
    });
  });

  it('falls back to the body-only payload when the account has no local row', async () => {
    await engineSendTemplate(SEND_ARGS);

    expect(sentTemplate()).toEqual({
      name: 'order_update',
      language: { code: 'en_US' },
      components: [BODY_COMPONENT],
    });
  });
});

describe('engineSendTemplate — two numbers in one workspace', () => {
  const A = '11111111-1111-4111-8111-11111111111a';
  const B = '22222222-2222-4222-8222-22222222222b';
  const NUMBERS = [
    { id: A, phone_number_id: 'pn-default', access_token: 'token', waba_id: 'waba-a', is_default: true, created_at: '2026-01-01T00:00:00Z' },
    { id: B, phone_number_id: 'pn-second', access_token: 'token', waba_id: 'waba-b', is_default: false, created_at: '2026-02-01T00:00:00Z' },
  ];

  it("sends from the conversation's number", async () => {
    state.numbers = NUMBERS;
    state.conversationNumber = B;
    state.templateRows = [{ ...BASE_ROW, waba_id: 'waba-b' }];
    await engineSendTemplate(SEND_ARGS);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/pn-second/');
  });

  it('uses the default number for a legacy conversation', async () => {
    state.numbers = NUMBERS;
    state.conversationNumber = null;
    await engineSendTemplate(SEND_ARGS);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/pn-default/');
  });

  it("refuses a template from another number's WABA without calling Meta", async () => {
    state.numbers = NUMBERS;
    state.conversationNumber = B;
    state.templateRows = [{ ...BASE_ROW, waba_id: 'waba-a' }];
    await expect(engineSendTemplate(SEND_ARGS)).rejects.toThrow(TemplateSendRefusedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
