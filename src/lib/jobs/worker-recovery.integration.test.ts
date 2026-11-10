import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Meta is stubbed. 'revoked' answers every send like a revoked or expired token (code 190, HTTP 401).
const meta = vi.hoisted(() => ({ mode: 'ok' as 'ok' | 'revoked', sends: 0 }));
vi.mock('@/lib/whatsapp/meta-api', async (original) => {
  const actual = await original<typeof import('@/lib/whatsapp/meta-api')>();
  return {
    ...actual,
    sendTemplateMessage: vi.fn(async () => {
      meta.sends += 1;
      if (meta.mode === 'revoked') throw new actual.MetaApiError('Error validating access token', { code: 190, httpStatus: 401 });
      return { messageId: `wamid.recovery.${crypto.randomUUID()}` };
    }),
  };
});

import { createAdminClient } from '@/lib/data/admin';
import { disconnectDatabases, getWorkerPrisma } from '@/lib/db/prisma';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { encrypt } from '@/lib/whatsapp/encryption';
import { createBroadcast } from '@/lib/whatsapp/broadcast-core';
import { syncNumberHealth } from '@/lib/whatsapp/health-sync';
import { handleJob } from './handlers';
import { claimJob, enqueueJob, finishJob, type Job } from './queue';
import { runWorkerLoop } from './worker-loop';

// Local Docker database only (scripts/test-db-local.cjs); no .env file is loaded here.
const ownerUrl = process.env.TEST_DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountId = randomUUID(), userId = randomUUID();
const ours = new Set<string>();
let owner: pg.Client;
let configId = '';

/** A job due long ago, so the loop claims it before anything else in the shared test database. */
async function oldJob(offsetMs: number) {
  const id = await enqueueJob('automation.resume', { recoveryTest: true }, {
    tenantId: accountId, runAt: new Date(offsetMs), dedupeKey: `recovery:${randomUUID()}`,
  });
  ours.add(id);
  return id;
}
const jobRow = async (id: string) => (await owner.query('SELECT status, attempts, lease_token::text AS lease_token, lease_until FROM jobs WHERE id=$1', [id])).rows[0] as
  { status: string; attempts: number; lease_token: string | null; lease_until: Date | null };
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!ownerUrl || !workerUrl)('[OPS-01] worker recovery and provider disconnection on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getWorkerPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_worker') throw new Error('Requires constrained test worker credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Worker recovery','test-only-hash')", [userId, `${userId}@example.invalid`]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Worker recovery',$2)", [accountId, userId]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner')", [accountId, userId]);
    configId = (await owner.query(`INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,access_token,status) VALUES($1,$2,$3,$4,'connected') RETURNING id::text`,
      [accountId, userId, `test-${accountId}`, encrypt('test-only-token')])).rows[0].id;
  });
  afterEach(() => { meta.mode = 'ok'; meta.sends = 0; });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id=$1 OR id = ANY($2::uuid[])', [accountId, [...ours]]);
      await owner.query('DELETE FROM accounts WHERE id=$1', [accountId]);
      await owner.query('DELETE FROM auth_users WHERE id=$1', [userId]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('stops claiming on abort and lets the in-flight job finish within the drain bound', async () => {
    const first = await oldJob(0), second = await oldJob(1);
    const controller = new AbortController();
    const handled: string[] = [];
    const result = await runWorkerLoop({
      signal: controller.signal, idleMs: 20, drainMs: 5_000, scheduleWork: null, heartbeat: false, concurrency: 1,
      handleJob: async (job) => {
        handled.push(job.id);
        // SIGTERM arrives while the job is running.
        controller.abort();
        await delay(300);
      },
    });
    expect(result).toEqual({ processed: 1, drained: true });
    expect(handled).toEqual([first]);
    expect(await jobRow(first)).toMatchObject({ status: 'done' });
    // Never claimed after the abort: still pending, no attempt spent.
    expect(await jobRow(second)).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('a job still running past the drain bound is not lost: its lease expires, another worker reclaims it, and the old run is fenced', async () => {
    const id = await oldJob(0);
    const controller = new AbortController();
    let release!: () => void;
    const stuck = new Promise<void>((resolve) => { release = resolve; });
    let claimed: Job | undefined;
    const result = await runWorkerLoop({
      signal: controller.signal, idleMs: 20, drainMs: 200, scheduleWork: null, heartbeat: false, concurrency: 1,
      handleJob: async (job) => { claimed = job; controller.abort(); await stuck; },
    });
    expect(result.drained).toBe(false);
    expect(claimed?.id).toBe(id);
    const running = await jobRow(id);
    expect(running.status).toBe('running');
    expect(running.lease_until!.getTime()).toBeGreaterThan(Date.now());

    // The process exits; 90 s later the lease has expired (simulated) and a new worker reclaims the job.
    await owner.query("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [id]);
    const reclaimed = await claimJob();
    expect(reclaimed?.id).toBe(id);
    expect(reclaimed!.attempts).toBe(2);
    expect(reclaimed!.lease_token).not.toBe(claimed!.lease_token);

    // The first run finally returns: its finish carries the old lease token and changes nothing.
    release();
    await delay(100);
    await finishJob(claimed!);
    expect(await jobRow(id)).toMatchObject({ status: 'running', lease_token: reclaimed!.lease_token });
    await finishJob(reclaimed!);
    expect(await jobRow(id)).toMatchObject({ status: 'done' });
  });

  it('a revoked WhatsApp token fails each recipient with a classified reason, records rejected intents and queues no retry pass', async () => {
    meta.mode = 'revoked';
    const recipients = ['+14155550401', '+14155550402', '+14155550403'];
    const { broadcastId } = await createBroadcast(createAdminClient({ accountId, role: 'owner' }), accountId, userId, {
      name: 'Revoked token', templateName: 'promo', recipients: recipients.map((to) => ({ to })),
    });
    const job = { id: randomUUID(), type: 'broadcast.dispatch', tenant_id: accountId, payload: { broadcastId },
      attempts: 1, max_attempts: 5, lease_token: randomUUID() };
    // The pass completes (no exception), so the job is not retried in a loop.
    await expect(handleJob(job)).resolves.toBeUndefined();
    // One attempt per recipient: a 190 is not a "recipient not allowed" error, so no other phone variant is tried.
    expect(meta.sends).toBe(recipients.length);
    const rows = (await owner.query('SELECT status, error_message FROM broadcast_recipients WHERE broadcast_id=$1', [broadcastId])).rows;
    expect(rows).toHaveLength(recipients.length);
    for (const row of rows) {
      expect(row.status).toBe('failed');
      expect(row.error_message).toMatch(/access token/i);
    }
    // Meta definitively refused (4xx): the intents are 'failed', never 'unknown', so nothing waits on reconciliation.
    const intents = (await owner.query('SELECT status FROM outbound_intents WHERE account_id=$1 AND idempotency_key LIKE $2',
      [accountId, `${accountId}:broadcast:${broadcastId}:%`])).rows.map((r) => r.status);
    expect(intents).toEqual(recipients.map(() => 'failed'));
    const followUps = (await owner.query("SELECT dedupe_key FROM jobs WHERE tenant_id=$1 AND type='broadcast.dispatch' AND dedupe_key LIKE $2 AND dedupe_key <> $3",
      [accountId, `broadcast:${broadcastId}:%`, `broadcast:${broadcastId}:initial`])).rows;
    expect(followUps).toEqual([]);
    expect((await owner.query('SELECT status FROM broadcasts WHERE id=$1', [broadcastId])).rows[0].status).toBe('failed');
  });

  it('the number health sync records a revoked token as a fixed category without disconnecting the number', async () => {
    const revoked = async () => { throw new MetaApiError('Error validating access token', { code: 190, httpStatus: 401 }); };
    const result = await syncNumberHealth({ accountId, configId, fetchHealth: revoked });
    expect(result).toEqual({ status: 'error', error: 'token' });
    const row = (await owner.query('SELECT status, health_error, health_error_at FROM whatsapp_config WHERE id=$1', [configId])).rows[0];
    expect(row).toMatchObject({ status: 'connected', health_error: 'token' });
    expect(row.health_error_at).not.toBeNull();
  });
});
