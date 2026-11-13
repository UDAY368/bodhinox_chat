import { describe, expect, it } from 'vitest';
import {
  automationItems, canSwitch, displayStatus, itemMatches, kindCounts, listProblems, problemCount, ruleItem, sequenceItem, statusAfterSwitch,
  type FlowRow, type ItemFilters, type RuleRow, type SequenceRow,
} from './automation-items';

const flow = (over: Partial<FlowRow> = {}): FlowRow => ({
  id: 'f1', user_id: 'u1', name: 'Welcome menu', description: null, status: 'active', trigger_type: 'keyword',
  trigger_config: { keywords: ['hi'] }, execution_count: 12, last_executed_at: null, channel_scope: 'whatsapp',
  ctr: 40, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-03-01T00:00:00Z', ...over,
});
const rule = (over: Partial<RuleRow> = {}): RuleRow => ({
  id: 'r1', user_id: 'u1', name: 'Out of office', trigger_type: 'keyword_match', trigger_config: { keywords: ['hours'] },
  channel: 'instagram', is_active: false, execution_count: 0, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-02-01T00:00:00Z', ...over,
});
const sequence = (over: Partial<SequenceRow> = {}): SequenceRow => ({
  id: 's1', name: 'Nurture', status: 'active', subscribers: 7, messages: 3, created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-04-01T00:00:00Z', ...over,
});
const ALL: ItemFilters = { kind: 'all', status: 'all', trigger: 'all', folder: 'all', channel: 'all', query: '' };

describe('automationItems', () => {
  it('lists flows, rules and sequences as one list, newest edit first', () => {
    const items = automationItems([flow()], [rule()], [sequence()]);
    expect(items.map((i) => i.key)).toEqual(['sequence:s1', 'flow:f1', 'rule:r1']);
    expect(kindCounts(items)).toEqual({ all: 3, flow: 1, rule: 1, sequence: 1 });
  });

  it('maps each kind to one status vocabulary', () => {
    expect(displayStatus({ status: 'draft', test_numbers: ['+1555'] })).toBe('testing');
    expect(ruleItem(rule({ is_active: true })).status).toBe('active');
    expect(ruleItem(rule({ execution_count: 4 })).status).toBe('paused');
    expect(ruleItem(rule()).status).toBe('draft');
    expect(sequenceItem(sequence({ status: 'paused' })).status).toBe('paused');
    // A rule from before channels is WhatsApp's; a sequence is always Instagram's.
    expect(ruleItem(rule({ channel: null })).channel).toBe('whatsapp');
    expect(sequenceItem(sequence()).channel).toBe('instagram');
  });
});

describe('itemMatches', () => {
  const items = automationItems([flow(), flow({ id: 'f2', name: 'Story flow', channel_scope: 'any', status: 'draft', trigger_config: { keywords: ['look'] } })], [rule()], [sequence()]);
  const keys = (filters: Partial<ItemFilters>) => items.filter((i) => itemMatches(i, { ...ALL, ...filters })).map((i) => i.key);

  it('filters by tab, status and channel (a legacy flow on both channels shows under either)', () => {
    expect(keys({ kind: 'rule' })).toEqual(['rule:r1']);
    expect(keys({ kind: 'sequence' })).toEqual(['sequence:s1']);
    expect(keys({ status: 'draft' }).sort()).toEqual(['flow:f2', 'rule:r1']);
    expect(keys({ channel: 'instagram' }).sort()).toEqual(['flow:f2', 'rule:r1', 'sequence:s1']);
  });

  it('searches names and trigger words of every kind', () => {
    expect(keys({ query: 'hours' })).toEqual(['rule:r1']);
    expect(keys({ query: 'HI' })).toEqual(['flow:f1']);
    expect(keys({ query: 'nurture' })).toEqual(['sequence:s1']);
  });

  it('keeps only flows with that trigger while a trigger is chosen', () => {
    expect(keys({ trigger: 'keyword' }).sort()).toEqual(['flow:f1', 'flow:f2']);
  });
});

describe('the Live switch rules', () => {
  it('refuses an archived row and a sequence with nothing to send', () => {
    expect(canSwitch(automationItems([flow({ status: 'archived' })], [], [])[0])).toBe(false);
    expect(listProblems(sequenceItem(sequence({ messages: 0 })))).toBe(1);
    expect(listProblems(sequenceItem(sequence()))).toBe(0);
  });

  it('takes the server status when given, else on or off', () => {
    const item = automationItems([flow({ status: 'paused', test_numbers: ['+1'] })], [], [])[0];
    expect(statusAfterSwitch(item, true, 'active')).toBe('active');
    expect(statusAfterSwitch(item, false, 'draft')).toBe('testing');
    expect(statusAfterSwitch(ruleItem(rule()), true)).toBe('active');
  });

  it('counts the errors in a refusal, not its warnings', () => {
    expect(problemCount({ issues: [{ severity: 'error' }, { severity: 'warning' }, {}] })).toBe(2);
    expect(problemCount({ error: 'nope' })).toBe(0);
    expect(problemCount(null)).toBe(0);
  });
});
