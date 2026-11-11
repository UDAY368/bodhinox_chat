// Stage 5 (5D): timed pause maths and the pause writers' SQL shape. The SQL
// itself (trigger, RLS, expiry) is proven on PostgreSQL in
// automation-pause.integration.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ executed: [] as string[], queried: [] as string[], params: [] as unknown[][] }));
const sqlText = (value: unknown): string => {
  const sql = value as { strings?: readonly string[]; sql?: string } | readonly string[];
  if (Array.isArray(sql)) return sql.join('?');
  return (sql as { sql?: string }).sql ?? (sql as { strings?: readonly string[] }).strings?.join('?') ?? String(value);
};
const tx = {
  $executeRaw: vi.fn(async (sql: unknown, ...params: unknown[]) => {
    h.executed.push(sqlText(sql));
    h.params.push((sql as { values?: unknown[] }).values ?? params);
    return 1;
  }),
  $queryRaw: vi.fn(async (sql: unknown) => { h.queried.push(sqlText(sql)); return []; }),
};
vi.mock('@/lib/db/prisma', async (original) => ({ ...(await original<typeof import('@/lib/db/prisma')>()), getWorkerPrisma: () => ({}) }));
vi.mock('@/lib/db/tenant', async (original) => ({
  ...(await original<typeof import('@/lib/db/tenant')>()),
  withTenant: async (_ctx: unknown, work: (t: unknown) => unknown) => work(tx),
}));

import {
  AutomationPauseError,
  clearExpiredPause,
  isPauseChoice,
  parsePauseRequest,
  pauseActive,
  pauseAutomations,
  pauseEndsAt,
  pauseForAgentReply,
  resumeAutomations,
} from './automation-pause';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const CONTACT = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-11-11T10:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  h.executed = [];
  h.queried = [];
  h.params = [];
});

describe('pauseActive', () => {
  it('is false without bot_paused, whatever the time says', () => {
    expect(pauseActive(null, NOW)).toBe(false);
    expect(pauseActive({ bot_paused: false, bot_paused_until: '2026-11-12T00:00:00Z' }, NOW)).toBe(false);
  });
  it('is true until resumed when no end time is stored (the behaviour before Stage 5)', () => {
    expect(pauseActive({ bot_paused: true }, NOW)).toBe(true);
    expect(pauseActive({ bot_paused: true, bot_paused_until: null }, NOW)).toBe(true);
  });
  it('ends exactly at its time: a future time is paused, the time itself and later are not', () => {
    expect(pauseActive({ bot_paused: true, bot_paused_until: '2026-11-11T10:00:01Z' }, NOW)).toBe(true);
    expect(pauseActive({ bot_paused: true, bot_paused_until: '2026-11-11T10:00:00Z' }, NOW)).toBe(false);
    expect(pauseActive({ bot_paused: true, bot_paused_until: new Date('2026-11-11T09:00:00Z') }, NOW)).toBe(false);
  });
  it('treats an unreadable time as until resumed, so nothing resumes by accident', () => {
    expect(pauseActive({ bot_paused: true, bot_paused_until: 'not a date' }, NOW)).toBe(true);
  });
});

describe('pauseEndsAt and the offered lengths', () => {
  it('adds the minutes, across midnight too, and null means until resumed', () => {
    expect(pauseEndsAt(30, NOW)?.toISOString()).toBe('2026-11-11T10:30:00.000Z');
    expect(pauseEndsAt(1440, new Date('2026-11-11T23:30:00Z'))?.toISOString()).toBe('2026-11-12T23:30:00.000Z');
    expect(pauseEndsAt(null, NOW)).toBeNull();
  });
  it('offers 30 minutes, 1, 3, 6, 12 hours, 1 day or until resumed, nothing else', () => {
    for (const ok of [30, 60, 180, 360, 720, 1440, null]) expect(isPauseChoice(ok), String(ok)).toBe(true);
    for (const bad of [0, 15, 45, 1441, -30, '30', undefined, 30.5]) expect(isPauseChoice(bad), String(bad)).toBe(false);
  });
});

describe('parsePauseRequest', () => {
  it('reads a pause, defaulting to this conversation and until resumed', () => {
    expect(parsePauseRequest({ conversation_id: CONVERSATION, action: 'pause' }))
      .toEqual({ conversationId: CONVERSATION, action: 'pause', minutes: null, scope: 'conversation' });
    expect(parsePauseRequest({ conversation_id: CONVERSATION, action: 'pause', minutes: 180, scope: 'contact' }))
      .toEqual({ conversationId: CONVERSATION, action: 'pause', minutes: 180, scope: 'contact' });
  });
  it('reads a resume and ignores minutes on it', () => {
    expect(parsePauseRequest({ conversation_id: CONVERSATION, action: 'resume', minutes: 99 }))
      .toEqual({ conversationId: CONVERSATION, action: 'resume', minutes: null, scope: 'conversation' });
  });
  it.each([
    null, [], 'x', {},
    { conversation_id: 'nope', action: 'pause' },
    { conversation_id: CONVERSATION, action: 'stop' },
    { conversation_id: CONVERSATION, action: 'pause', minutes: 45 },
    { conversation_id: CONVERSATION, action: 'pause', scope: 'workspace' },
  ])('refuses %j', (body) => {
    expect(parsePauseRequest(body)).toBeNull();
  });
});

describe('pause writers', () => {
  it('pauses one conversation for a length, marking the transaction as an explicit pause and recording who', async () => {
    await pauseAutomations(ACCOUNT, { conversationId: CONVERSATION, minutes: 60, byUserId: USER });
    expect(h.queried[0]).toContain("set_config('app.pause_explicit', 'on', true)");
    expect(h.executed[0]).toMatch(/UPDATE conversations SET bot_paused=true, bot_paused_until=[\s\S]*bot_paused_by=/);
    expect(h.executed[0]).toContain('id=');
    expect(h.params[0]).toEqual(expect.arrayContaining([USER, ACCOUNT, CONVERSATION]));
  });
  it('pauses every conversation of a contact when asked', async () => {
    await pauseAutomations(ACCOUNT, { contactId: CONTACT, minutes: null, byUserId: null });
    expect(h.executed[0]).toContain('contact_id=');
    expect(h.params[0]).toEqual(expect.arrayContaining([ACCOUNT, CONTACT]));
  });
  it('refuses a length it does not offer and a malformed id before any write', async () => {
    await expect(pauseAutomations(ACCOUNT, { conversationId: CONVERSATION, minutes: 45, byUserId: USER }))
      .rejects.toBeInstanceOf(AutomationPauseError);
    await expect(pauseAutomations(ACCOUNT, { conversationId: 'x', minutes: 30, byUserId: USER }))
      .rejects.toBeInstanceOf(AutomationPauseError);
    expect(h.executed).toEqual([]);
  });
  it('resumes by clearing the pause, its time and its author, and the AI hold as the inbox always did', async () => {
    await resumeAutomations(ACCOUNT, { conversationId: CONVERSATION, byUserId: USER });
    expect(h.executed[0]).toContain('bot_paused=false, ai_autoreply_disabled=false');
    expect(h.executed[0]).toContain('bot_paused_until=NULL, bot_paused_by=NULL');
  });
  it('clears only a pause whose time has passed', async () => {
    await clearExpiredPause(ACCOUNT, CONVERSATION);
    expect(h.executed[0]).toContain('bot_paused_until IS NOT NULL AND bot_paused_until <= now()');
  });
  it('pauses for the workspace setting on an agent reply, keeping an until-resumed pause and never shortening one', async () => {
    await pauseForAgentReply(tx as never, ACCOUNT, CONVERSATION, USER);
    expect(h.queried[0]).toContain('app.pause_explicit');
    const sql = h.executed[0];
    expect(sql).toContain('agent_reply_pause_minutes');
    expect(sql).toContain('WHEN c.bot_paused AND c.bot_paused_until IS NULL THEN NULL');
    expect(sql).toContain('GREATEST(');
  });
});
