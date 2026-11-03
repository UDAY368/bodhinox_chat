import { beforeEach, describe, expect, it, vi } from 'vitest';

// serviceMessage (appointment confirmations and reminders) skips only the
// agent-takeover pause; a suspended workspace still refuses the send.
const gate = vi.hoisted(() => ({ paused: false, suspended: false, pauseChecks: 0, suspensionChecks: 0 }));

vi.mock('@/lib/billing/suspension', () => ({
  assertOutboundAllowed: async () => {
    gate.suspensionChecks++;
    if (gate.suspended) throw new Error('workspace_suspended');
  },
}));
vi.mock('@/lib/whatsapp/bot-pause', () => ({
  assertBotRepliesEnabled: async () => {
    gate.pauseChecks++;
    if (gate.suspended) throw new Error('workspace_suspended');
    if (gate.paused) throw new Error('Bot replies are paused by an agent; resume them in the inbox');
  },
}));
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => v }));
vi.mock('./admin-client', () => ({
  databaseAdmin: () => ({
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        update: () => builder,
        insert: () => builder,
        maybeSingle: async () => {
          if (table === 'contacts') return { data: { id: 'ct-1', phone: '15551234567', wa_user_id: null }, error: null };
          if (table === 'conversations') return { data: { id: 'cv-1', whatsapp_config_id: null }, error: null };
          return { data: null, error: null };
        },
        then: (resolve: (r: { data: unknown; error: null }) => unknown) =>
          resolve({
            data: table === 'whatsapp_config' ? [{ id: 'cfg-1', phone_number_id: 'pn-1', access_token: 'token' }] : null,
            error: null,
          }),
      };
      return builder;
    },
  }),
}));

import { engineSendText } from './meta-send';

const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ messages: [{ id: 'wamid.svc' }] }) }));
const ARGS = { accountId: 'acct-1', userId: 'u-1', conversationId: 'cv-1', contactId: 'ct-1', text: 'Booked' };

beforeEach(() => {
  Object.assign(gate, { paused: false, suspended: false, pauseChecks: 0, suspensionChecks: 0 });
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

describe('engineSendText serviceMessage', () => {
  it('a bot send stops while an agent has taken over', async () => {
    gate.paused = true;
    await expect(engineSendText(ARGS)).rejects.toThrow(/paused/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a service message is sent during takeover and never consults the pause', async () => {
    gate.paused = true;
    await expect(engineSendText({ ...ARGS, serviceMessage: true })).resolves.toEqual({ whatsapp_message_id: 'wamid.svc' });
    expect(gate.pauseChecks).toBe(0);
    expect(gate.suspensionChecks).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a suspended workspace still refuses a service message before Meta', async () => {
    gate.suspended = true;
    await expect(engineSendText({ ...ARGS, serviceMessage: true })).rejects.toThrow('workspace_suspended');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
