import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { disconnectDatabases, getWorkerPrisma } from "@/lib/db/prisma";
import { BULK_JOB_TYPES, TIMER_JOB_TYPES, claimJob, enqueueTenantJobs, finishJob, LaneBusyError, withLaneLock, type Job } from "./queue";
import { jobLane } from "./lanes";
import { runWorkerLoop } from "./worker-loop";

// Worker lanes on a real database (batch 5): claim per lane, one conversation's jobs in order
// under several inbound slots, bulk fairness between workspaces, the lane lock and batched inserts.
const configured = config({ path: ".env.test", quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
const accountA = randomUUID(), accountB = randomUUID(), userId = randomUUID();
let owner: pg.Client;

/** A job inserted straight into the queue (as the ingest and database triggers do), oldest first. */
async function insertJob(type: string, tenantId: string, offsetMs: number, laneKey: string | null = null): Promise<string> {
  const { rows } = await owner.query(
    "INSERT INTO jobs(type,tenant_id,payload,dedupe_key,run_at,lane_key) VALUES($1,$2,'{}'::jsonb,$3,to_timestamp(0)+make_interval(secs=>$4::float/1000),$5) RETURNING id",
    [type, tenantId, `lanes-test:${randomUUID()}`, offsetMs, laneKey]);
  return rows[0].id;
}
const ours = async () => (await owner.query("SELECT id FROM jobs WHERE tenant_id = ANY($1::uuid[])", [[accountA, accountB]])).rows.map((r) => r.id as string);

describe.skipIf(!ownerUrl || !workerUrl)("[batch-5] worker lanes on PostgreSQL", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    const ownerName = (await owner.query("SELECT current_database() AS name")).rows[0].name;
    const workerName = await getWorkerPrisma().$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
    if (!/test/i.test(ownerName) || workerName[0].name !== ownerName) throw new Error("Lane tests require isolated matching test database URLs");
    await owner.query("BEGIN");
    await owner.query("SET LOCAL ROLE bodhinox_auth");
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Lanes test owner','test-only-hash')", [userId, `${userId}@example.invalid`]);
    for (const id of [accountA, accountB]) {
      await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Lanes integration',$2)", [id, userId]);
      await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner')", [id, userId]);
    }
    await owner.query("COMMIT");
  });
  afterEach(async () => {
    await owner.query("DELETE FROM jobs WHERE tenant_id = ANY($1::uuid[])", [[accountA, accountB]]);
  });
  afterAll(async () => {
    if (owner) {
      await owner.query("DELETE FROM accounts WHERE id = ANY($1::uuid[])", [[accountA, accountB]]);
      await owner.query("DELETE FROM auth_users WHERE id=$1", [userId]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it("each lane claims only its own job types", async () => {
    const inbound = await insertJob("inbound.actions", accountA, 1);
    const timer = await insertJob("flow.timer", accountA, 2);
    const bulk = await insertJob("broadcast.dispatch", accountA, 3);
    // The shared test database may hold due jobs of other files: drain each lane and check what it took.
    const drain = async (lane: "inbound" | "timers" | "bulk") => {
      const taken: Job[] = [];
      for (let job = await claimJob(lane); job && taken.length < 200; job = await claimJob(lane)) taken.push(job);
      return taken;
    };
    const [i, t, b] = await Promise.all([drain("inbound"), drain("timers"), drain("bulk")]);
    expect(i.map((j) => j.id)).toContain(inbound);
    expect(t.map((j) => j.id)).toContain(timer);
    expect(b.map((j) => j.id)).toContain(bulk);
    expect(i.every((j) => jobLane(j.type) === "inbound")).toBe(true);
    expect(t.every((j) => (TIMER_JOB_TYPES as readonly string[]).includes(j.type))).toBe(true);
    expect(b.every((j) => (BULK_JOB_TYPES as readonly string[]).includes(j.type))).toBe(true);
    for (const job of [...i, ...t, ...b]) await finishJob(job);
  });

  it("4 inbound slots: one conversation's jobs finish one at a time in run_at order while another conversation runs alongside", async () => {
    const N = 5, M = 5;
    const keyA = `conversation:${randomUUID()}`, keyB = `conversation:${randomUUID()}`;
    const expected = { [keyA]: [] as string[], [keyB]: [] as string[] };
    // Interleaved run_at: a1 b1 a2 b2 ...; each conversation's own order is its run_at order.
    for (let n = 0; n < Math.max(N, M); n++) {
      if (n < N) expected[keyA].push(await insertJob("inbound.actions", accountA, 10 + n * 2, keyA));
      if (n < M) expected[keyB].push(await insertJob("inbound.actions", accountB, 11 + n * 2, keyB));
    }
    const mine = new Set([...expected[keyA], ...expected[keyB]]);
    const finished = { [keyA]: [] as string[], [keyB]: [] as string[] };
    const running = new Map<string, number>();
    let maxPerKey = 0, overlap = false;
    const controller = new AbortController();
    const result = await runWorkerLoop({
      signal: controller.signal, heartbeat: false, scheduleWork: null, idleMs: 5, idleMaxMs: 20, drainMs: 5_000,
      lanes: ["inbound", "inbound", "inbound", "inbound"],
      handleJob: async (job) => {
        if (!mine.has(job.id)) return; // another file's leftover: finished untouched
        const key = job.lane_key!;
        running.set(key, (running.get(key) ?? 0) + 1);
        maxPerKey = Math.max(maxPerKey, running.get(key)!);
        if (running.get(keyA) && running.get(keyB)) overlap = true;
        await new Promise((resolve) => setTimeout(resolve, 40));
        running.set(key, running.get(key)! - 1);
        finished[key].push(job.id);
        if (finished[keyA].length === N && finished[keyB].length === M) controller.abort();
      },
    });
    expect(result.drained).toBe(true);
    expect(maxPerKey).toBe(1);
    expect(overlap).toBe(true);
    expect(finished[keyA]).toEqual(expected[keyA]);
    expect(finished[keyB]).toEqual(expected[keyB]);
    expect((await owner.query("SELECT DISTINCT status FROM jobs WHERE id = ANY($1::uuid[])", [[...mine]])).rows).toEqual([{ status: "done" }]);
  });

  it("a keyed job waits while an older job of its key is running or still due, then runs", async () => {
    const key = `conversation:${randomUUID()}`;
    const first = await insertJob("inbound.actions", accountA, 1, key);
    const second = await insertJob("inbound.actions", accountA, 2, key);
    const taken: Job[] = [];
    for (let job = await claimJob("inbound"); job; job = await claimJob("inbound")) taken.push(job);
    expect(taken.map((j) => j.id)).toContain(first);
    expect(taken.map((j) => j.id)).not.toContain(second);
    await finishJob(taken.find((j) => j.id === first)!);
    const next = await claimJob("inbound");
    expect(next?.id).toBe(second);
    for (const job of [...taken.filter((j) => j.id !== first), next!]) await finishJob(job);
  });

  it("the bulk lane takes another workspace's due job before a second one of a workspace already running bulk work", async () => {
    const a1 = await insertJob("broadcast.dispatch", accountA, 1);
    await insertJob("workspace.export", accountA, 2);
    const b1 = await insertJob("broadcast.dispatch", accountB, 3);
    const first = await claimJob("bulk");
    expect(first?.id).toBe(a1);
    const second = await claimJob("bulk");
    expect(second?.id).toBe(b1);
    await finishJob(first!); await finishJob(second!);
  });

  it("a run whose key is locked elsewhere does nothing and returns to the queue without spending an attempt", async () => {
    const key = `conversation:${randomUUID()}`;
    const id = await insertJob("inbound.actions", accountA, 1, key);
    let job: Job | null = null;
    for (let next = await claimJob("inbound"); next; next = await claimJob("inbound")) {
      if (next.id === id) job = next; else await finishJob(next);
    }
    expect(job).not.toBeNull();
    // An earlier run of the same key (its lease expired) still holds the lock.
    const holder = new pg.Client({ connectionString: ownerUrl });
    await holder.connect();
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`job-lane:${key}`]);
    let ran = false;
    const error = await withLaneLock(key, async () => { ran = true; }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LaneBusyError);
    expect(ran).toBe(false);
    await finishJob(job!, error);
    const row = (await owner.query("SELECT status,attempts,lease_until FROM jobs WHERE id=$1", [id])).rows[0];
    expect(row).toEqual({ status: "pending", attempts: 0, lease_until: null });
    await holder.query("ROLLBACK");
    await holder.end();
    // Released: the lock is free again.
    expect(await withLaneLock(key, async () => "ran")).toBe("ran");
  });

  it("queues every workspace's scheduler job in one statement with unchanged dedupe keys", async () => {
    const window = Math.floor(Date.now() / 30_000);
    const entries = [accountA, accountB].map((id) => ({ tenantId: id, dedupeKey: `lanes-test-schedule:${id}:${window}` }));
    expect(await enqueueTenantJobs("automation.schedule", { minute: "m" }, entries)).toBe(2);
    expect(await enqueueTenantJobs("automation.schedule", { minute: "m" }, entries)).toBe(0);
    const rows = (await owner.query("SELECT tenant_id::text,type,dedupe_key,payload,max_attempts,status FROM jobs WHERE id = ANY($1::uuid[]) ORDER BY dedupe_key", [await ours()])).rows;
    expect(rows).toEqual(entries.map((e) => ({ tenant_id: e.tenantId, type: "automation.schedule", dedupe_key: e.dedupeKey, payload: { minute: "m" }, max_attempts: 5, status: "pending" }))
      .sort((x, y) => x.dedupe_key.localeCompare(y.dedupe_key)));
    expect(await enqueueTenantJobs("automation.schedule", {}, [])).toBe(0);
  });
});
