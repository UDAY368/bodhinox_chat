import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { disconnectDatabases, getWorkerPrisma } from "@/lib/db/prisma";
import { claimJob, enqueueJob, finishJob, heartbeat, persistWebhook } from "./queue";
import { dispatchOnce, UncertainDispatchError } from "./dispatch";
import { MetaApiError } from "@/lib/whatsapp/meta-api";

const configured = config({ path: ".env.test", quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
const accountId = randomUUID(), userId = randomUUID();
const jobs = new Set<string>(), receipts = new Set<string>();
let owner: pg.Client;

async function createJob(maxAttempts = 5) {
  const id = await enqueueJob("automation.resume", { test: true }, {
    tenantId: accountId, runAt: new Date(0), dedupeKey: randomUUID(), maxAttempts,
  });
  jobs.add(id);
  return id;
}

describe.skipIf(!ownerUrl || !workerUrl)("real PostgreSQL durable queue and dispatch", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    const ownerName = (await owner.query("SELECT current_database() AS name")).rows[0].name;
    const workerName = await getWorkerPrisma().$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
    if (!/test/i.test(ownerName) || workerName[0].name !== ownerName) throw new Error("Queue tests require isolated matching test database URLs");
    await owner.query("BEGIN");
    await owner.query("SET LOCAL ROLE bodhinox_auth");
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Queue test owner','test-only-hash')", [userId, `${userId}@example.invalid`]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Queue integration',$2)", [accountId, userId]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner')", [accountId, userId]);
    await owner.query("COMMIT");
  });

  afterEach(async () => {
    for (const id of jobs) await owner.query("DELETE FROM jobs WHERE id=$1", [id]);
    for (const id of receipts) {
      await owner.query("DELETE FROM jobs WHERE dedupe_key=$1", [`webhook:${id}`]);
      await owner.query("DELETE FROM webhook_receipts WHERE id=$1", [id]);
    }
    jobs.clear(); receipts.clear();
  });
  afterAll(async () => {
    if (owner) {
      await owner.query("DELETE FROM accounts WHERE id=$1", [accountId]);
      await owner.query("DELETE FROM auth_users WHERE id=$1", [userId]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it("atomically deduplicates a receipt and its persisted processing job", async () => {
    const payload = { testId: randomUUID(), entry: [] };
    const raw = JSON.stringify(payload);
    const ids = await Promise.all([persistWebhook(raw, payload), persistWebhook(raw, payload)]);
    receipts.add(ids[0]);
    expect(ids[0]).toBe(ids[1]);
    expect((await owner.query("SELECT id FROM webhook_receipts WHERE id=$1", [ids[0]])).rows).toHaveLength(1);
    expect((await owner.query("SELECT id,payload FROM jobs WHERE dedupe_key=$1", [`webhook:${ids[0]}`])).rows).toEqual([
      { id: expect.any(String), payload: { receiptId: ids[0] } },
    ]);
  });

  it("simultaneous SKIP LOCKED claims lease different jobs", async () => {
    const ids = [await createJob(), await createJob()];
    const claimed = await Promise.all([claimJob(), claimJob()]);
    expect(claimed.map(job => job?.id).sort()).toEqual(ids.sort());
    expect(new Set(claimed.map(job => job?.lease_token)).size).toBe(2);
    for (const job of claimed) expect(job?.attempts).toBe(1);
  });

  it("reclaims an expired lease and rejects stale heartbeat and completion", async () => {
    const id = await createJob();
    const first = await claimJob();
    expect(first?.id).toBe(id);
    await owner.query("UPDATE jobs SET lease_until=NOW()-INTERVAL '1 second' WHERE id=$1", [id]);
    const second = await claimJob();
    expect(second?.id).toBe(id);
    expect(second?.attempts).toBe(2);
    expect(second?.lease_token).not.toBe(first?.lease_token);
    expect(await heartbeat(first!)).toBe(0);
    await finishJob(first!);
    expect((await owner.query("SELECT status,lease_token FROM jobs WHERE id=$1", [id])).rows[0]).toEqual({ status: "running", lease_token: second!.lease_token });
    await finishJob(second!);
    expect((await owner.query("SELECT status FROM jobs WHERE id=$1", [id])).rows[0].status).toBe("done");
  });

  it("marks an expired exhausted lease as terminal instead of stranding it", async () => {
    const id = await createJob(1);
    const job = await claimJob();
    expect(job?.id).toBe(id);
    await owner.query("UPDATE jobs SET lease_until=NOW()-INTERVAL '1 second' WHERE id=$1", [id]);
    await claimJob();
    expect((await owner.query("SELECT status FROM jobs WHERE id=$1", [id])).rows[0].status).toBe("failed");
  });

  it("concurrent dispatch invokes the provider once and reuses its persisted result", async () => {
    const key = randomUUID(); let calls = 0;
    const result = { messageId: randomUUID(), accepted: true };
    const send = async () => { calls++; return result; };
    const outcomes = await Promise.allSettled([dispatchOnce(accountId, key, send), dispatchOnce(accountId, key, send)]);
    expect(calls).toBe(1);
    expect(outcomes.some(outcome => outcome.status === "fulfilled")).toBe(true);
    expect(await dispatchOnce(accountId, key, send)).toEqual(result);
    expect(calls).toBe(1);
    const intent = (await owner.query("SELECT status,result FROM outbound_intents WHERE account_id=$1 AND idempotency_key=$2", [accountId, `${accountId}:${key}`])).rows[0];
    expect(intent).toEqual({ status: "accepted", result });
  });

  it("an ambiguous provider outcome remains unknown and is never blindly retried", async () => {
    const key = randomUUID(); let calls = 0;
    const send = async () => { calls++; throw new Error("Simulated timeout after provider acceptance"); };
    await expect(dispatchOnce(accountId, key, send)).rejects.toBeInstanceOf(UncertainDispatchError);
    await expect(dispatchOnce(accountId, key, send)).rejects.toBeInstanceOf(UncertainDispatchError);
    expect(calls).toBe(1);
    expect((await owner.query("SELECT status FROM outbound_intents WHERE account_id=$1 AND idempotency_key=$2", [accountId, `${accountId}:${key}`])).rows[0].status).toBe("unknown");
  });

  it("only an explicit retry can atomically reclaim a known rejected send", async () => {
    const key = randomUUID(); let calls = 0;
    const rejected = async () => { calls++; throw new MetaApiError("Simulated rejected template", { httpStatus: 400 }); };
    await expect(dispatchOnce(accountId, key, rejected)).rejects.toBeInstanceOf(MetaApiError);
    const result = { messageId: randomUUID() };
    const send = async () => { calls++; return result; };
    await expect(dispatchOnce(accountId, key, send)).rejects.toBeInstanceOf(UncertainDispatchError);
    expect(calls).toBe(1);
    const attempts = await Promise.allSettled([
      dispatchOnce(accountId, key, send, { retryRejected: true }),
      dispatchOnce(accountId, key, send, { retryRejected: true }),
    ]);
    expect(calls).toBe(2);
    expect(attempts.some(attempt => attempt.status === "fulfilled")).toBe(true);
    expect(await dispatchOnce(accountId, key, send, { retryRejected: true })).toEqual(result);
    expect(calls).toBe(2);
  });

  it("an explicit manual requeue rearms a completed job but never resets a running lease",async()=>{
    const key=randomUUID();
    const id=await enqueueJob("automation.resume",{test:true},{tenantId:accountId,runAt:new Date(0),dedupeKey:key});jobs.add(id);
    const first=await claimJob();expect(first?.id).toBe(id);await finishJob(first!);
    expect(await enqueueJob("automation.resume",{manual:true},{tenantId:accountId,runAt:new Date(0),dedupeKey:key})).toBe(id);
    expect((await owner.query("SELECT status FROM jobs WHERE id=$1",[id])).rows[0].status).toBe("done");
    expect(await enqueueJob("automation.resume",{manual:true},{tenantId:accountId,runAt:new Date(0),dedupeKey:key,requeueCompleted:true})).toBe(id);
    expect((await owner.query("SELECT status,attempts,payload FROM jobs WHERE id=$1",[id])).rows[0]).toEqual({status:"pending",attempts:0,payload:{manual:true}});
    const second=await claimJob();expect(second?.id).toBe(id);
    await enqueueJob("automation.resume",{reset:true},{tenantId:accountId,runAt:new Date(0),dedupeKey:key,requeueCompleted:true});
    expect((await owner.query("SELECT status,attempts,lease_token,payload FROM jobs WHERE id=$1",[id])).rows[0]).toEqual({status:"running",attempts:1,lease_token:second!.lease_token,payload:{manual:true}});
  });

  it("[audit-10/37] the main lane never takes a campaign pass and the bulk lane takes nothing else", async () => {
    const campaign = await enqueueJob("broadcast.dispatch", { test: true }, { tenantId: accountId, runAt: new Date(0), dedupeKey: randomUUID() });
    jobs.add(campaign);
    const inbound = await createJob();
    const [bulk, main] = await Promise.all([claimJob("bulk"), claimJob("main")]);
    expect(bulk?.id).toBe(campaign);
    expect(main?.id).toBe(inbound);
    expect(await claimJob("bulk")).toBeNull();
    expect(await claimJob("main")).toBeNull();
    await finishJob(bulk!); await finishJob(main!);
  });

  it("[audit-38] backs off a failed attempt for minutes and gives inbound processing the long budget", async () => {
    const payload = { testId: randomUUID(), entry: [] };
    const receipt = await persistWebhook(JSON.stringify(payload), payload);
    receipts.add(receipt);
    expect((await owner.query("SELECT max_attempts FROM jobs WHERE dedupe_key=$1", [`webhook:${receipt}`])).rows[0].max_attempts).toBe(8);
    await owner.query("UPDATE jobs SET run_at=to_timestamp(0) WHERE dedupe_key=$1", [`webhook:${receipt}`]);
    const job = await claimJob();
    expect(job?.type).toBe("whatsapp.webhook");
    await finishJob(job!, new Error("storage unavailable"));
    const row = (await owner.query("SELECT status,EXTRACT(EPOCH FROM run_at-NOW())::int AS wait FROM jobs WHERE id=$1", [job!.id])).rows[0];
    expect(row.status).toBe("pending");
    expect(row.wait).toBeGreaterThanOrEqual(8);
    expect(row.wait).toBeLessThanOrEqual(10);
  });
});
