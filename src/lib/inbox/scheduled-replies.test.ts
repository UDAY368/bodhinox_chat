import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  due: [] as Record<string, unknown>[],
  channelRows: [{ channel: 'whatsapp' }] as unknown[],
  intentRows: [] as unknown[],
  executed: [] as { sql: string; values: unknown[] }[],
  queried: [] as string[],
  dispatch: vi.fn(),
  sendText: vi.fn(),
  numberDisconnected: false,
  credentials: vi.fn(),
  igTarget: null as null | Record<string, unknown>,
  config: null as null | Record<string, unknown>,
  igCheck: vi.fn(),
  igSend: vi.fn(),
}));

const textOf = (strings: unknown) => (Array.isArray(strings) ? (strings as string[]) : ((strings as { strings: string[] }).strings)).join('?');
const valuesOf = (strings: unknown, values: unknown[]) => (Array.isArray(strings) ? values : (strings as { values: unknown[] }).values);
const tx = {
  $queryRaw: async (strings: unknown, ...values: unknown[]) => {
    const sql = textOf(strings);
    h.queried.push(sql);
    if (sql.includes('FOR UPDATE OF s SKIP LOCKED')) { const next = h.due.shift(); return next ? [next] : []; }
    if (sql.includes('INSERT INTO messages')) return [{ id: 'message-row' }];
    if (sql.includes('FROM outbound_intents')) return h.intentRows;
    if (sql.includes('FROM conversations WHERE')) return h.channelRows;
    if (sql.includes('INSERT INTO scheduled_replies') || sql.includes('UPDATE scheduled_replies')) {
      return [{ id: 'sr1', send_at: new Date(), sent_at: null, created_at: new Date(), updated_at: new Date(), values: valuesOf(strings, values) }];
    }
    return [];
  },
  $executeRaw: async (strings: unknown, ...values: unknown[]) => {
    h.executed.push({ sql: textOf(strings), values: valuesOf(strings, values) });
    return 1;
  },
};
vi.mock('@/lib/db/tenant', () => ({ withTenant: async (_c: unknown, op: (t: typeof tx) => unknown) => op(tx) }));
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({}) }));
vi.mock('@/lib/flows/admin-client', () => ({ databaseAdmin: () => ({}) }));
vi.mock('@/lib/flows/meta-send', () => ({
  conversationNumberDisconnected: async () => h.numberDisconnected,
  loadAccountMetaCredentials: (...args: unknown[]) => h.credentials(...args),
}));
vi.mock('@/lib/jobs/dispatch', async (original) => ({
  ...(await original<typeof import('@/lib/jobs/dispatch')>()),
  dispatchOnce: (...args: unknown[]) => h.dispatch(...args),
}));
vi.mock('@/lib/whatsapp/meta-api', async (original) => ({
  ...(await original<typeof import('@/lib/whatsapp/meta-api')>()),
  sendTextMessage: (...args: unknown[]) => h.sendText(...args),
}));
vi.mock('@/lib/instagram/config', async (original) => ({
  ...(await original<typeof import('@/lib/instagram/config')>()),
  instagramConfig: () => h.config,
}));
vi.mock('@/lib/channels/sender', async (original) => ({
  ...(await original<typeof import('@/lib/channels/sender')>()),
  loadInstagramTarget: async () => h.igTarget,
  checkInstagramText: (...args: unknown[]) => h.igCheck(...args),
  sendInstagramText: (...args: unknown[]) => h.igSend(...args),
}));

import { UncertainDispatchError } from '@/lib/jobs/dispatch';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { InstagramError } from '@/lib/instagram/errors';
import {
  createScheduledReply,
  parseScheduledReplyPatch,
  parseScheduleCreate,
  runScheduledReplies,
  type ScheduledReplyErrorCode,
} from './scheduled-replies';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CONV = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-11-12T10:00:00.000Z');
const inHours = (n: number) => new Date(NOW.getTime() + n * 3_600_000);
const me = { accountId: ACCOUNT, userId: USER, role: 'agent' as const };
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as { code: string }).code; } return null; };
const codeOf = async (p: Promise<unknown>) => p.then(() => null, (e: { code?: string }) => e.code ?? null);
const writes = () => h.executed.map((e) => e.sql.replace(/\s+/g, ' '));

function dueRow(over: Record<string, unknown> = {}) {
  return {
    id: 'sr1', conversation_id: CONV, channel: 'whatsapp', created_by_user_id: USER, content: 'See you at 5',
    status: 'pending', message_id: null, attempts: 0, send_at: inHours(-1), conv_status: 'open', contact_id: 'contact-1',
    blocked_at: null, phone: '+15551230000', wa_user_id: null, last_customer_at: inHours(-2), ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.due = []; h.executed = []; h.queried = []; h.intentRows = [];
  h.channelRows = [{ channel: 'whatsapp' }];
  h.numberDisconnected = false;
  h.credentials.mockResolvedValue({ phoneNumberId: 'pn', accessToken: 'tok' });
  h.dispatch.mockImplementation(async (_a: string, _k: string, send: () => Promise<unknown>) => send());
  h.sendText.mockResolvedValue({ messageId: 'wamid.1' });
  h.config = { humanAgentEnabled: false, ctdWindowEnabled: false };
  h.igTarget = { lastCustomerAt: inHours(-2), adReferralAt: null };
  h.igCheck.mockReturnValue({ humanAgentTag: false });
  h.igSend.mockResolvedValue({ messageId: 'ig.1' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('input', () => {
  it('parses a schedule and refuses empty, long, past and malformed input', () => {
    expect(parseScheduleCreate({ conversation_id: CONV, content: ' hi ', send_at: inHours(2).toISOString() }, NOW))
      .toEqual({ conversationId: CONV, content: 'hi', sendAt: inHours(2) });
    const bad = (body: Record<string, unknown>): ScheduledReplyErrorCode | null => code(() => parseScheduleCreate(body, NOW)) as ScheduledReplyErrorCode | null;
    expect(bad({ conversation_id: CONV, content: '  ', send_at: inHours(2).toISOString() })).toBe('empty');
    expect(bad({ conversation_id: CONV, content: 'x'.repeat(4097), send_at: inHours(2).toISOString() })).toBe('tooLong');
    expect(bad({ conversation_id: CONV, content: 'hi', send_at: inHours(-1).toISOString() })).toBe('past');
    expect(bad({ conversation_id: 'x', content: 'hi', send_at: inHours(2).toISOString() })).toBe('invalid_request');
  });
  it('tells cancel, edit and reconcile apart and refuses mixes', () => {
    expect(parseScheduledReplyPatch({ status: 'cancelled' }, NOW)).toEqual({ kind: 'cancel' });
    expect(parseScheduledReplyPatch({ reconcile: 'sent' }, NOW)).toEqual({ kind: 'reconcile', outcome: 'sent' });
    expect(parseScheduledReplyPatch({ content: 'new' }, NOW)).toEqual({ kind: 'edit', content: 'new' });
    expect(code(() => parseScheduledReplyPatch({ reconcile: 'pending' }, NOW))).toBe('invalid_request');
    expect(code(() => parseScheduledReplyPatch({ reconcile: 'sent', content: 'x' }, NOW))).toBe('invalid_request');
    expect(code(() => parseScheduledReplyPatch({ status: 'sent' }, NOW))).toBe('invalid_request');
    expect(code(() => parseScheduledReplyPatch({}, NOW))).toBe('invalid_request');
  });
});

describe('createScheduledReply', () => {
  const input = (hours: number, content = 'hello') => ({ conversationId: CONV, content, sendAt: inHours(hours) });

  it('queues a WhatsApp reply (the row is written before the caller returns) up to 30 days ahead', async () => {
    const row = await createScheduledReply(me, input(3), NOW);
    expect(row.id).toBe('sr1');
    expect(h.queried.some((q) => q.includes('INSERT INTO scheduled_replies'))).toBe(true);
    expect(await codeOf(createScheduledReply(me, input(31 * 24), NOW))).toBe('tooFarWhatsapp');
  });

  it('a conversation the member cannot read is not found and nothing is stored', async () => {
    h.channelRows = [];
    expect(await codeOf(createScheduledReply(me, input(3), NOW))).toBe('notFound');
    expect(h.queried.some((q) => q.includes('INSERT INTO scheduled_replies'))).toBe(false);
  });

  describe('Instagram', () => {
    beforeEach(() => { h.channelRows = [{ channel: 'instagram' }]; });

    it('is refused beyond 7 days', async () => {
      expect(await codeOf(createScheduledReply(me, input(8 * 24), NOW))).toBe('tooFarInstagram');
    });
    it('is refused when Instagram is off', async () => {
      h.config = null;
      expect(await codeOf(createScheduledReply(me, input(3), NOW))).toBe('instagram_not_enabled');
    });
    it('is allowed inside the 24-hour window the reply will land in', async () => {
      h.igTarget = { lastCustomerAt: inHours(-2), adReferralAt: null };
      expect((await createScheduledReply(me, input(3), NOW)).id).toBe('sr1');
    });
    it('is refused after 24 hours without the Human Agent feature', async () => {
      h.igTarget = { lastCustomerAt: inHours(-2), adReferralAt: null };
      expect(await codeOf(createScheduledReply(me, input(30), NOW))).toBe('humanAgentOff');
    });
    it('is allowed after 24 hours with the Human Agent feature, inside its 7 days', async () => {
      h.config = { humanAgentEnabled: true, ctdWindowEnabled: false };
      expect((await createScheduledReply(me, input(30), NOW)).id).toBe('sr1');
    });
    it('is refused when even Human Agent cannot cover the time (7 days after the customer’s last message)', async () => {
      h.config = { humanAgentEnabled: true, ctdWindowEnabled: false };
      h.igTarget = { lastCustomerAt: inHours(-6 * 24), adReferralAt: null };
      expect(await codeOf(createScheduledReply(me, input(30), NOW))).toBe('windowClosed');
    });
    it('is refused when the text is over 1000 bytes', async () => {
      expect(await codeOf(createScheduledReply(me, input(3, 'é'.repeat(501)), NOW))).toBe('tooLongInstagram');
    });
  });
});

describe('runScheduledReplies', () => {
  it('claims, sends once through dispatchOnce with the reply’s own key, then settles it as sent', async () => {
    h.due = [dueRow()];
    expect(await runScheduledReplies(ACCOUNT, NOW)).toBe(1);
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.dispatch.mock.calls[0][0]).toBe(ACCOUNT);
    expect(h.dispatch.mock.calls[0][1]).toBe('scheduled-reply:sr1');
    expect(h.sendText).toHaveBeenCalledWith(expect.objectContaining({ to: expect.stringMatching(/^\+?1555/), text: 'See you at 5' }));
    const sql = writes();
    // The claim (and the staff message row) comes before the send; the outcome after it.
    expect(h.queried.some((q) => q.includes('INSERT INTO messages'))).toBe(true);
    expect(sql.findIndex((s) => s.includes("status='sending'"))).toBeLessThan(sql.findIndex((s) => s.includes("status='sent'")));
    expect(sql.some((s) => s.includes('bot_paused=true'))).toBe(true);
  });

  it('sends nothing for a reply whose WhatsApp window closed, and records only a machine reason', async () => {
    h.due = [dueRow({ last_customer_at: inHours(-30) })];
    await runScheduledReplies(ACCOUNT, NOW);
    expect(h.dispatch).not.toHaveBeenCalled();
    const skipped = h.executed.find((e) => e.sql.includes("status='skipped'"));
    expect(skipped?.values).toContain('window_closed');
    expect(JSON.stringify(h.executed.map((e) => e.values))).not.toContain('See you at 5');
  });

  it.each([
    ['a closed conversation', { conv_status: 'closed' }, 'conversation_closed'],
    ['a blocked contact', { blocked_at: new Date() }, 'channel_off'],
  ])('skips %s', async (_name, over, reason) => {
    h.due = [dueRow(over)];
    await runScheduledReplies(ACCOUNT, NOW);
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.executed.find((e) => e.sql.includes("status='skipped'"))?.values).toContain(reason);
  });

  it('skips when the number was disconnected', async () => {
    h.numberDisconnected = true;
    h.due = [dueRow()];
    await runScheduledReplies(ACCOUNT, NOW);
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.executed.find((e) => e.sql.includes("status='skipped'"))?.values).toContain('channel_off');
  });

  it('an ambiguous outcome becomes unknown: never failed, never retried', async () => {
    h.due = [dueRow()];
    h.dispatch.mockRejectedValue(new UncertainDispatchError());
    expect(await runScheduledReplies(ACCOUNT, NOW)).toBe(1);
    const settled = h.executed.filter((e) => e.sql.includes('UPDATE scheduled_replies') && e.values.includes('unknown'));
    expect(settled).toHaveLength(1);
    expect(h.executed.some((e) => e.sql.includes("status='sent'"))).toBe(false);
  });

  it('a provider rejection becomes failed with a machine reason', async () => {
    h.due = [dueRow()];
    h.dispatch.mockRejectedValue(new MetaApiError('rejected', { httpStatus: 400 }));
    await runScheduledReplies(ACCOUNT, NOW);
    expect(h.executed.some((e) => e.sql.includes('UPDATE scheduled_replies') && e.values.includes('failed'))).toBe(true);
  });

  it('a recovered claim keeps its message row and is sent only through the same intent key', async () => {
    h.due = [dueRow({ status: 'sending', message_id: 'message-row', attempts: 1 })];
    await runScheduledReplies(ACCOUNT, NOW);
    expect(h.queried.some((q) => q.includes('INSERT INTO messages'))).toBe(false);
    expect(h.dispatch.mock.calls[0][1]).toBe('scheduled-reply:sr1');
  });

  it('a reply claimed too many times is surfaced as unknown instead of tried again', async () => {
    h.due = [dueRow({ status: 'sending', message_id: 'message-row', attempts: 5 })];
    await runScheduledReplies(ACCOUNT, NOW);
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(writes().some((s) => s.includes("SET status='unknown'"))).toBe(true);
  });

  it('a local problem before the send fails the reply when no intent exists, and flags it unknown when one does', async () => {
    h.credentials.mockRejectedValue(new Error('number disconnected'));
    h.due = [dueRow()];
    await runScheduledReplies(ACCOUNT, NOW);
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.executed.some((e) => e.sql.includes('UPDATE scheduled_replies') && e.values.includes('failed'))).toBe(true);

    h.executed = [];
    h.intentRows = [{ n: 1 }];
    h.due = [dueRow()];
    await runScheduledReplies(ACCOUNT, NOW);
    expect(h.executed.some((e) => e.sql.includes('UPDATE scheduled_replies') && e.values.includes('unknown'))).toBe(true);
  });

  describe('Instagram', () => {
    beforeEach(() => { h.due = [dueRow({ channel: 'instagram' })]; });

    it('sends through the Instagram sender with the staff context', async () => {
      await runScheduledReplies(ACCOUNT, NOW);
      expect(h.igCheck).toHaveBeenCalledWith(h.igTarget, 'See you at 5', { sender: 'staff', now: NOW });
      expect(h.igSend).toHaveBeenCalledTimes(1);
    });
    it('skips with human_agent_off when the window passed 24 hours and the feature is off', async () => {
      h.igTarget = { lastCustomerAt: inHours(-30), adReferralAt: null };
      h.igCheck.mockImplementation(() => { throw new InstagramError('instagram_window_closed'); });
      await runScheduledReplies(ACCOUNT, NOW);
      expect(h.igSend).not.toHaveBeenCalled();
      expect(h.executed.find((e) => e.sql.includes("status='skipped'"))?.values).toContain('human_agent_off');
    });
    it('skips with window_closed when Human Agent is on but the window still closed', async () => {
      h.config = { humanAgentEnabled: true, ctdWindowEnabled: false };
      h.igTarget = { lastCustomerAt: inHours(-9 * 24), adReferralAt: null };
      h.igCheck.mockImplementation(() => { throw new InstagramError('instagram_window_closed'); });
      await runScheduledReplies(ACCOUNT, NOW);
      expect(h.executed.find((e) => e.sql.includes("status='skipped'"))?.values).toContain('window_closed');
    });
    it('skips with channel_off when the account is disconnected', async () => {
      h.igCheck.mockImplementation(() => { throw new InstagramError('instagram_account_disconnected'); });
      await runScheduledReplies(ACCOUNT, NOW);
      expect(h.executed.find((e) => e.sql.includes("status='skipped'"))?.values).toContain('channel_off');
    });
  });
});
