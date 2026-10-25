import { describe, expect, it } from "vitest";
import { checkRunTimeout, markRunTimedOut } from "./timeout";
import { createFakeDb } from './fake-db.test-helper';
import type { databaseAdmin } from './admin-client';

const NOW = new Date("2026-10-16T12:00:00Z");

describe("checkRunTimeout", () => {
  it("uses the default 24h policy when the flow has none", () => {
    expect(checkRunTimeout("2026-10-15T12:00:01Z", null, NOW).timedOut).toBe(false);
    expect(checkRunTimeout("2026-10-15T12:00:00Z", null, NOW)).toEqual({
      timedOut: true,
      ageHours: 24,
      policyHours: 24,
    });
  });

  it("honours the flow's on_timeout_hours", () => {
    const policy = { on_timeout_hours: 2 };
    expect(checkRunTimeout("2026-10-16T10:30:00Z", policy, NOW).timedOut).toBe(false);
    expect(checkRunTimeout("2026-10-16T09:59:00Z", policy, NOW).timedOut).toBe(true);
  });

  it("never times out a run with an unparseable timestamp", () => {
    expect(checkRunTimeout("not a date", null, NOW).timedOut).toBe(false);
  });
});

it('does not time out a run advanced since the observed timeout snapshot', async () => {
  const snapshot = { id: 'run', last_advanced_at: '2026-10-15T10:00:00Z', transition_seq: 0 };
  const tables = { flow_runs: [{ ...snapshot, transition_seq: 1, last_advanced_at: NOW.toISOString(), status: 'active' }], flow_run_events: [] };
  const db = createFakeDb(tables) as unknown as ReturnType<typeof databaseAdmin>;
  expect(await markRunTimedOut(db, snapshot.id, checkRunTimeout(snapshot.last_advanced_at, null, NOW), 'test', NOW, snapshot)).toBe(false);
  expect(tables.flow_runs[0].status).toBe('active');
  expect(tables.flow_run_events).toHaveLength(0);
});

it('closes and logs a run only while the expired snapshot is still current', async () => {
  const snapshot = { id: 'run', last_advanced_at: '2026-10-15T10:00:00Z', transition_seq: 0 };
  const tables = { flow_runs: [{ ...snapshot, status: 'active' }], flow_run_events: [] };
  const db = createFakeDb(tables) as unknown as ReturnType<typeof databaseAdmin>;
  expect(await markRunTimedOut(db, snapshot.id, checkRunTimeout(snapshot.last_advanced_at, null, NOW), 'test', NOW, snapshot)).toBe(true);
  expect(tables.flow_runs[0].status).toBe('timed_out');
  expect(tables.flow_run_events).toHaveLength(1);
});
