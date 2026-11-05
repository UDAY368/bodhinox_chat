import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/prisma', () => ({
  getPrisma: vi.fn(), getPlatformPrisma: vi.fn(), platformDatabaseConfigured: vi.fn(() => false),
  getWorkerPrisma: () => { throw new Error('no database in unit tests'); },
}));

import { alertWebhookUrl, createOpsAlerter } from './alerts';
import type { OpsHealthRow } from './health';

const healthy: OpsHealthRow = { lastBeatAgeS: 5, pendingDue: 0, oldestDueAgeS: null, expiredRunningLeases: 0, failedJobs1h: 0,
  unknownIntents: 0, unprocessedWebhooks15m: 0, latestMigration: '20261113090100_ops_health_fn' };
const URL_ = 'https://alerts.example.com/hook/abc';

function harness(rows: Array<OpsHealthRow | Error>, response = { ok: true }) {
  let clock = 0;
  const sent: Record<string, unknown>[] = [];
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => { sent.push(JSON.parse(String(init?.body))); return response as Response; });
  const read = vi.fn(async () => { const next = rows.length > 1 ? rows.shift()! : rows[0]; if (next instanceof Error) throw next; return next; });
  const logs: string[] = [];
  const alerter = createOpsAlerter({ url: URL_, read, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => clock, log: (m) => logs.push(m) });
  return { alerter, sent, read, fetchImpl, logs, advance: (ms: number) => { clock += ms; } };
}

describe('[OPS-01] ops alert hook', () => {
  it('accepts https URLs (http only on loopback) and nothing else', () => {
    expect(alertWebhookUrl(URL_)?.href).toBe(URL_);
    expect(alertWebhookUrl('http://127.0.0.1:9000/x')).not.toBeNull();
    expect(alertWebhookUrl('http://alerts.example.com/x')).toBeNull();
    expect(alertWebhookUrl('file:///etc/passwd')).toBeNull();
    expect(alertWebhookUrl('not a url')).toBeNull();
    expect(alertWebhookUrl(undefined)).toBeNull();
  });

  it('is a no-op without a URL: no database read, no request', async () => {
    const read = vi.fn();
    const fetchImpl = vi.fn();
    const alerter = createOpsAlerter({ url: '', read, fetchImpl });
    expect(alerter.enabled).toBe(false);
    expect(await alerter.tick()).toBe('disabled');
    expect(read).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends on state change only, at most once a minute, and repeats every 15 minutes while down', async () => {
    const h = harness([healthy, { ...healthy, lastBeatAgeS: 500 }]);
    expect(await h.alerter.tick()).toBe('unchanged'); // healthy start is not news
    expect(await h.alerter.tick()).toBe('skipped');   // within 60 s
    h.advance(60_000);
    expect(await h.alerter.tick()).toBe('sent');
    expect(h.sent[0]).toMatchObject({ source: 'bodhinox-worker', status: 'down', previous: 'ok', failing: ['worker'] });
    for (let i = 0; i < 14; i++) { h.advance(60_000); expect(await h.alerter.tick()).toBe('unchanged'); }
    h.advance(60_000);
    expect(await h.alerter.tick()).toBe('sent'); // 15-minute repeat while down
    expect(h.sent).toHaveLength(2);
  });

  it('reports recovery, and the payload carries check names and numbers only', async () => {
    const degraded = { ...healthy, oldestDueAgeS: 900, pendingDue: 12, unknownIntents: 2 };
    const h = harness([degraded, degraded, healthy, healthy]);
    expect(await h.alerter.tick()).toBe('held'); // a non-down change waits for a second check
    h.advance(60_000);
    expect(await h.alerter.tick()).toBe('sent');
    h.advance(60_000);
    expect(await h.alerter.tick()).toBe('held');
    h.advance(60_000);
    expect(await h.alerter.tick()).toBe('sent');
    expect(h.sent.map((p) => [p.previous, p.status])).toEqual([['ok', 'degraded'], ['degraded', 'ok']]);
    const first = h.sent[0];
    expect(first.failing).toEqual(['queue', 'intents']);
    expect(Object.keys(first).sort()).toEqual(['at', 'failing', 'numbers', 'previous', 'source', 'status', 'text']);
    expect(Object.values(first.numbers as Record<string, unknown>).every((v) => v === null || typeof v === 'number')).toBe(true);
    expect(JSON.stringify(h.sent)).not.toMatch(/20261113|migration|postgres|https?:/);
  });

  it('an unreadable ops query alerts as degraded; a failed delivery is retried next check and logs no URL', async () => {
    const h = harness([new Error('connect ECONNREFUSED postgresql://u:p@db')], { ok: false });
    expect(await h.alerter.tick()).toBe('held');
    h.advance(60_000);
    expect(await h.alerter.tick()).toBe('failed');
    expect(h.logs).toEqual(['[ops] alert delivery failed']);
    h.advance(60_000);
    expect(await h.alerter.tick()).toBe('failed');
    expect(h.fetchImpl).toHaveBeenCalledTimes(2); // the held status stays confirmed, so each later check retries
    expect(h.sent[0]).toMatchObject({ status: 'degraded', failing: ['ops'] });
    expect(JSON.stringify(h.sent)).not.toMatch(/ECONNREFUSED|postgresql/);
    const init = h.fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('a status hovering at the threshold does not flap: one-check blips are never sent', async () => {
    const degraded = { ...healthy, oldestDueAgeS: 301, pendingDue: 5 };
    const h = harness([degraded, healthy, degraded, healthy, degraded, healthy]);
    for (let i = 0; i < 6; i++) { expect(['held', 'unchanged']).toContain(await h.alerter.tick()); h.advance(60_000); }
    expect(h.sent).toHaveLength(0);
  });

  it('webhook receipts unprocessed after 15 minutes are a failing check', async () => {
    const stuck = { ...healthy, unprocessedWebhooks15m: 3 };
    const h = harness([stuck, stuck]);
    expect(await h.alerter.tick()).toBe('held');
    h.advance(60_000);
    expect(await h.alerter.tick()).toBe('sent');
    expect(h.sent[0]).toMatchObject({ status: 'degraded', failing: ['webhooks'] });
  });
});
