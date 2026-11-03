import { describe, expect, it } from 'vitest';
import type { TenantTransaction } from '@/lib/db/tenant';
import { planReminders, scheduleReminders, enqueueHoldExpiry } from './schedule-jobs';

const ACCOUNT = '00000000-0000-4000-8000-000000000001';
const ID = '00000000-0000-4000-8000-0000000000aa';
const HOUR = 3_600_000;

/** Records each raw statement and its values (tagged-template calls). */
function fakeTx() {
  const calls: { sql: string; values: unknown[] }[] = [];
  const tx = {
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ sql: strings.join('?'), values });
      return Promise.resolve(1);
    },
  } as unknown as TenantTransaction;
  return { tx, calls };
}

describe('planReminders', () => {
  const now = new Date('2026-11-09T00:00:00Z');
  const at = (ms: number) => new Date(now.getTime() + ms);
  const skipped = (start: Date) => planReminders(start, now).map((p) => [p.kind, p.skipped]);

  it('30h ahead: both reminders', () => expect(skipped(at(30 * HOUR))).toEqual([['24h', null], ['2h', null]]));
  it('10h ahead: the 2h reminder only', () => expect(skipped(at(10 * HOUR))).toEqual([['24h', 'past_due_24h'], ['2h', null]]));
  it('2h10m ahead: the 2h reminder only', () => expect(skipped(at(2 * HOUR + 10 * 60_000))).toEqual([['24h', 'past_due_24h'], ['2h', null]]));
  it('90m ahead: none', () => expect(skipped(at(90 * 60_000))).toEqual([['24h', 'past_due_24h'], ['2h', 'past_due_2h']]));

  it('uses absolute time: a 24h reminder across a DST change is exactly 86 400 000 ms before', () => {
    const start = new Date('2026-11-02T14:00:00Z'); // the day after New York leaves DST
    const plan = planReminders(start, new Date('2026-10-30T00:00:00Z'));
    expect(start.getTime() - plan[0].runAt.getTime()).toBe(86_400_000);
    expect(start.getTime() - plan[1].runAt.getTime()).toBe(2 * HOUR);
  });
});

describe('scheduleReminders', () => {
  it('queues versioned reminder jobs and records skipped ones as events', async () => {
    const { tx, calls } = fakeTx();
    const now = new Date('2026-11-09T00:00:00Z');
    await scheduleReminders(tx, ACCOUNT, { id: ID, version: 3, start_at: new Date(now.getTime() + 10 * HOUR) }, now);
    expect(calls).toHaveLength(2);
    expect(calls[0].sql).toContain('INSERT INTO appointment_events');
    expect(calls[0].values).toContain('past_due_24h');
    expect(calls[1].sql).toContain('INSERT INTO jobs');
    expect(calls[1].sql).toContain('ON CONFLICT(dedupe_key) DO NOTHING');
    expect(calls[1].values).toEqual(['appointments.reminder', ACCOUNT, JSON.stringify({ appointmentId: ID, version: 3, kind: '2h' }),
      `appt-rem:${ID}:v3:2h`, new Date(now.getTime() + 8 * HOUR)]);
  });

  it('runs the hold expiry five minutes after the hold ends', async () => {
    const { tx, calls } = fakeTx();
    const until = new Date('2026-11-09T10:15:00Z');
    await enqueueHoldExpiry(tx, ACCOUNT, ID, 1, until);
    expect(calls[0].values).toEqual(['appointments.hold_expire', ACCOUNT, JSON.stringify({ appointmentId: ID, version: 1 }),
      `appt-hold:${ID}:v1`, new Date('2026-11-09T10:20:00Z')]);
  });
});
