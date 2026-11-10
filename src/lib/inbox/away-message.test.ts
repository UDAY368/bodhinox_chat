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
  conversation: { whatsapp_config_id: 'cfg' } as Record<string, unknown>,
}));

vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => 'worker' }));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (_context: unknown, op: (tx: unknown) => unknown) => op({
    $queryRaw: async () => (h.receivedAt ? [{ created_at: h.receivedAt }] : []),
    $executeRaw: async (...args: unknown[]) => { h.claims.push(args.slice(1)); return h.claimed; },
    conversations: { findFirst: async () => h.conversation },
  }),
}));
const ig = vi.hoisted(() => ({ load: vi.fn(), check: vi.fn(), flowSend: vi.fn() }));
vi.mock('@/lib/channels/sender', () => ({ loadInstagramTarget: ig.load, checkInstagramText: ig.check }));
vi.mock('@/lib/flows/channel-send', () => ({ flowSend: ig.flowSend }));
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

import { InstagramError } from '@/lib/instagram/errors';
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
  h.conversation = { whatsapp_config_id: 'cfg' };
  ig.load.mockImplementation(async (_tx: unknown, _account: string, conversationId: string) => ({ conversationId }));
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

describe('sendAwayMessage on Instagram (Stage 2)', () => {
  beforeEach(() => {
    h.conversation = { whatsapp_config_id: null, channel: 'instagram' };
    h.settings = { ...h.settings, instagram_away_message_enabled: true };
    ig.check.mockImplementation(() => ({ humanAgentTag: false }));
    ig.flowSend.mockResolvedValue({ whatsapp_message_id: 'mid.away' });
  });

  it('sends the same text once per window through the Instagram sender under the window intent key', async () => {
    expect(await sendAwayMessage(input, now)).toBe('sent');
    expect(h.claims).toEqual([[ID, ID, 'open:2026-11-03T09:00']]);
    // Checked before the claim as an automated sender at the job's instant (never the Human Agent tag).
    expect(ig.check).toHaveBeenCalledWith(expect.objectContaining({ conversationId: ID }), 'Back at 9', { sender: 'automated', now });
    expect(ig.flowSend).toHaveBeenCalledWith({ account_id: ID, conversation_id: ID }, awayMessageKey(ID, 'open:2026-11-03T09:00'),
      { kind: 'text', args: { accountId: ID, userId: ID, conversationId: ID, contactId: ID, text: 'Back at 9' } });
    // Never the WhatsApp number or sender.
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('follows the Instagram switch, not the WhatsApp one', async () => {
    h.settings = { ...h.settings, away_message_enabled: true, instagram_away_message_enabled: false };
    expect(await sendAwayMessage(input, now)).toBe('off');
    h.settings = { ...h.settings, away_message_enabled: false, instagram_away_message_enabled: true };
    expect(await sendAwayMessage(input, now)).toBe('sent');
  });

  it('keeps a WhatsApp thread on the WhatsApp switch when only the Instagram one is on', async () => {
    h.conversation = { whatsapp_config_id: 'cfg', channel: 'whatsapp' };
    h.settings = { ...h.settings, away_message_enabled: false, instagram_away_message_enabled: true };
    expect(await sendAwayMessage(input, now)).toBe('off');
    expect(ig.flowSend).not.toHaveBeenCalled();
  });

  it.each([
    ['window_closed', 'instagram_window_closed'],
    ['account_unavailable', 'instagram_account_disconnected'],
    ['account_unavailable', 'instagram_token_invalid'],
    ['account_unavailable', 'instagram_not_enabled'],
    ['invalid_for_channel', 'invalid_request'],
  ] as const)('skips with %s when the Instagram check refuses (%s), before anything is claimed', async (outcome, code) => {
    ig.check.mockImplementation(() => { throw new InstagramError(code); });
    expect(await sendAwayMessage(input, now)).toBe(outcome);
    expect(h.claims).toHaveLength(0);
    expect(ig.flowSend).not.toHaveBeenCalled();
  });

  it('skips a message older than the 24-hour window without loading the account', async () => {
    h.receivedAt = new Date('2026-11-01T19:00:00Z');
    expect(await sendAwayMessage(input, now)).toBe('window_closed');
    expect(ig.load).not.toHaveBeenCalled();
  });

  it('maps a refusal at send time to its reason, and lets an uncertain outcome propagate for reconciliation', async () => {
    ig.flowSend.mockRejectedValueOnce(new InstagramError('instagram_window_closed'));
    expect(await sendAwayMessage(input, now)).toBe('window_closed');
    ig.flowSend.mockRejectedValueOnce(new MetaApiError('bad', { httpStatus: 400 }));
    expect(await sendAwayMessage(input, now)).toBe('provider_rejected');
    const uncertain = Object.assign(new Error('uncertain'), { name: 'UncertainDispatchError' });
    ig.flowSend.mockRejectedValueOnce(uncertain);
    await expect(sendAwayMessage(input, now)).rejects.toBe(uncertain);
  });
});
