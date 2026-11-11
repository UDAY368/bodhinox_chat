import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rows: [] as unknown[],
  calls: [] as { sql: string; values: unknown[] }[],
  notify: vi.fn(async () => ({ inApp: [], emailQueued: [] })),
  contexts: [] as unknown[],
}));

const sqlOf = (strings: TemplateStringsArray | { strings?: string[]; sql?: string }) =>
  Array.isArray(strings) ? (strings as string[]).join('?') : ((strings as { strings?: string[] }).strings ?? []).join('?');
const tx = {
  $queryRaw: async (strings: TemplateStringsArray | { strings: string[]; values: unknown[] }, ...values: unknown[]) => {
    const text = sqlOf(strings as never);
    h.calls.push({ sql: text, values: Array.isArray(strings) ? values : (strings as { values: unknown[] }).values });
    return h.rows;
  },
  $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    h.calls.push({ sql: sqlOf(strings), values });
    return 1;
  },
};
vi.mock('@/lib/db/tenant', () => ({ withTenant: async (ctx: unknown, op: (t: typeof tx) => unknown) => { h.contexts.push(ctx); return op(tx); } }));
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({}) }));
vi.mock('./notify', () => ({ createNotification: h.notify }));

import {
  createReminder,
  listReminders,
  parseReminderCreate,
  parseReminderPatch,
  ReminderError,
  runDueReminders,
  updateReminder,
} from './reminders';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CONV = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-11-12T10:00:00.000Z');
const inHours = (n: number) => new Date(NOW.getTime() + n * 3_600_000).toISOString();
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as ReminderError).code; } return null; };

beforeEach(() => { vi.clearAllMocks(); h.rows = []; h.calls = []; h.contexts = []; });

describe('parseReminderCreate', () => {
  it('accepts a reminder and a snooze, trimming the note', () => {
    expect(parseReminderCreate({ conversation_id: CONV, remind_at: inHours(2), note: '  call back ' }, NOW))
      .toEqual({ conversationId: CONV, kind: 'reminder', remindAt: new Date(inHours(2)), note: 'call back' });
    expect(parseReminderCreate({ conversation_id: CONV, remind_at: inHours(2), kind: 'snooze' }, NOW).kind).toBe('snooze');
  });
  it('refuses the past, more than a year ahead, bad ids, kinds, notes and shapes', () => {
    expect(code(() => parseReminderCreate({ conversation_id: CONV, remind_at: inHours(-1) }, NOW))).toBe('past');
    expect(code(() => parseReminderCreate({ conversation_id: CONV, remind_at: inHours(366 * 24) }, NOW))).toBe('tooFar');
    expect(code(() => parseReminderCreate({ conversation_id: 'x', remind_at: inHours(1) }, NOW))).toBe('invalid_request');
    expect(code(() => parseReminderCreate({ conversation_id: CONV, remind_at: inHours(1), kind: 'alarm' }, NOW))).toBe('invalid_request');
    expect(code(() => parseReminderCreate({ conversation_id: CONV, remind_at: inHours(1), note: 'x'.repeat(501) }, NOW))).toBe('invalid_request');
    expect(code(() => parseReminderCreate({ conversation_id: CONV, remind_at: 'tomorrow' }, NOW))).toBe('invalid_request');
    expect(code(() => parseReminderCreate(null, NOW))).toBe('invalid_request');
  });
});

describe('parseReminderPatch', () => {
  it('takes a status alone, or a time and note', () => {
    expect(parseReminderPatch({ status: 'dismissed' }, NOW)).toEqual({ status: 'dismissed' });
    expect(parseReminderPatch({ remind_at: inHours(3), note: null }, NOW)).toEqual({ remindAt: new Date(inHours(3)), note: null });
  });
  it('refuses fired, mixed and empty patches', () => {
    expect(code(() => parseReminderPatch({ status: 'fired' }, NOW))).toBe('invalid_request');
    expect(code(() => parseReminderPatch({ status: 'cancelled', note: 'x' }, NOW))).toBe('invalid_request');
    expect(code(() => parseReminderPatch({}, NOW))).toBe('invalid_request');
    expect(code(() => parseReminderPatch({ remind_at: inHours(-2) }, NOW))).toBe('past');
  });
});

describe('member operations', () => {
  const me = { accountId: ACCOUNT, userId: USER, role: 'agent' as const };

  it('needs a member identity', async () => {
    await expect(listReminders({ accountId: ACCOUNT, role: 'agent' })).rejects.toThrow('member identity');
  });

  it('lists only the caller’s own rows, whatever the filter', async () => {
    await listReminders(me, { conversationId: CONV });
    expect(h.calls[0].sql).toContain('user_id=');
    expect(h.calls[0].values).toContain(USER);
  });

  it('a conversation the member cannot read is not found and nothing is written', async () => {
    h.rows = [];
    await expect(createReminder(me, { conversationId: CONV, kind: 'snooze', remindAt: new Date(inHours(2)), note: null }))
      .rejects.toMatchObject({ code: 'notFound', status: 404 });
    expect(h.calls).toHaveLength(1);
  });

  it('a new snooze cancels the person’s earlier pending snooze first', async () => {
    h.rows = [{ id: CONV, remind_at: NOW, fired_at: null, created_at: NOW, updated_at: NOW }];
    await createReminder(me, { conversationId: CONV, kind: 'snooze', remindAt: new Date(inHours(2)), note: null });
    const sqls = h.calls.map((c) => c.sql);
    expect(sqls[1]).toContain("status='cancelled'");
    expect(sqls[1]).toContain("kind='snooze'");
    expect(sqls[2]).toContain('INSERT INTO conversation_reminders');
  });

  it('another member’s or another workspace’s reminder id is a not-found', async () => {
    h.rows = [];
    await expect(updateReminder(me, CONV, { status: 'cancelled' })).rejects.toMatchObject({ code: 'notFound' });
    expect(h.calls[0].sql).toContain('user_id=');
    await expect(updateReminder(me, 'nope', { status: 'cancelled' })).rejects.toMatchObject({ code: 'notFound' });
  });

  it('cancelling and editing reach only pending rows; dismissing also reaches fired ones', async () => {
    h.rows = [{ remind_at: NOW, fired_at: null, created_at: NOW, updated_at: NOW }];
    await updateReminder(me, CONV, { status: 'cancelled' });
    expect(h.calls[0].values).toContainEqual(['pending']);
    await updateReminder(me, CONV, { status: 'dismissed' });
    expect(h.calls[1].values).toContainEqual(['pending', 'fired']);
  });
});

describe('updateReminder time cap', () => {
  const me = { accountId: ACCOUNT, userId: USER, role: 'agent' as const };
  it('refuses an edit past 366 days from the row’s own creation (the table cap), as tooFar', async () => {
    const created = new Date(NOW.getTime() - 100 * 86_400_000);
    h.rows = [{ remind_at: NOW, fired_at: null, created_at: created, updated_at: NOW }];
    await expect(updateReminder(me, CONV, { remindAt: new Date(created.getTime() + 367 * 86_400_000) })).rejects.toMatchObject({ code: 'tooFar' });
    await expect(updateReminder(me, CONV, { remindAt: new Date(created.getTime() + 300 * 86_400_000) })).resolves.toBeTruthy();
  });
});

describe('runDueReminders', () => {
  it('fires due reminders and notifies their owners in the same transaction, with a dedupe key', async () => {
    h.rows = [{ id: 'r1', user_id: USER, conversation_id: CONV }];
    expect(await runDueReminders(ACCOUNT)).toBe(1);
    expect(h.contexts).toEqual([{ accountId: ACCOUNT, role: 'owner' }]);
    expect(h.calls[0].sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(h.notify).toHaveBeenCalledWith(tx, expect.objectContaining({
      accountId: ACCOUNT, userIds: [USER], dedupeKey: 'reminder:r1', conversationId: CONV, link: `/inbox?c=${CONV}`,
    }));
    // The note is staff text and is not copied into the notification.
    expect(JSON.stringify(h.notify.mock.calls)).not.toContain('note');
  });
  it('does nothing when nothing is due', async () => {
    h.rows = [];
    expect(await runDueReminders(ACCOUNT)).toBe(0);
    expect(h.notify).not.toHaveBeenCalled();
  });
});
