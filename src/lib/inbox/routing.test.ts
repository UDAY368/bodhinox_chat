import { describe, expect, it } from 'vitest';
import {
  MAX_KEYWORDS,
  nextReassignee,
  parseAssignTo,
  parseConditions,
  parseReassignPayload,
  parseRoutingRuleInput,
  parseRuleOrder,
  pickAssignee,
  RoutingRuleError,
  ruleMatches,
  type AssignTo,
} from './routing';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';
const TAG = '00000000-0000-4000-8000-0000000000aa';
const NUMBER = '00000000-0000-4000-8000-0000000000bb';
const robin: AssignTo = { mode: 'round_robin', user_ids: [A, B, C] };

const code = (fn: () => unknown) => {
  try { fn(); } catch (error) { return error instanceof RoutingRuleError ? error.code : 'other'; }
  return null;
};

describe('parseConditions', () => {
  it('normalises keywords, drops empties and lower-cases ids', () => {
    expect(parseConditions({ keywords_any: ['  Refund ', 'refund', ''], tags_any: [TAG.toUpperCase()], whatsapp_config_id: NUMBER, within_working_hours: false }))
      .toEqual({ keywords_any: ['refund'], tags_any: [TAG], whatsapp_config_id: NUMBER, within_working_hours: false });
    expect(parseConditions(undefined)).toEqual({});
  });
  it.each([
    [{ unknown: 1 }], [[]], [{ tags_any: ['nope'] }], [{ keywords_any: [1] }], [{ keywords_any: ['x'.repeat(61)] }],
    [{ keywords_any: Array.from({ length: MAX_KEYWORDS + 1 }, (_, i) => `k${i}`) }], [{ within_working_hours: 'yes' }], [{ whatsapp_config_id: 'x' }],
  ])('rejects %j', (value) => expect(parseConditions(value)).toBeNull());
});

describe('parseAssignTo', () => {
  it('accepts a member or a non-empty round robin', () => {
    expect(parseAssignTo({ mode: 'member', user_id: A })).toEqual({ mode: 'member', user_id: A });
    expect(parseAssignTo({ mode: 'round_robin', user_ids: [A, A, B] })).toEqual({ mode: 'round_robin', user_ids: [A, B] });
  });
  it.each([[null], [{ mode: 'member' }], [{ mode: 'round_robin', user_ids: [] }], [{ mode: 'team', user_ids: [A] }]])('rejects %j', (value) =>
    expect(parseAssignTo(value)).toBeNull());
});

describe('parseRoutingRuleInput', () => {
  const valid = { name: ' Sales ', conditions: {}, assign_to: { mode: 'member', user_id: A } };
  it('defaults enabled and reassignment', () => {
    expect(parseRoutingRuleInput(valid)).toEqual({ name: 'Sales', enabled: true, conditions: {}, assign_to: { mode: 'member', user_id: A }, reassign_after_minutes: null });
  });
  it.each([
    [{ ...valid, name: '' }, 'invalid_name'],
    [{ ...valid, name: 'x'.repeat(121) }, 'invalid_name'],
    [{ ...valid, conditions: { bad: true } }, 'invalid_conditions'],
    [{ ...valid, assign_to: {} }, 'invalid_assignee'],
    [{ ...valid, reassign_after_minutes: 0 }, 'invalid_reassign'],
    [{ ...valid, reassign_after_minutes: 1.5 }, 'invalid_reassign'],
    [{ ...valid, reassign_after_minutes: 10081 }, 'invalid_reassign'],
    [null, 'invalid_name'],
  ])('rejects %j with %s', (body, expected) => expect(code(() => parseRoutingRuleInput(body))).toBe(expected));
});

describe('ruleMatches', () => {
  const context = { tagIds: new Set([TAG]), text: 'I want a REFUND please', whatsappConfigId: NUMBER, withinWorkingHours: true };
  it('matches when every present condition holds', () => {
    expect(ruleMatches({}, context)).toBe(true);
    expect(ruleMatches({ tags_any: [TAG], keywords_any: ['refund'], whatsapp_config_id: NUMBER, within_working_hours: true }, context)).toBe(true);
  });
  it.each([
    [{ tags_any: [A] }], [{ keywords_any: ['invoice'] }], [{ whatsapp_config_id: A }], [{ within_working_hours: false }],
  ])('fails on %j', (conditions) => expect(ruleMatches(conditions, context)).toBe(false));
  it('treats a conversation without a number as not matching a number condition', () =>
    expect(ruleMatches({ whatsapp_config_id: NUMBER }, { ...context, whatsappConfigId: null })).toBe(false));
  it('matches a channel condition only on that channel, and never when the channel is unknown', () => {
    expect(ruleMatches({ channel: 'instagram' }, { ...context, whatsappConfigId: null, channel: 'instagram' })).toBe(true);
    expect(ruleMatches({ channel: 'whatsapp' }, { ...context, whatsappConfigId: null, channel: 'instagram' })).toBe(false);
    expect(ruleMatches({ channel: 'whatsapp' }, { ...context, channel: 'whatsapp' })).toBe(true);
    expect(ruleMatches({ channel: 'whatsapp' }, context)).toBe(false);
    expect(ruleMatches({}, { ...context, channel: 'instagram' })).toBe(true);
  });
  it('an Instagram conversation never matches a WhatsApp number condition', () =>
    expect(ruleMatches({ whatsapp_config_id: NUMBER }, { ...context, whatsappConfigId: null, channel: 'instagram' })).toBe(false));
});

describe('parseConditions channel', () => {
  it('accepts whatsapp or instagram and rejects anything else', () => {
    expect(parseConditions({ channel: 'instagram' })).toEqual({ channel: 'instagram' });
    expect(parseConditions({ channel: 'whatsapp' })).toEqual({ channel: 'whatsapp' });
    expect(parseConditions({ channel: null })).toEqual({});
    expect(parseConditions({ channel: 'sms' })).toBeNull();
    expect(parseConditions({ channel: 1 })).toBeNull();
  });
});

describe('pickAssignee', () => {
  const all = new Set([A, B, C]);
  it('rotates after the last member and wraps', () => {
    expect(pickAssignee(robin, all, null)).toBe(A);
    expect(pickAssignee(robin, all, A)).toBe(B);
    expect(pickAssignee(robin, all, C)).toBe(A);
  });
  it('skips members who are no longer eligible, and a removed cursor restarts', () => {
    expect(pickAssignee(robin, new Set([A, C]), A)).toBe(C);
    expect(pickAssignee(robin, all, '00000000-0000-4000-8000-0000000000ff')).toBe(A);
    expect(pickAssignee(robin, new Set(), A)).toBeNull();
  });
  it('gives a member rule to that member only while eligible', () => {
    expect(pickAssignee({ mode: 'member', user_id: B }, all, null)).toBe(B);
    expect(pickAssignee({ mode: 'member', user_id: B }, new Set([A]), null)).toBeNull();
  });
});

describe('nextReassignee', () => {
  it('moves to the next eligible member, never the current one', () => {
    expect(nextReassignee(robin, new Set([A, B, C]), A)).toBe(B);
    expect(nextReassignee(robin, new Set([A, C]), C)).toBe(A);
    expect(nextReassignee(robin, new Set([A]), A)).toBeNull();
    expect(nextReassignee({ mode: 'member', user_id: A }, new Set([A]), A)).toBeNull();
  });
});

describe('parseRuleOrder', () => {
  it('accepts distinct ids and rejects duplicates or junk', () => {
    expect(parseRuleOrder({ ids: [A, B] })).toEqual([A, B]);
    expect(code(() => parseRuleOrder({ ids: [A, A] }))).toBe('invalid_order');
    expect(code(() => parseRuleOrder({ ids: [] }))).toBe('invalid_order');
    expect(code(() => parseRuleOrder({ ids: ['x'] }))).toBe('invalid_order');
  });
});

describe('parseReassignPayload', () => {
  it('validates the job contract', () => {
    const assignedAt = '2026-11-02T10:00:00.123Z';
    expect(parseReassignPayload({ conversationId: A, ruleId: B, assignee: C, cycle: 0, attempt: 2, assignedAt }))
      .toEqual({ conversationId: A, ruleId: B, assignee: C, cycle: 0, attempt: 2, assignedAt });
    expect(() => parseReassignPayload({ conversationId: A, ruleId: B, assignee: C, cycle: -1, attempt: 0, assignedAt })).toThrow();
    expect(() => parseReassignPayload({ conversationId: 'x', ruleId: B, assignee: C, cycle: 0, attempt: 0, assignedAt })).toThrow();
    // The assignment time decides which replies answer it, so it is required and must be a date.
    expect(() => parseReassignPayload({ conversationId: A, ruleId: B, assignee: C, cycle: 0, attempt: 0 })).toThrow();
    expect(() => parseReassignPayload({ conversationId: A, ruleId: B, assignee: C, cycle: 0, attempt: 0, assignedAt: 'soon' })).toThrow();
    expect(() => parseReassignPayload({ conversationId: A, ruleId: B, assignee: C, cycle: 0, attempt: 0, assignedAt: 1 })).toThrow();
  });
});

describe('team targets', () => {
  const TEAM = '44444444-4444-4444-8444-444444444444';
  it('parses a team target and names no members until resolved', async () => {
    const { parseAssignTo, ruleMembers, pickAssignee, resolveAssignTo } = await import('./routing');
    const team = parseAssignTo({ mode: 'team', team_id: TEAM.toUpperCase() });
    expect(team).toEqual({ mode: 'team', team_id: TEAM });
    expect(parseAssignTo({ mode: 'team', team_id: 'sales' })).toBeNull();
    expect(ruleMembers(team!)).toEqual([]);
    expect(pickAssignee(team!, new Set(['x']), null)).toBeNull();
    const ids = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
    const tx = { $queryRaw: async () => ids.map((user_id) => ({ user_id })) };
    const resolved = await resolveAssignTo(tx as never, TEAM, team!);
    expect(resolved).toEqual({ mode: 'round_robin', user_ids: ids });
    expect(pickAssignee(resolved, new Set(ids), ids[0])).toBe(ids[1]);
    const member = { mode: 'member' as const, user_id: ids[0] };
    expect(await resolveAssignTo(tx as never, TEAM, member)).toBe(member);
  });
});
