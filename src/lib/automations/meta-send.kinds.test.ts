import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Automations and flows share engineSendTemplate, so this covers both.
vi.mock('@/lib/whatsapp/bot-pause', () => ({ assertBotRepliesEnabled: async () => {} }));
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => v }));
vi.mock('@/lib/storage/server', () => ({ providerMediaUrl: async (_a: string, url: string) => url }));

const state = vi.hoisted(() => ({ templateRows: [] as unknown[], inserted: [] as unknown[] }));
vi.mock('./admin-client', () => ({
  databaseAdmin: () => ({
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        update: () => builder,
        insert: (row: unknown) => {
          state.inserted.push(row);
          return builder;
        },
        maybeSingle: async () =>
          table === 'contacts'
            ? { data: { id: 'ct-1', phone: '15551234567', wa_user_id: null }, error: null }
            : { data: table === 'conversations' ? { id: 'cv-1' } : null, error: null },
        single: async () =>
          table === 'whatsapp_config'
            ? { data: { phone_number_id: 'pn-1', access_token: 'token' }, error: null }
            : { data: null, error: null },
        then: (resolve: (r: { data: unknown; error: null }) => unknown) =>
          resolve({ data: table === 'message_templates' ? state.templateRows : null, error: null }),
      };
      return builder;
    },
  }),
}));

import { engineSendTemplate } from './meta-send';
import { TemplateSendRefusedError } from '@/lib/whatsapp/template-send-params';

const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ messages: [{ id: 'wamid.k' }] }) }));
const ROW = {
  id: 'tpl-1', user_id: 'u-1', name: 'kinds', category: 'Marketing', language: 'en_US',
  body_text: 'Hi {{1}}', created_at: '2026-01-01T00:00:00Z',
};
const ARGS = {
  accountId: 'acct-1', userId: 'u-1', conversationId: 'cv-1', contactId: 'ct-1',
  templateName: 'kinds', language: 'en_US', params: ['Ana'],
};

beforeEach(() => {
  state.templateRows = [];
  state.inserted = [];
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('engineSendTemplate with the new kinds', () => {
  it('refuses an authentication template before calling Meta', async () => {
    state.templateRows = [{ ...ROW, category: 'Authentication', template_kind: 'authentication', body_text: '' }];
    await expect(engineSendTemplate({ ...ARGS, messageParams: { authCode: '123456' } })).rejects.toBeInstanceOf(TemplateSendRefusedError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.inserted).toEqual([]);
  });

  it('refuses a location-header template for an automation (body values only) before calling Meta', async () => {
    state.templateRows = [{ ...ROW, header_type: 'location' }];
    await expect(engineSendTemplate({ ...ARGS, params: ['Ana'], bodyValuesOnly: true })).rejects.toBeInstanceOf(TemplateSendRefusedError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.inserted).toEqual([]);
  });

  it('sends a location header from the step values', async () => {
    state.templateRows = [{ ...ROW, header_type: 'location' }];
    await engineSendTemplate({ ...ARGS, messageParams: { body: ['Ana'], location: { latitude: 1, longitude: 2, name: 'HQ' } } });
    const sent = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(sent.template.components[0]).toEqual({
      type: 'header',
      parameters: [{ type: 'location', location: { latitude: 1, longitude: 2, name: 'HQ' } }],
    });
  });
});
