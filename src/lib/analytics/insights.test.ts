import { beforeEach, describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';

import { parseRange } from './range';
import { AnalyticsInputError } from './queries';
import {
  attentionCounts, automationStats, emptyRow, fillRows, groupedMetrics, memberDetail, teamStats, timeBucket, timeKeys, trendReport,
} from './insights';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const NUMBER = '33333333-3333-4333-8333-333333333333';
const calls: { text: string; values: unknown[] }[] = [];
let respond: (text: string) => unknown[] = () => [];
const tx = {
  $queryRaw: async (sql: Prisma.Sql | TemplateStringsArray, ...values: unknown[]) => {
    const text = Array.isArray(sql) ? (sql as TemplateStringsArray).join('?') : (sql as Prisma.Sql).text;
    calls.push({ text, values: Array.isArray(sql) ? values : (sql as Prisma.Sql).values });
    return respond(text);
  },
} as never;
const NOW = new Date('2026-11-13T10:30:00Z');
const week = parseRange({ preset: '7d' }, 'Asia/Kolkata', NOW);
const today = parseRange({ preset: 'today' }, 'Asia/Kolkata', NOW);
const squash = (s: string) => s.replace(/\s+/g, ' ');
const last = () => calls[calls.length - 1];

beforeEach(() => {
  calls.length = 0;
  respond = () => [{ rows: [], report: { points: [], hours: [], channels: [], labels: [], spread: [], totals: [], names: [] } }];
});

/** Every account_id placeholder carries this workspace, and no message text is read. */
function expectScoped(text: string, values: unknown[]) {
  const sql = squash(text);
  const params = [...sql.matchAll(/account_id=\$(\d+)::uuid/g)].map((m) => Number(m[1]));
  expect(params.length).toBeGreaterThan(0);
  for (const n of params) expect(values[n - 1]).toBe(ACCOUNT);
  expect(sql).not.toMatch(/content_text|last_message_text|phone|email/);
}

describe('time buckets', () => {
  it('uses hours for one day (up to the current hour today), days up to 90 days and weeks beyond', () => {
    expect(timeBucket(today)).toBe('hour');
    expect(timeBucket(week)).toBe('day');
    expect(timeBucket(parseRange({ preset: 'custom', from: '2026-01-01', to: '2026-06-30' }, 'UTC', NOW))).toBe('week');
    // 10:30 UTC is 16:00 in Kolkata: hours 00 to 15 so far.
    const keys = timeKeys(today);
    expect(keys[0]).toBe('2026-11-13T00');
    expect(keys.at(-1)).toBe('2026-11-13T15');
    const pastDay = parseRange({ preset: 'custom', from: '2026-11-10', to: '2026-11-10' }, 'UTC', NOW);
    expect(timeKeys(pastDay)).toHaveLength(24);
    expect(timeKeys(week)).toHaveLength(7);
  });

  it('zero-fills missing keys in order', () => {
    const rows = fillRows(['a', 'b', 'c'], [{ ...emptyRow('b'), newC: 4 }]);
    expect(rows.map((r) => [r.key, r.newC])).toEqual([['a', 0], ['b', 4], ['c', 0]]);
  });
});

describe('grouped metrics SQL', () => {
  it('scopes every table to the workspace and the range, and credits members only when grouping by member', async () => {
    await groupedMetrics(tx, ACCOUNT, week, 'day');
    const plain = squash(last().text);
    expectScoped(last().text, last().values);
    expect(plain).toContain('FROM conversations c WHERE c.account_id=');
    expect(plain).toContain('FROM messages m JOIN scope s');
    expect(plain).not.toContain('human_first');
    expect(last().values).toContain(week.from.toISOString());
    expect(last().values).toContain(week.to.toISOString());
    await groupedMetrics(tx, ACCOUNT, week, 'agent');
    expect(squash(last().text)).toContain('human_first AS (');
  });

  it('applies the channel and number filters and refuses invalid ones', async () => {
    await groupedMetrics(tx, ACCOUNT, week, 'label', { channel: 'instagram', whatsappConfigId: NUMBER });
    const sql = squash(last().text);
    expect(sql).toContain('AND f.channel=$');
    expect(sql).toContain('c.whatsapp_config_id=$');
    expect(sql).toContain('LEFT JOIN conversation_label_links l ON l.account_id=$');
    expect(last().values).toEqual(expect.arrayContaining(['instagram', NUMBER]));
    await expect(groupedMetrics(tx, ACCOUNT, week, 'day', { channel: 'sms' as never })).rejects.toBeInstanceOf(AnalyticsInputError);
    await expect(groupedMetrics(tx, ACCOUNT, week, 'day', { whatsappConfigId: "x' OR 1=1" })).rejects.toBeInstanceOf(AnalyticsInputError);
    await expect(groupedMetrics(tx, ACCOUNT, week, 'day', {}, 'not-a-member')).rejects.toBeInstanceOf(AnalyticsInputError);
  });
});

describe('trend report', () => {
  it('shapes the hours, resolution spread, labels and channels from one statement', async () => {
    respond = () => [{ report: {
      points: [{ ...emptyRow('2026-11-10'), newC: 3 }],
      hours: [{ ...emptyRow('09'), newC: 5 }, { ...emptyRow('14'), newC: 2 }],
      channels: [{ ...emptyRow('instagram'), newC: 1 }],
      labels: [{ key: 'L1', newC: 2 }, { key: 'none', newC: 7 }],
      spread: [{ b: 0, n: 1 }, { b: 4, n: 2 }, { b: 2, n: 3 }],
      totals: [{ ...emptyRow('all'), newC: 9, closed: 4 }],
      names: [{ id: 'L1', name: 'VIP', color: 'red' }, { id: 'L2', name: 'Lead', color: 'blue' }],
    } }];
    const r = await trendReport(tx, ACCOUNT, week);
    expect(calls).toHaveLength(1);
    expectScoped(last().text, last().values);
    expect(r.bucket).toBe('day');
    expect(r.points).toHaveLength(7);
    expect(r.points.find((p) => p.key === '2026-11-10')?.newC).toBe(3);
    expect(r.hours[9]).toBe(5);
    expect(r.hours[14]).toBe(2);
    expect(r.hours.reduce((a, b) => a + b, 0)).toBe(7);
    expect(r.resolutionSpread).toEqual([1, 0, 3, 0, 2]);
    expect(r.channels.map((c) => [c.key, c.newC])).toEqual([['whatsapp', 0], ['instagram', 1]]);
    expect(r.labels).toEqual([
      { id: 'L1', name: 'VIP', color: 'red', newC: 2 }, { id: 'L2', name: 'Lead', color: 'blue', newC: 0 },
      { id: 'none', name: '', color: null, newC: 7 },
    ]);
    expect(r.totals.newC).toBe(9);
  });
});

describe('needs attention', () => {
  it('reads live counts for the workspace only, capped, without message text', async () => {
    respond = () => [{ counts: { unowned: 1, unread: 0, closingSoon: 0, needsTemplate: 0, failedToday: 2, switchedOff: 1, switchedOffNames: ['Welcome'] } }];
    const counts = await attentionCounts(tx, ACCOUNT, 'Asia/Kolkata', { channel: 'whatsapp' });
    expect(counts.failedToday).toBe(2);
    expectScoped(last().text, last().values);
    const sql = squash(last().text);
    expect(sql).toContain("c.status <> 'closed'");
    expect(sql).toContain('LIMIT $');
    expect(last().values).toContain(1000);
    expect(last().values).toContain('Asia/Kolkata');
  });
});

describe('team', () => {
  it('lists every member with zeros when idle and live presence', async () => {
    respond = (text) => (text.includes('FROM account_memberships am')
      ? [{ userId: MEMBER, name: 'Asha', role: 'agent', presence: 'online' }, { userId: NUMBER, name: null, role: 'viewer', presence: 'busy' }]
      : [{ rows: [{ ...emptyRow(MEMBER), resolved: 3, handled: 4 }] }]);
    const rows = await teamStats(tx, ACCOUNT, week);
    expect(rows).toEqual([
      expect.objectContaining({ userId: MEMBER, resolved: 3, handled: 4, presence: 'online' }),
      expect.objectContaining({ userId: NUMBER, resolved: 0, presence: 'offline' }),
    ]);
    for (const c of calls) expectScoped(c.text, c.values);
  });

  it('returns no detail for someone who is not a member of the workspace', async () => {
    respond = () => [];
    expect(await memberDetail(tx, ACCOUNT, week, MEMBER)).toBeNull();
    expect(calls).toHaveLength(1);
    expect(last().values).toEqual([ACCOUNT, MEMBER]);
  });

  it('filters one member\'s facts by member and zero-fills their series', async () => {
    respond = (text) => (text.includes('SELECT 1 AS ok') ? [{ ok: 1 }] : [{ detail: { points: [], channels: [], totals: [] } }]);
    const d = await memberDetail(tx, ACCOUNT, week, MEMBER);
    expect(d?.points).toHaveLength(7);
    expect(d?.channels.map((c) => c.key)).toEqual(['whatsapp', 'instagram']);
    expect(squash(last().text)).toContain('AND f.member=$');
    expect(last().values).toContain(MEMBER);
  });
});

describe('automations', () => {
  it('counts flow runs, rule executions and sequence sends in the range, scoped to the workspace', async () => {
    respond = () => [{ stats: {
      top: [{ id: 'f1', name: 'Welcome', kind: 'flow', channel: 'any', live: true, runs: 9, clickRate: 40 }],
      kinds: [{ kind: 'flow', runs: 9 }, { kind: 'rule', runs: 3 }],
    } }];
    const s = await automationStats(tx, ACCOUNT, week, { channel: 'instagram' });
    expect(s.byKind).toEqual({ flow: 9, rule: 3, sequence: 0 });
    expect(s.total).toBe(12);
    expectScoped(last().text, last().values);
    const sql = squash(last().text);
    for (const table of ['flow_runs r', 'flow_tracked_links l', 'automation_logs', 'sequence_message_sends'])
      expect(sql).toContain(`FROM ${table}`);
    expect(sql).toContain("WHERE x.channel IN ($");
    expect(sql).not.toContain('token');
  });
});
