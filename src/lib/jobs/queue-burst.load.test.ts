import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import pg from 'pg';
import { expect, it } from 'vitest';
import { disconnectDatabases, getWorkerPrisma } from '@/lib/db/prisma';
import { isLocalDatabaseHost } from '@/lib/db/test-db-guard';
import { claimJob, enqueueJob, finishJob } from './queue';

// Opt-in and local-only: RUN_QUEUE_LOAD_TEST=1 node scripts/test-db-local.cjs run queue-burst
// (or RUN_LOAD_TESTS=1). Uses the local Docker PostgreSQL that script provides; it never loads
// .env.test, never invokes a job handler and never sends messages.
const enabled = process.env.RUN_QUEUE_LOAD_TEST === '1' || process.env.RUN_LOAD_TESTS === '1';

// Pilot targets (docs/testing/perf targets): claim+finish p95 < 50 ms, drain >= 50 jobs/s.
const TARGET_P95_MS = 50;
const TARGET_JOBS_PER_SECOND = 50;

function requireLocal(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required (run through node scripts/test-db-local.cjs run queue-burst)`);
  if (!isLocalDatabaseHost(new URL(value).hostname)) throw new Error(`${name} must point at the local test database`);
  return value;
}

it.skipIf(!enabled)(
  '[OPS-02] handles a burst of 100 unique queued jobs with duplicate submissions',
  async () => {
    const ownerUrl = requireLocal('TEST_DATABASE_URL', process.env.TEST_DATABASE_URL);
    requireLocal('WORKER_DATABASE_URL', process.env.WORKER_DATABASE_URL);
    const owner = new pg.Client({
      connectionString: ownerUrl,
      connectionTimeoutMillis: 10000,
    });
    const accountId = randomUUID(),
      prefix = `queue-load:${randomUUID()}:`;
    let isolated = false;
    const schema = `queue_load_${randomUUID().replaceAll('-', '')}`;
    let created = false;
    try {
      await owner.connect();
      const database = (await owner.query('SELECT current_database() AS name'))
        .rows[0].name;
      if (!/test/i.test(database))
        throw new Error('Isolated test database required');
      isolated = true;
      if (!/^queue_load_[a-f0-9]{32}$/.test(schema))
        throw new Error('Invalid isolated schema');
      await owner.query(`CREATE SCHEMA "${schema}"`);
      created = true;
      await owner.query(
        `CREATE TABLE "${schema}".jobs (LIKE public.jobs INCLUDING ALL)`
      );
      await owner.query(`GRANT USAGE ON SCHEMA "${schema}" TO bodhinox_worker`);
      await owner.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON "${schema}".jobs TO bodhinox_worker`
      );
      const workerUrl = new URL(process.env.WORKER_DATABASE_URL!);
      workerUrl.searchParams.set('options', `-c search_path=${schema},public`);
      process.env.WORKER_DATABASE_URL = workerUrl.toString();
      const workerDatabase = await getWorkerPrisma().$queryRaw<
        { name: string; schema: string }[]
      >`SELECT current_database() AS name, current_schema() AS schema`;
      if (
        workerDatabase[0]?.name !== database ||
        workerDatabase[0]?.schema !== schema
      )
        throw new Error('Worker must use isolated queue schema');
      const started = performance.now();
      const submissions = Array.from({ length: 110 }, (_, i) => {
        const index = i % 100;
        return enqueueJob(
          'flow.sweep',
          { loadTest: true, index },
          { tenantId: accountId, dedupeKey: `${prefix}${index}` }
        );
      });
      const results = await Promise.allSettled(submissions);
      const accepted = results.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : []
      );
      const failedSubmissions = results.length - accepted.length;
      const enqueueMs = performance.now() - started;
      expect(failedSubmissions).toBe(0);
      const ids = new Set(accepted);
      expect(ids.size).toBe(100);
      const seen = new Set<string>();
      const latencies: number[] = [];
      const drainStarted = performance.now();
      // Matches the current worker's sequential claim/complete scheduling.
      // Workload handlers and external providers are deliberately excluded.
      for (let i = 0; i < 100; i++) {
        const jobStarted = performance.now();
        const job = await claimJob();
        if (!job || job.tenant_id !== accountId || !ids.has(job.id))
          throw new Error(
            'Unexpected job encountered; stopped without running its handler'
          );
        expect(seen.has(job.id)).toBe(false);
        expect(job.attempts).toBe(1);
        seen.add(job.id);
        await finishJob(job);
        latencies.push(performance.now() - jobStarted);
      }
      const drainMs = performance.now() - drainStarted;
      const stored = await owner.query(
        'SELECT status,count(*)::int AS count FROM "' +
          schema +
          '".jobs WHERE tenant_id=$1 AND dedupe_key LIKE $2 GROUP BY status',
        [accountId, `${prefix}%`]
      );
      expect(stored.rows).toEqual([{ status: 'done', count: 100 }]);
      expect(seen.size).toBe(100);
      const sorted = [...latencies].sort((a, b) => a - b);
      const postgres = (await owner.query('SHOW server_version')).rows[0].server_version as string;
      const report = {
        testedAt: new Date().toISOString(),
        environment: {
          database: 'local Docker PostgreSQL (scripts/test-db-local.cjs, pgvector/pgvector:pg18)',
          postgresVersion: postgres,
          hostCpu: os.cpus()[0]?.model ?? 'unknown',
          hostCpuCount: os.cpus().length,
          platform: `${os.platform()} ${os.release()}`,
          node: process.version,
        },
        targets: { claimAndCompleteP95Ms: TARGET_P95_MS, drainJobsPerSecond: TARGET_JOBS_PER_SECOND },
        scope:
          'Real queue functions against an isolated copy of the PostgreSQL jobs table and indexes; one sequential consumer; no flow handlers, AI calls, HTTP ingress, or WhatsApp sends',
        submissions: 110,
        uniqueJobs: ids.size,
        duplicateSubmissionsDeduplicated: 10,
        failedSubmissions,
        completed: seen.size,
        duplicateClaims: 0,
        lostJobs: 0,
        enqueueBurstMs: Math.round(enqueueMs),
        sequentialDrainMs: Math.round(drainMs),
        totalMs: Math.round(performance.now() - started),
        claimAndCompleteMedianMs: Math.round(sorted[49]),
        claimAndCompleteP95Ms: Math.round(sorted[94]),
        drainJobsPerSecond: Number((100 / (drainMs / 1000)).toFixed(2)),
      };
      mkdirSync('docs/testing', { recursive: true });
      writeFileSync(
        'docs/testing/queue-burst-result.json',
        JSON.stringify(report, null, 2) + '\n'
      );
      console.info(JSON.stringify(report));
      expect(report.claimAndCompleteP95Ms).toBeLessThan(TARGET_P95_MS);
      expect(report.drainJobsPerSecond).toBeGreaterThanOrEqual(TARGET_JOBS_PER_SECOND);
    } finally {
      await disconnectDatabases();
      if (isolated && created) {
        await owner.query(`DROP TABLE IF EXISTS "${schema}".jobs`);
        await owner.query(`DROP SCHEMA "${schema}"`);
      }
      await owner.end();
    }
  },
  240000
);
