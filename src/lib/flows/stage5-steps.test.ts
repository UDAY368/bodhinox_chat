// Stage 5 (5B) engine pieces that need no database: randomizer split and
// stickiness, smart-delay date and window maths, placeholders with fallbacks,
// trigger combination and precedence, test usernames, the comment reply
// delay, and the Actions cursor (with its side effects mocked). The SQL, RLS
// and tenancy behaviour is in stage5-engine.integration.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  executed: [] as string[],
  addTag: vi.fn(async () => {}),
  removeTag: vi.fn(async () => {}),
  pause: vi.fn(async () => {}),
  conversion: vi.fn(async () => {}),
  failAt: null as string | null,
}));

vi.mock('@/lib/db/prisma', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/db/prisma')>()), getWorkerPrisma: () => ({}) }));
vi.mock('@/lib/db/tenant', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db/tenant')>()),
  withTenant: async (_ctx: unknown, work: (tx: unknown) => unknown) => work({
    $executeRaw: async (sql: { strings?: readonly string[] }) => { h.executed.push((sql.strings ?? []).join('?')); return 1; },
    $queryRaw: async () => [],
  }),
}));
vi.mock('@/lib/contacts/tag-events', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/contacts/tag-events')>()),
  addContactTagAndDispatch: h.addTag,
}));
vi.mock('@/lib/contacts/tag-write', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/contacts/tag-write')>()),
  removeContactTag: async (...args: unknown[]) => {
    if (h.failAt === 'remove_tag') throw new Error('connection reset');
    return (h.removeTag as (...a: unknown[]) => Promise<void>)(...args);
  },
}));
vi.mock('@/lib/inbox/automation-pause', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/inbox/automation-pause')>()),
  pauseAutomations: h.pause,
}));
vi.mock('@/lib/analytics/conversion-log', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/analytics/conversion-log')>()),
  logConversion: h.conversion,
}));

import { chooseRandomizerPath, pickVar, randomizerPaths, stickyBucket, validSplit } from './nodes/randomizer';
import { dateInstant, insideWindow, maxWaitMs, nextAllowedInstant, planSmartDelay } from './nodes/smart-delay';
import { fillPlaceholders } from './placeholders';
import { cursorVar, flowPhoneDigits, queuedFlowStarts, runActions, START_AFTER_VAR, type ActionsContext } from './nodes/actions';
import { effectiveTriggers } from './flow-triggers';
import { byPrecedence, isTestUsername, keywordTriggerMatches, normalizeTestUsername } from './triggers';
import { commentReplyDelaySeconds } from './engine';
import type { FlowAction, FlowRunRow } from './types';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const FLOW = '22222222-2222-4222-8222-222222222222';
const OTHER_FLOW = '33333333-3333-4333-8333-333333333333';
const TAG = '44444444-4444-4444-8444-444444444444';
const EVENT_TYPE = '55555555-5555-4555-8555-555555555555';

describe('randomizer', () => {
  const config = { sticky: false, paths: [{ id: 'A', weight: 70, next_node_key: 'a' }, { id: 'B', weight: 30, next_node_key: 'b' }] };

  it('splits by the weights over many draws', () => {
    const counts = { A: 0, B: 0 } as Record<string, number>;
    for (let i = 0; i < 1000; i += 1) {
      const choice = chooseRandomizerPath({ config, nodeKey: 'split', contactId: null, vars: {}, random: () => i / 1000 });
      counts[choice!.path.id] += 1;
    }
    expect(counts).toEqual({ A: 700, B: 300 });
  });

  it('keeps a sticky contact on one path and spreads contacts close to the weights', () => {
    const sticky = { ...config, sticky: true };
    const first = chooseRandomizerPath({ config: sticky, nodeKey: 'split', contactId: ACCOUNT, vars: {}, random: () => 0.99 });
    for (let i = 0; i < 5; i += 1) {
      expect(chooseRandomizerPath({ config: sticky, nodeKey: 'split', contactId: ACCOUNT, vars: {}, random: Math.random })).toEqual(first);
    }
    expect(first!.store).toBe(false);
    // The same contact may land elsewhere on another step: the hash takes the node key too.
    expect(stickyBucket(ACCOUNT, 'split')).toBe(stickyBucket(ACCOUNT.toUpperCase(), 'split'));
    let a = 0;
    for (let i = 0; i < 2000; i += 1) {
      const id = `${i.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
      if (chooseRandomizerPath({ config: sticky, nodeKey: 'split', contactId: id, vars: {} })!.path.id === 'A') a += 1;
    }
    expect(a / 2000).toBeGreaterThan(0.64);
    expect(a / 2000).toBeLessThan(0.76);
  });

  it('stores a random pick and follows the stored pick on a replay', () => {
    const fresh = chooseRandomizerPath({ config, nodeKey: 'split', contactId: ACCOUNT, vars: {}, random: () => 0.9 });
    expect(fresh).toEqual({ path: expect.objectContaining({ id: 'B' }), store: true });
    const replay = chooseRandomizerPath({ config, nodeKey: 'split', contactId: ACCOUNT, vars: { [pickVar('split')]: 'B' }, random: () => 0 });
    expect(replay).toEqual({ path: expect.objectContaining({ id: 'B' }), store: false });
  });

  it('accepts only 2 to 6 well-formed paths totalling 100', () => {
    expect(validSplit(randomizerPaths(config))).toBe(true);
    expect(validSplit(randomizerPaths({ paths: [{ id: 'A', weight: 100, next_node_key: 'a' }] }))).toBe(false);
    expect(validSplit(randomizerPaths({ paths: [{ id: 'A', weight: 50, next_node_key: 'a' }, { id: 'B', weight: 40, next_node_key: 'b' }] }))).toBe(false);
    expect(randomizerPaths({ paths: [{ id: 'A', weight: 50 }, { id: 'A', weight: 50 }, { id: 'bad id', weight: 1 }, { id: 'C', weight: 1.5 }] })).toHaveLength(1);
  });
});

describe('smart delay', () => {
  const now = new Date('2026-11-11T10:00:00Z'); // a Wednesday

  it('waits a duration, at most 365 days, or reads the number from a custom field', () => {
    expect(planSmartDelay({ mode: 'duration', amount: 2, unit: 'hours' }, { now, timezone: 'UTC' }))
      .toEqual({ kind: 'wait', until: new Date('2026-11-11T12:00:00Z') });
    expect(planSmartDelay({ mode: 'duration', amount: 366, unit: 'days' }, { now, timezone: 'UTC' })).toEqual({ kind: 'invalid', reason: 'smart_delay_invalid' });
    expect(planSmartDelay({ mode: 'duration', amount: 0, unit: 'minutes' }, { now, timezone: 'UTC' })).toEqual({ kind: 'continue' });
    const field = { mode: 'duration' as const, amount_field_id: TAG, unit: 'days' as const };
    expect(planSmartDelay(field, { now, timezone: 'UTC', fieldValue: '3' })).toEqual({ kind: 'wait', until: new Date('2026-11-14T10:00:00Z') });
    expect(planSmartDelay(field, { now, timezone: 'UTC', fieldValue: '' })).toEqual({ kind: 'invalid', reason: 'smart_delay_field_empty' });
  });

  it('waits until a date plus an offset in the step time zone; a date that has passed stops the run', () => {
    expect(planSmartDelay({ mode: 'until_date', date: '2026-11-12T09:30', offset_minutes: -30 }, { now, timezone: 'Asia/Kolkata' }))
      .toEqual({ kind: 'wait', until: new Date('2026-11-12T03:30:00Z') });
    expect(planSmartDelay({ mode: 'until_date', date: '2026-11-10' }, { now, timezone: 'UTC' })).toEqual({ kind: 'date_passed' });
    expect(planSmartDelay({ mode: 'until_date', date_field_id: TAG }, { now, timezone: 'UTC', fieldValue: '20/11/2026' }))
      .toEqual({ kind: 'wait', until: new Date('2026-11-20T00:00:00Z') });
    expect(dateInstant('2026-02-30', 'UTC')).toBeNull();
  });

  it('moves the wake time into the send window: later the same day, across midnight, past skipped weekdays', () => {
    const tz = 'America/New_York';
    const business = { from: '09:00', to: '17:00', weekdays: [1, 2, 3, 4, 5] };
    // Wed 05:00 New York (10:00Z) is before opening: 09:00 New York the same day.
    expect(new Date(nextAllowedInstant(now.getTime(), business, tz)).toISOString()).toBe('2026-11-11T14:00:00.000Z');
    // Friday 18:00 New York: skips Saturday and Sunday to Monday 09:00.
    const fridayEvening = Date.parse('2026-11-13T23:00:00Z');
    expect(new Date(nextAllowedInstant(fridayEvening, business, tz)).toISOString()).toBe('2026-11-16T14:00:00.000Z');
    // A night window 22:00–06:00 belongs to the day it starts; 02:00 Saturday is Friday night.
    const night = { from: '22:00', to: '06:00', weekdays: [5] };
    expect(insideWindow(Date.parse('2026-11-14T07:00:00Z'), night, tz)).toBe(true);
    expect(insideWindow(Date.parse('2026-11-15T07:00:00Z'), night, tz)).toBe(false);
    expect(planSmartDelay({ mode: 'duration', amount: 1, unit: 'hours', send_window: business, timezone: tz }, { now, timezone: 'UTC' }))
      .toEqual({ kind: 'wait', until: new Date('2026-11-11T14:00:00Z') });
  });

  it('reports the longest wait for the Instagram 24-hour warning', () => {
    expect(maxWaitMs({ mode: 'duration', amount: 22, unit: 'hours' })).toBe(22 * 3_600_000);
    expect(maxWaitMs({ mode: 'duration', amount: 22, unit: 'hours', send_window: { from: '09:00', to: '10:00', weekdays: [] } }))
      .toBeGreaterThan(23 * 3_600_000);
    expect(maxWaitMs({ mode: 'until_date', date: '2026-12-01' })).toBeNull();
  });
});

describe('placeholders', () => {
  const contact = { fields: { name: 'Asha', email: null, username: 'asha.k' }, custom: { [TAG]: 'Gold' } };

  it('fills contact, custom and run values, with a fallback for a missing or empty one', () => {
    expect(fillPlaceholders('Hi {{contact.name}} ({{contact.username}}), tier {{custom.' + TAG + '}}', {}, {}, contact)).toBe('Hi Asha (asha.k), tier Gold');
    expect(fillPlaceholders('Hi {{contact.email|there}} {{vars.size|M}} {{vars.size}}!', { size: '' }, {}, contact)).toBe('Hi there M !');
    // Unchanged before Stage 5: a missing run value is empty, workspace values fill first.
    expect(fillPlaceholders('{{workspace.shop}}: {{vars.x}}.', {}, { shop: 'Acme' })).toBe('Acme: .');
  });

  it('never expands a placeholder that came from customer input', () => {
    expect(fillPlaceholders('You said {{vars.answer}}', { answer: '{{contact.email}} {{workspace.shop}} {{custom.' + TAG + '}}' }, { shop: 'Acme' }, contact))
      .toBe(`You said {{contact.email}} {{workspace.shop}} {{custom.${TAG}}}`);
  });
});

describe('triggers', () => {
  it('lists the primary trigger first, then well-formed extra triggers once each', () => {
    const flow = { trigger_type: 'keyword', trigger_config: { keywords: ['hi'] }, extra_triggers: [
      { trigger_type: 'ig_comment', config: { post_scope: 'any' } }, { trigger_type: 'nope', config: {} },
      { trigger_type: 'keyword', config: { keywords: ['hi'] } }, { trigger_type: 'ig_story_reply', config: {} }] };
    expect(effectiveTriggers(flow).map((t) => t.trigger_type)).toEqual(['keyword', 'ig_comment', 'ig_story_reply']);
  });

  it("ranks each trigger by its own tier, so one flow's story reply outranks another flow's keyword", () => {
    const a = { id: 'a', status: 'active', created_at: '2026-01-01' };
    const b = { id: 'b', status: 'active', created_at: '2026-02-01' };
    const ranked = byPrecedence([
      { flow: a, trigger_type: 'keyword' as const, created_at: a.created_at, status: 'active' as const },
      { flow: b, trigger_type: 'default_reply' as const, created_at: b.created_at, status: 'active' as const },
      { flow: b, trigger_type: 'ig_story_reply' as const, created_at: b.created_at, status: 'active' as const },
    ]);
    expect(ranked.map((r) => `${r.flow.id}:${r.trigger_type}`)).toEqual(['b:ig_story_reply', 'a:keyword', 'b:default_reply']);
  });

  it('never matches an intent keyword trigger by its words', async () => {
    expect(await keywordTriggerMatches('price', { keywords: ['price'], match_type: 'intent', intent: 'asks the price' })).toBe(false);
  });

  it('runs a draft only for its stored test usernames', () => {
    const draft = { status: 'draft' as const, test_usernames: ['shop.owner'] };
    expect(isTestUsername(draft, '@Shop.Owner ')).toBe(true);
    expect(isTestUsername(draft, 'someone')).toBe(false);
    expect(isTestUsername({ ...draft, status: 'active' as const }, 'shop.owner')).toBe(false);
    expect(isTestUsername(draft, '')).toBe(false);
    expect(normalizeTestUsername(null)).toBe('');
  });

  it('holds a comment run only for a whole number of seconds up to 10 minutes', () => {
    expect(commentReplyDelaySeconds({ reply_delay_seconds: 90 })).toBe(90);
    for (const bad of [0, -5, 601, 1.5, '30', undefined]) expect(commentReplyDelaySeconds({ reply_delay_seconds: bad })).toBe(0);
  });
});

describe('Actions step', () => {
  const run = (vars: Record<string, unknown> = {}) => ({
    id: '66666666-6666-4666-8666-666666666666', account_id: ACCOUNT, flow_id: FLOW, contact_id: '77777777-7777-4777-8777-777777777777',
    conversation_id: '88888888-8888-4888-8888-888888888888', user_id: 'u', vars, transition_seq: 1,
  }) as unknown as FlowRunRow;
  const ctx = (r: FlowRunRow): ActionsContext => ({ db: {} as never, run: r, nodeKey: 'act', channel: 'instagram', flowName: 'Welcome',
    interpolate: async (text) => text });
  const actions: FlowAction[] = [
    { type: 'add_tag', tag_id: TAG },
    { type: 'remove_tag', tag_id: TAG },
    { type: 'log_conversion', event_type_id: EVENT_TYPE },
  ];
  beforeEach(() => {
    h.executed = [];
    h.failAt = null;
    for (const fn of [h.addTag, h.removeTag, h.pause, h.conversion]) fn.mockClear();
  });

  it('runs the list in order, moving the cursor after each action, and clears it at the end', async () => {
    const r = run();
    const result = await runActions(ctx(r), actions);
    expect(result).toEqual({ skipped: [], ran: ['add_tag', 'remove_tag', 'log_conversion'], paused: false });
    expect(h.executed.filter((sql) => sql.includes('jsonb_build_object'))).toHaveLength(3);
    expect(r.vars[cursorVar('act')]).toBeUndefined();
  });

  it('resumes after a failure at the failed action and never repeats a finished one', async () => {
    const r = run();
    h.failAt = 'remove_tag';
    await expect(runActions(ctx(r), actions)).rejects.toThrow('connection reset');
    expect(r.vars[cursorVar('act')]).toBe(1);
    expect(h.addTag).toHaveBeenCalledTimes(1);
    h.failAt = null;
    const result = await runActions(ctx(r), actions);
    expect(result.ran).toEqual(['remove_tag', 'log_conversion']);
    expect(h.addTag).toHaveBeenCalledTimes(1);
    expect(h.removeTag).toHaveBeenCalledTimes(1);
    expect(h.conversion).toHaveBeenCalledWith(ACCOUNT, expect.objectContaining({ eventTypeId: EVENT_TYPE, nodeKey: 'act', runId: r.id }));
  });

  it('skips with a reason code an action that cannot apply, and never starts or stops its own flow', async () => {
    const r = run();
    const result = await runActions(ctx(r), [
      { type: 'start_flow', flow_id: FLOW }, { type: 'stop_flow', flow_id: FLOW }, { type: 'add_tag', tag_id: 'not-a-uuid' },
      { type: 'pause_automations', minutes: 45 as never }, { type: 'start_flow', flow_id: OTHER_FLOW },
    ]);
    expect(result.skipped.map((s) => s.reason)).toEqual(['flow_invalid', 'flow_invalid', 'tag_invalid', 'pause_invalid']);
    expect(queuedFlowStarts(r.vars)).toEqual([OTHER_FLOW]);
    expect(r.vars[START_AFTER_VAR]).toEqual([OTHER_FLOW]);
  });

  it('reports a pause so the run stops sending', async () => {
    const result = await runActions(ctx(run()), [{ type: 'pause_automations', minutes: 60 }]);
    expect(result.paused).toBe(true);
    expect(h.pause).toHaveBeenCalledWith(ACCOUNT, expect.objectContaining({ minutes: 60, byUserId: null }));
  });

  it('accepts only plausible phone numbers to store on a contact', () => {
    expect(flowPhoneDigits('+91 98765-43210')).toBe('919876543210');
    for (const bad of ['12345', '+0123456789', 'call me', '1'.repeat(16)]) expect(flowPhoneDigits(bad)).toBeNull();
  });
});
