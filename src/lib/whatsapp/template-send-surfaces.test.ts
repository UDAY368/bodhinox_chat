/**
 * The new template kinds at the server-side send boundaries: the inbox
 * and public API send core, the public broadcast endpoint and the
 * campaign worker.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataClient } from '@/lib/data/types';
import type { MessageTemplate } from '@/types';

const sent = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[] }));
vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendTemplateMessage: vi.fn(async (args: Record<string, unknown>) => {
    sent.calls.push(args);
    return { messageId: 'wamid.1' };
  }),
}));
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => v,
  encrypt: (v: string) => v,
  isLegacyFormat: () => false,
}));
vi.mock('@/lib/storage/server', () => ({
  providerMediaUrl: vi.fn(async (_account: string, url: string) => `${url}?signed`),
}));
vi.mock('@/lib/flows/admin-client', () => ({
  databaseAdmin: () => ({
    from: () => ({ update: () => ({ eq: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }) }) }),
  }),
}));
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({}) }));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: () => {
    throw new Error('nothing should be persisted');
  },
}));

import { SendMessageError, sendMessageToConversation, validateSendMessageParams } from './send-message';
import { createBroadcast, deliverBroadcast, type BroadcastPlan } from './broadcast-core';

function tpl(over: Partial<MessageTemplate>): MessageTemplate {
  return {
    id: 'tpl-1', user_id: 'u-1', name: 'kinds', category: 'Marketing', language: 'en',
    body_text: 'Hi {{1}}', status: 'APPROVED', created_at: '2026-01-01T00:00:00Z', ...over,
  };
}
const AUTH = tpl({ category: 'Authentication', template_kind: 'authentication', body_text: '' });
const LOCATION = tpl({ header_type: 'location' });
const CAROUSEL = tpl({
  template_kind: 'carousel',
  cards: [
    { header_type: 'image', header_media_url: '/api/media/object?bucket=b&key=a.png', body_text: 'A {{1}}', buttons: [{ type: 'QUICK_REPLY', text: 'More' }] },
    { header_type: 'image', header_media_url: 'https://cdn.test/b.png', body_text: 'B', buttons: [{ type: 'QUICK_REPLY', text: 'More' }] },
  ],
});

/** Chainable, awaitable fake covering the tables the send paths read. */
function fakeDb(templateRows: unknown[], writes: { table: string; row: unknown }[] = []): DataClient {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder, eq: () => builder, neq: () => builder, in: () => builder,
        insert: (row: unknown) => { writes.push({ table, row }); return builder; },
        update: (row: unknown) => { writes.push({ table, row }); return builder; },
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => {
          if (table === 'conversations') return { data: { id: 'cv-1', contact: { id: 'ct-1', phone: '+15551234567' } }, error: null };
          if (table === 'whatsapp_config') return { data: { id: 'cfg-1', phone_number_id: 'pn-1', access_token: 'token' }, error: null };
          if (table === 'messages') return { data: { id: 'msg-1' }, error: null };
          return { data: null, error: null };
        },
        then: (resolve: (r: { data: unknown; error: null }) => unknown) =>
          resolve({ data: table === 'message_templates' ? templateRows : [], error: null }),
      };
      return builder;
    },
  } as unknown as DataClient;
}

beforeEach(() => {
  sent.calls = [];
});

describe('inbox / API send core', () => {
  it('rejects malformed structured values before any lookup', () => {
    expect(() =>
      validateSendMessageParams({ messageType: 'template', templateName: 'kinds', templateMessageParams: { location: { latitude: 120, longitude: 0 } } }),
    ).toThrow(SendMessageError);
    expect(() =>
      validateSendMessageParams({ messageType: 'template', templateName: 'kinds', templateMessageParams: { authCode: '1'.repeat(16) } }),
    ).toThrow(SendMessageError);
    expect(() =>
      validateSendMessageParams({ messageType: 'template', templateName: 'kinds', templateMessageParams: { body: ['Ana'] } }),
    ).not.toThrow();
  });

  it('answers 400 for a location template without a location, before pausing the bot or calling Meta', async () => {
    const writes: { table: string; row: unknown }[] = [];
    const err = await sendMessageToConversation(fakeDb([LOCATION], writes), 'acct-1', {
      conversationId: 'cv-1', messageType: 'template', templateName: 'kinds', templateMessageParams: { body: ['Ana'] },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(SendMessageError);
    expect(err.status).toBe(400);
    expect(writes).toEqual([]);
    expect(sent.calls).toEqual([]);
  });

  it('sends an authentication template with the agent code and never stores the code', async () => {
    const writes: { table: string; row: unknown }[] = [];
    await sendMessageToConversation(fakeDb([AUTH], writes), 'acct-1', {
      conversationId: 'cv-1', messageType: 'template', templateName: 'kinds', templateMessageParams: { authCode: '482913' },
    });
    expect(sent.calls[0].messageParams).toMatchObject({ authCode: '482913' });
    expect(JSON.stringify(writes)).not.toContain('482913');
  });

  it('passes the location through and signs carousel card media', async () => {
    await sendMessageToConversation(fakeDb([LOCATION]), 'acct-1', {
      conversationId: 'cv-1', messageType: 'template', templateName: 'kinds',
      templateMessageParams: { body: ['Ana'], location: { latitude: '1.5', longitude: 2 } },
    });
    expect(sent.calls[0].messageParams).toMatchObject({ location: { latitude: 1.5, longitude: 2 } });

    await sendMessageToConversation(fakeDb([CAROUSEL]), 'acct-1', {
      conversationId: 'cv-1', messageType: 'template', templateName: 'kinds',
      templateMessageParams: { body: ['Ana'], cards: [{ body: ['x'] }] },
    });
    expect((sent.calls[1].messageParams as { cards: unknown[] }).cards).toEqual([
      { body: ['x'], headerMediaUrl: '/api/media/object?bucket=b&key=a.png?signed' },
      { headerMediaUrl: 'https://cdn.test/b.png?signed' },
    ]);
  });
});

describe('public broadcast endpoint', () => {
  it('refuses authentication templates with 422 before persisting anything', async () => {
    await expect(
      createBroadcast(fakeDb([AUTH]), 'acct-1', 'u-1', { templateName: 'kinds', recipients: [{ to: '+14155550123' }] }),
    ).rejects.toMatchObject({ code: 'template_kind_not_allowed', status: 422 });
  });

  it('refuses a location template it could never fill', async () => {
    await expect(
      createBroadcast(fakeDb([LOCATION]), 'acct-1', 'u-1', { templateName: 'kinds', recipients: [{ to: '+14155550123' }] }),
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });
});

describe('campaign worker', () => {
  function plan(templateRow: MessageTemplate, params: string[], sendExtras = {}): BroadcastPlan {
    return {
      broadcastId: 'b-1', templateName: 'kinds', templateLanguage: 'en', phoneNumberId: 'pn-1', accessToken: 't',
      templateRow, planned: [{ recipientRowId: 'r-1', phone: '+15551234567', params }], rejected: 0, sendExtras,
    } as BroadcastPlan;
  }

  it('sends the campaign extras with every recipient', async () => {
    const extras = { location: { latitude: 1, longitude: 2 } };
    await deliverBroadcast(fakeDb([]), plan(LOCATION, ['Ana'], extras));
    expect(sent.calls[0]).toMatchObject({ params: ['Ana'], messageParams: extras });
  });

  it('splits frozen carousel values into body and card values', async () => {
    await deliverBroadcast(fakeDb([]), plan(CAROUSEL, ['Ana', 'x']));
    expect(sent.calls[0]).toMatchObject({ params: ['Ana'], messageParams: { cards: [{ body: ['x'] }, {}] } });
  });

  it('leaves a standard recipient exactly as before', async () => {
    await deliverBroadcast(fakeDb([]), plan(tpl({}), ['Ana']));
    expect(sent.calls[0].params).toEqual(['Ana']);
    expect(sent.calls[0]).not.toHaveProperty('messageParams');
  });
});
