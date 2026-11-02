import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  receivedAt: new Date('2026-11-02T20:00:00Z') as Date | null,
  config: { status: 'connected', access_token: 'enc' } as Record<string, unknown> | Error,
  paused: false,
  claimed: 1,
  dispatch: vi.fn(),
  send: vi.fn(),
  claims: [] as unknown[],
}));

vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => 'worker' }));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (_context: unknown, op: (tx: unknown) => unknown) => op({
    $queryRaw: async () => (h.receivedAt ? [{ created_at: h.receivedAt }] : []),
    $executeRaw: async (...args: unknown[]) => { h.claims.push(args.slice(1)); return h.claimed; },
    conversations: { findFirst: async () => ({ whatsapp_config_id: 'cfg' }) },
  }),
}));
vi.mock('./inbox-settings', () => ({ readInboxSettings: async () => h.settings }));
vi.mock('@/lib/whatsapp/numbers', async (original) => {
  const actual = await original<typeof import('@/lib/whatsapp/numbers')>();
  return {
    ...actual,
    getNumberConfig: async () => { if (h.config instanceof Error) throw h.config; return h.config; },
  };
});
vi.mock('@/lib/whatsapp/bot-pause', () => ({ botRepliesPaused: async () => h.paused }));
vi.mock('@/lib/jobs/dispatch', () => ({ dispatchOnce: h.dispatch }));
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.send }));

import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { NoNumberError } from '@/lib/whatsapp/numbers';
import { awayMessageKey, sendAwayMessage } from './away-message';

const ID = '00000000-0000-4000-8000-000000000001';
const input = { accountId: ID, userId: ID, conversationId: ID, contactId: ID, messageId: ID };
// Monday 20:00 UTC; open Mon-Fri 09:00-18:00 UTC.
const now = new Date('2026-11-02T20:05:00Z');
const hours = { mon: [{ start: '09:00', end: '18:00' }], tue: [{ start: '09:00', end: '18:00' }] };

beforeEach(() => {
  vi.clearAllMocks();
  h.settings = { timezone: 'UTC', working_hours: hours, away_message_enabled: true, away_message: ' Back at 9 ' };
  h.receivedAt = new Date('2026-11-02T20:00:00Z');
  h.config = { status: 'connected', access_token: 'enc' };
  h.paused = false;
  h.claimed = 1;
  h.claims = [];
  h.dispatch.mockImplementation(async (_account: string, _key: string, send: () => Promise<unknown>) => send());
  h.send.mockResolvedValue({ whatsapp_message_id: 'wamid.away' });
});

describe('sendAwayMessage', () => {
  it('claims the window and sends once through an intent keyed by it, from the conversation', async () => {
    expect(await sendAwayMessage(input, now)).toBe('sent');
    expect(h.claims).toHaveLength(1);
    expect(h.claims[0]).toEqual([ID, ID, 'open:2026-11-03T09:00']);
    expect(h.dispatch).toHaveBeenCalledWith(ID, awayMessageKey(ID, 'open:2026-11-03T09:00'), expect.any(Function));
    expect(h.send).toHaveBeenCalledWith({ accountId: ID, userId: ID, conversationId: ID, contactId: ID, text: 'Back at 9' });
  });

  it.each([
    ['off', () => { h.settings.away_message_enabled = false; }],
    ['within_hours', () => { h.receivedAt = new Date('2026-11-02T10:00:00Z'); }],
    ['window_closed', () => { h.receivedAt = new Date('2026-11-01T19:00:00Z'); }],
    ['window_closed', () => { h.receivedAt = null; }],
    ['number_unavailable', () => { h.config = { status: 'disconnected', access_token: '' }; }],
    ['number_unavailable', () => { h.config = new NoNumberError('disconnected'); }],
    ['bot_paused', () => { h.paused = true; }],
    ['already_sent', () => { h.claimed = 0; }],
  ])('returns %s without sending', async (outcome, arrange) => {
    arrange();
    expect(await sendAwayMessage(input, now)).toBe(outcome);
    expect(h.send).not.toHaveBeenCalled();
    if (outcome !== 'already_sent') expect(h.claims).toHaveLength(0);
  });

  it('reports a provider refusal and lets an uncertain outcome propagate', async () => {
    h.dispatch.mockRejectedValueOnce(new MetaApiError('bad', { httpStatus: 400 }));
    expect(await sendAwayMessage(input, now)).toBe('provider_rejected');
    const uncertain = Object.assign(new Error('uncertain'), { name: 'UncertainDispatchError' });
    h.dispatch.mockRejectedValueOnce(uncertain);
    await expect(sendAwayMessage(input, now)).rejects.toBe(uncertain);
  });
});
