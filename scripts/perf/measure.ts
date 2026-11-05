// Measures the pilot-volume targets (design section 2.1) against the database scripts/perf/seed.ts
// built. Local Docker only (scripts/perf/perf-env.ts refuses anything else).
//
//   npm run perf:measure -- [--profile pilot|stress] [--runs 200] [--warmups 20] [--out docs/testing]
//
// Each measure runs through the application's own code as the constrained role it uses in production
// (browser data gateway executeQuery as bodhinox_app inside withTenant, analytics through runAnalytics,
// the inbound webhook through persistWebhook + the whatsapp.webhook job handler as bodhinox_worker):
// warm-ups first, then timed runs; p50 / p95 / max. Each SQL-level measure also records the tables it
// sequentially scanned (pg_stat_user_tables deltas) and one EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) of
// an equivalent statement run as bodhinox_app under the same tenant settings. Writes
// docs/testing/perf-<date>.json and .md with environment metadata and exits 1 when a pilot target is
// missed (stress misses are informational and never fail). Synthetic data only; nothing is sent.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { applyPerfEnv } from './perf-env';

const root = path.resolve(__dirname, '..', '..');
const urls = applyPerfEnv(root); // before any application module is loaded

const argv = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
};
const profile = opt('profile', 'pilot');
if (profile !== 'pilot' && profile !== 'stress') throw new Error('--profile must be pilot or stress');
const RUNS = Number(opt('runs', '200'));
const WARMUPS = Number(opt('warmups', '20'));
const OUT_DIR = path.resolve(root, opt('out', 'docs/testing'));

/** Same derivation as seed.ts pg_temp.pid(): md5 shaped as an RFC 4122 v4 UUID. */
function pid(text: string): string {
  const h = createHash('md5').update(text).digest('hex');
  const u = `${h.slice(0, 12)}4${h.slice(13, 16)}8${h.slice(17, 32)}`;
  return `${u.slice(0, 8)}-${u.slice(8, 12)}-${u.slice(12, 16)}-${u.slice(16, 20)}-${u.slice(20)}`;
}
const TENANT = 'perf-tenant-1';
const accountId = pid(TENANT);
const ownerUser = pid(`${TENANT}-user-1`);

interface Stat { runs: number; p50Ms: number; p95Ms: number; maxMs: number }
interface Result {
  id: string; label: string; how: string; targetMs: number | null; aimMs?: number; stat: Stat | null; pass: boolean | null;
  seqScans?: Record<string, number>; explain?: { statement: string; planTop: string; seqScanTables: string[]; executionMs: number } | null;
  note?: string; rowsPerRun?: number;
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}
function stat(times: number[]): Stat {
  const s = [...times].sort((a, b) => a - b);
  const r = (n: number) => Math.round(n * 10) / 10;
  return { runs: s.length, p50Ms: r(percentile(s, 50)), p95Ms: r(percentile(s, 95)), maxMs: r(s[s.length - 1]) };
}
async function time(fn: () => Promise<unknown>, runs = RUNS, warmups = WARMUPS): Promise<{ stat: Stat; last: unknown }> {
  let last: unknown;
  for (let i = 0; i < warmups; i++) last = await fn();
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    last = await fn();
    times.push(performance.now() - t);
  }
  return { stat: stat(times), last };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const owner = new pg.Client({ connectionString: urls.MIGRATION_DATABASE_URL });
  await owner.connect();
  const { buildQuery } = await import('../../src/lib/data/builder');
  const { executeQuery } = await import('../../src/lib/repositories/crm');
  const { loadInboxConversations } = await import('../../src/lib/inbox/conversations');
  const { withTenant } = await import('../../src/lib/db/tenant');
  const { listSchedule } = await import('../../src/lib/appointments/listing');
  const { runAnalytics, conversationStats } = await import('../../src/lib/analytics/queries');
  const { parseRange } = await import('../../src/lib/analytics/range');
  const { previousRange } = await import('../../src/lib/analytics/http');
  const { persistWebhook, finishJob } = await import('../../src/lib/jobs/queue');
  const { handleJob } = await import('../../src/lib/jobs/handlers');
  const { disconnectDatabases, getWorkerPrisma } = await import('../../src/lib/db/prisma');
  type DataClient = import('../../src/lib/data/types').DataClient;
  type Job = import('../../src/lib/jobs/queue').Job;

  const ctx = { accountId, userId: ownerUser, role: 'owner' as const };
  // The browser data gateway as /api/crm/[resource] runs it (browser=true: same allowlist and stripping).
  const browser = { from: (resource: string) => buildQuery(resource, (spec) => executeQuery(spec, ctx, true)) } as unknown as DataClient;

  const tables = ['contacts', 'conversations', 'messages', 'contact_tags', 'tags', 'appointments', 'whatsapp_config', 'jobs', 'webhook_receipts'];
  const seqScans = async () => Object.fromEntries((await owner.query<{ t: string; n: string }>(
    'SELECT relname AS t, seq_scan::text AS n FROM pg_stat_user_tables WHERE relname = ANY($1)', [tables])).rows.map((r) => [r.t, Number(r.n)]));
  const delta = (before: Record<string, number>, after: Record<string, number>) =>
    Object.fromEntries(Object.keys(after).filter((t) => after[t] - (before[t] ?? 0) > 0).map((t) => [t, after[t] - (before[t] ?? 0)]));
  /** EXPLAIN ANALYZE as bodhinox_app under the tenant's settings (RLS applies as in production). */
  async function explain(statement: string, params: unknown[]): Promise<Result['explain']> {
    await owner.query('BEGIN');
    try {
      await owner.query("SELECT set_config('app.account_id',$1,true), set_config('app.user_id',$2,true), set_config('app.account_role','owner',true)", [accountId, ownerUser]);
      await owner.query('SET LOCAL ROLE bodhinox_app');
      const plan = (await owner.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`, params)).rows[0]['QUERY PLAN'][0];
      const seq: string[] = [];
      const walk = (n: Record<string, unknown>) => {
        if (n['Node Type'] === 'Seq Scan') seq.push(String(n['Relation Name']));
        for (const child of (n.Plans as Record<string, unknown>[] | undefined) ?? []) walk(child);
      };
      walk(plan.Plan);
      return { statement: statement.replace(/\s+/g, ' ').trim(), planTop: String(plan.Plan['Node Type']), seqScanTables: [...new Set(seq)],
        executionMs: Math.round(plan['Execution Time'] * 10) / 10 };
    } finally { await owner.query('ROLLBACK'); }
  }
  async function measure(r: Omit<Result, 'stat' | 'pass' | 'seqScans'>, fn: () => Promise<unknown>, runs = RUNS, warmups = WARMUPS): Promise<Result> {
    const before = await seqScans();
    const { stat: s, last } = await time(fn, runs, warmups);
    await sleep(1500); // other backends flush their table statistics within about a second
    const scans = delta(before, await seqScans());
    const rowsPerRun = Array.isArray(last) ? last.length : (last as { data?: unknown[] } | undefined)?.data?.length;
    const pass = r.targetMs === null ? null : s.p95Ms <= r.targetMs;
    console.log(`${r.id}: p50 ${s.p50Ms} ms, p95 ${s.p95Ms} ms, max ${s.maxMs} ms (${s.runs} runs) ${pass === null ? '' : pass ? 'PASS' : 'MISS'}`);
    return { ...r, stat: s, pass, seqScans: scans, ...(rowsPerRun !== undefined ? { rowsPerRun } : {}) };
  }

  const results: Result[] = [];
  const now = new Date();

  // 1. Inbox load as the app does it today: every conversation, with contact + tags embedded, 1000 per page.
  results.push(await measure({ id: 'inbox_load', label: 'Inbox load (all conversations, contact + tags embed)', targetMs: 1500,
    how: 'loadInboxConversations through executeQuery(browser=true) as bodhinox_app',
    explain: await explain(`SELECT c.*, to_jsonb(ct) AS contact FROM conversations c LEFT JOIN contacts ct ON ct.id = c.contact_id
      WHERE c.account_id = $1 ORDER BY c.last_message_at DESC NULLS LAST, c.id LIMIT 1000 OFFSET 4000`, [accountId]),
  }, async () => {
    const { data, error } = await loadInboxConversations(browser);
    if (error) throw new Error(error.message);
    return data;
  }));

  // 2. Contact search, 3 characters, as the contacts page sends it (page of 25 with exact count).
  const search = () => browser.from('contacts').select('*', { count: 'exact' }).order('created_at', { ascending: false }).range(0, 24)
    .or('name.ilike.%kum%,phone.ilike.%kum%,email.ilike.%kum%');
  results.push(await measure({ id: 'contact_search', label: 'Contact search (3 characters)', targetMs: 300,
    how: 'contacts page query (or name/phone/email ilike, exact count, 25 rows) through executeQuery(browser=true)',
    explain: await explain(`SELECT * FROM contacts WHERE account_id = $1 AND (name ILIKE '%kum%' OR phone ILIKE '%kum%' OR email ILIKE '%kum%')
      ORDER BY created_at DESC LIMIT 25`, [accountId]),
  }, async () => { const r = await search(); if (r.error) throw new Error(r.error.message); return r.data; }));

  // 3. CRM route work: the contacts list page the CRM data gateway serves (no search term).
  results.push(await measure({ id: 'crm_contacts_page', label: 'CRM route: contacts list page', targetMs: 2000, aimMs: 500,
    how: 'the /api/crm/[resource] query (contacts, exact count, 25 rows) through executeQuery(browser=true); handler session and HTTP not included',
    explain: await explain('SELECT * FROM contacts WHERE account_id = $1 ORDER BY created_at DESC LIMIT 25', [accountId]),
  }, async () => {
    const r = await browser.from('contacts').select('*', { count: 'exact' }).order('created_at', { ascending: false }).range(0, 24);
    if (r.error) throw new Error(r.error.message);
    return r.data;
  }));

  // 4. Booking route work: one week of the appointment schedule (GET /api/appointments).
  const weekFrom = new Date(now.getTime() - 86_400_000), weekTo = new Date(now.getTime() + 6 * 86_400_000);
  results.push(await measure({ id: 'booking_schedule', label: 'Booking route: one week of the schedule', targetMs: 2000, aimMs: 500,
    how: 'listSchedule inside withTenant as bodhinox_app (the GET /api/appointments query); handler session and HTTP not included',
    explain: await explain('SELECT a.* FROM appointments a WHERE a.account_id = $1 AND a.start_at < $3 AND a.end_at > $2 ORDER BY a.start_at, a.id LIMIT 500',
      [accountId, weekFrom, weekTo]),
  }, () => withTenant(ctx, (tx) => listSchedule(tx, accountId, { from: weekFrom, to: weekTo }, now))));

  // 5. Analytics 30-day overview, as GET /api/analytics/overview runs it (current + previous period + numbers).
  results.push(await measure({ id: 'analytics_overview_30d', label: 'Analytics 30-day overview', targetMs: 1500,
    how: 'runAnalytics (statement timeout, workspace timezone) + conversationStats for the range and the previous one, as bodhinox_app',
    explain: null,
  }, () => runAnalytics({ ...ctx, role: 'viewer' }, async (tx, timezone) => {
    const range = parseRange({ preset: '30d' }, timezone, now);
    const current = await conversationStats(tx, accountId, range, { whatsappConfigId: null });
    const before = await conversationStats(tx, accountId, previousRange(range), { whatsappConfigId: null });
    return [current, before];
  })));

  // 6. Inbound text webhook -> visible in the inbox query. The worker polls every second; that wait is
  // added to the measured time, so the target compares (measured + 1000 ms) with 5 s.
  let seq = 0;
  const phoneNumberId = '910000000001';
  const inbound = async () => {
    const n = ++seq;
    const contact = 1 + (n % 5000);
    const wamid = `wamid.perfin.${Date.now()}.${n}`;
    const payload = { object: 'whatsapp_business_account', entry: [{ id: 'perf-waba-1', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp', metadata: { display_phone_number: '+91 0000000001', phone_number_id: phoneNumberId },
      contacts: [{ profile: { name: 'Perf customer' }, wa_id: `91981${String(contact).padStart(7, '0')}` }],
      messages: [{ from: `91981${String(contact).padStart(7, '0')}`, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'price please' } }],
    } }] }] };
    const receiptId = await persistWebhook(JSON.stringify(payload), payload);
    const rows = await getWorkerPrisma().$queryRaw<Job[]>`
      UPDATE jobs SET status='running',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=NOW()+INTERVAL '90 seconds',updated_at=NOW()
      WHERE dedupe_key=${`webhook:${receiptId}`} AND type='whatsapp.webhook' AND status='pending'
      RETURNING id,type,tenant_id,payload,attempts,max_attempts,lease_token`;
    if (!rows[0]) throw new Error('inbound job not queued');
    await handleJob(rows[0]);
    await finishJob(rows[0]);
    const seen = await browser.from('messages').select('id').eq('message_id', wamid).limit(1);
    if (seen.error || !seen.data?.length) throw new Error('inbound message not visible');
    return seen.data;
  };
  const inboundResult = await measure({ id: 'inbound_webhook_visible', label: 'Inbound text webhook to visible in the inbox query',
    targetMs: 4000, how: 'persistWebhook + the whatsapp.webhook job handler (worker role) + a messages read through executeQuery(browser=true); in process, no HTTP',
    note: 'Target 5 s with 1 s worker polling: the measured time must stay within 4 s so that with the polling wait it is within 5 s.',
    explain: null }, inbound, 100, 5);
  results.push(inboundResult);

  // Job claim + finish and drain rate: the opt-in queue-burst load test (docs/testing/queue-burst-result.json).
  const burstFile = path.join(root, 'docs/testing/queue-burst-result.json');
  const burst = fs.existsSync(burstFile) ? JSON.parse(fs.readFileSync(burstFile, 'utf8')) as Record<string, unknown> : null;
  results.push({ id: 'job_claim_finish', label: 'Job claim + finish (single consumer)', targetMs: 50, how: 'opt-in queue-burst load test, local Docker',
    stat: burst ? { runs: Number(burst.uniqueJobs), p50Ms: Number(burst.claimAndCompleteMedianMs), p95Ms: Number(burst.claimAndCompleteP95Ms), maxMs: NaN } : null,
    pass: burst ? Number(burst.claimAndCompleteP95Ms) <= 50 && Number(burst.drainJobsPerSecond) >= 50 : null,
    note: burst ? `From ${path.relative(root, burstFile).replace(/\\/g, '/')} (${String(burst.testedAt)}): drain ${String(burst.drainJobsPerSecond)} jobs/s (target >= 50).` : 'queue-burst result missing' });
  results.push({ id: 'reminder_lag', label: 'Reminder scheduling lag (due to enqueued)', targetMs: 60_000, how: 'not measured in this pass', stat: null, pass: null,
    note: 'Not measured: needs the scheduler loop with 1k due reminders. The scheduler runs every 30 s by design; recorded as an open measurement.' });

  const pg18 = (await owner.query<{ v: string }>('SELECT version() AS v')).rows[0].v;
  const counts = (await owner.query(`SELECT (SELECT count(*) FROM contacts WHERE account_id=$1)::int AS contacts,
    (SELECT count(*) FROM conversations WHERE account_id=$1)::int AS conversations, (SELECT count(*) FROM messages WHERE account_id=$1)::int AS messages,
    (SELECT count(*) FROM appointments WHERE account_id=$1)::int AS appointments`, [accountId])).rows[0];
  const indexes = (await owner.query<{ i: string }>(`SELECT indexrelid::regclass::text AS i FROM pg_index WHERE indrelid::regclass::text IN ('conversations','contacts') ORDER BY 1`)).rows.map((r) => r.i);
  await owner.end();
  await disconnectDatabases();

  const date = now.toISOString().slice(0, 10);
  const report = {
    measuredAt: now.toISOString(), profile, runsPerMeasure: RUNS, warmups: WARMUPS,
    environment: { database: 'local Docker PostgreSQL (scripts/test-db-local.cjs container, database bodhinox_perf)', postgres: pg18,
      hostCpu: os.cpus()[0]?.model ?? null, hostCpuCount: os.cpus().length, memoryGb: Math.round(os.totalmem() / 2 ** 30), platform: `${os.platform()} ${os.release()}`,
      node: process.version, sameMachine: 'database and measuring process on one laptop; production (Railway) network latency is not included' },
    measuredTenant: { key: TENANT, rows: counts }, conversationAndContactIndexes: indexes, results,
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const base = path.join(OUT_DIR, `perf-${date}${profile === 'stress' ? '-stress' : ''}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 2) + '\n');
  const md = [`# Performance at ${profile} volume (${date})`, '',
    `Generated by \`npm run perf:measure${profile === 'stress' ? ' -- --profile stress' : ''}\` (scripts/perf/measure.ts) on ${report.measuredAt}. Raw numbers: \`${path.basename(base)}.json\`.`, '',
    `Environment: ${report.environment.database}; ${pg18.split(' on ')[0]}; ${report.environment.hostCpu} (${report.environment.hostCpuCount} threads, ${report.environment.memoryGb} GB); ${report.environment.platform}; Node ${process.version}. ${report.environment.sameMachine}.`, '',
    `Measured tenant: ${counts.contacts} contacts, ${counts.conversations} conversations, ${counts.messages} messages, ${counts.appointments} appointments (seed: \`npm run perf:seed\`, ${profile} profile, two such tenants plus a small noise tenant). ${WARMUPS} warm-ups, then ${RUNS} timed runs per measure unless the row says otherwise.`, '',
    '| Measure | Target (p95) | p50 | p95 | max | Runs | Result | Sequential scans during runs | How |', '|---|---|---|---|---|---|---|---|---|',
    ...results.map((r) => `| ${r.label} | ${r.targetMs === null ? '—' : `${r.targetMs} ms${r.aimMs ? ` (aim ${r.aimMs})` : ''}`} | ${r.stat ? r.stat.p50Ms : '—'} | ${r.stat ? r.stat.p95Ms : '—'} | ${r.stat && Number.isFinite(r.stat.maxMs) ? r.stat.maxMs : '—'} | ${r.stat?.runs ?? '—'} | ${r.pass === null ? 'not measured' : r.pass ? 'pass' : (profile === 'pilot' ? '**miss**' : 'miss (informational)')} | ${r.seqScans && Object.keys(r.seqScans).length ? Object.entries(r.seqScans).map(([t, n]) => `${t} ${n}`).join(', ') : '—'} | ${r.how}${r.note ? `. ${r.note}` : ''} |`),
    '', '## EXPLAIN (one run, as bodhinox_app with the tenant settings)', '',
    ...results.filter((r) => r.explain).map((r) => `- ${r.label}: top node ${r.explain!.planTop}, ${r.explain!.executionMs} ms, sequential scans: ${r.explain!.seqScanTables.join(', ') || 'none'}. \`${r.explain!.statement}\``),
    '', 'Equivalent statements, not the exact SQL the data gateway generates; the sequential-scan column above is from pg_stat_user_tables during the real runs.', '',
  ].join('\n');
  fs.writeFileSync(`${base}.md`, md);
  console.log(`wrote ${path.relative(root, base)}.json and .md`);
  const missed = results.filter((r) => r.pass === false);
  if (profile === 'pilot' && missed.length) {
    console.error(`pilot target missed: ${missed.map((r) => r.id).join(', ')}`);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error('[perf:measure] failed:', error instanceof Error ? `${error.name}: ${error.message.replace(/postgres(ql)?:\/\/\S+/g, '<url>')}` : 'Error');
  process.exit(1);
});
