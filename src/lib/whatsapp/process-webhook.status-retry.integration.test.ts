import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { disconnectDatabases } from "@/lib/db/prisma";
import type { Job } from "@/lib/jobs/queue";

const configured = config({ path: ".env.test", quiet: true }).parsed;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
const ownerUrl = process.env.TEST_DATABASE_URL;
const accountId = randomUUID(), userId = randomUUID();
// The phone-number routing is not under test; every delivery resolves to this tenant.
vi.mock("@/lib/repositories/routing", () => ({ resolveWhatsAppAccount: async () => accountId, resolveWabaAccount: async () => null }));

const { processWebhook } = await import("./process-webhook");
const { handleJob } = await import("@/lib/jobs/handlers");
let owner: pg.Client;
let conversationId: string;

const now = () => String(Math.floor(Date.now() / 1000));
const delivery = (statuses: Record<string, unknown>[]) => ({
  entry: [{ id: "WABA-1", changes: [{ field: "messages", value: { metadata: { phone_number_id: "pn-1" }, statuses } }] }],
}) as unknown as Parameters<typeof processWebhook>[0];
async function outbound(wamid: string) {
  return (await owner.query("INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,message_id,status) VALUES($1,$2,'bot','text','Test outbound',$3,'sent') RETURNING id",
    [accountId, conversationId, wamid])).rows[0].id as string;
}
const retryJobs = async (wamid: string) => (await owner.query(
  "SELECT id,type,tenant_id,payload,attempts,max_attempts,status FROM jobs WHERE type='whatsapp.status_retry' AND tenant_id=$1 AND payload->'status'->>'id'=$2", [accountId, wamid])).rows;
const asJob = (row: { id: string; type: string; tenant_id: string; payload: Record<string, unknown> }): Job =>
  ({ ...row, attempts: 1, max_attempts: 5, lease_token: randomUUID() });

describe.skipIf(!ownerUrl || !workerUrl)("provider status awaiting outbound persistence", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if ((await owner.query("SELECT current_database() AS name")).rows[0].name !== "bodhinox_test") throw new Error("Status retry tests require the isolated bodhinox_test database");
    await owner.query("BEGIN");
    await owner.query("SET LOCAL ROLE bodhinox_auth");
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Status retry owner','test-only-hash')", [userId, `${userId}@example.invalid`]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Status retry',$2)", [accountId, userId]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner')", [accountId, userId]);
    await owner.query("COMMIT");
    const contactId = (await owner.query("INSERT INTO contacts(account_id,user_id,phone) VALUES($1,$2,$3) RETURNING id", [accountId, userId, `${Date.now()}`])).rows[0].id;
    conversationId = (await owner.query("INSERT INTO conversations(account_id,user_id,contact_id,status) VALUES($1,$2,$3,'open') RETURNING id", [accountId, userId, contactId])).rows[0].id;
  });
  afterAll(async () => {
    if (owner) {
      await owner.query("DELETE FROM jobs WHERE tenant_id=$1", [accountId]);
      await owner.query("DELETE FROM accounts WHERE id=$1", [accountId]);
      await owner.query("DELETE FROM auth_users WHERE id=$1", [userId]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it("applies the sibling statuses and retries only the unknown wamid on its own job until its row commits", async () => {
    const known = `wamid.${randomUUID()}`, early = `wamid.${randomUUID()}`;
    const knownId = await outbound(known);
    const body = delivery([
      { id: early, status: "delivered", timestamp: now(), recipient_id: "15551230000" },
      { id: known, status: "delivered", timestamp: now(), recipient_id: "15551230000" },
    ]);
    await expect(processWebhook(body)).resolves.toBeUndefined();
    expect((await owner.query("SELECT status FROM messages WHERE id=$1", [knownId])).rows[0].status).toBe("delivered");
    // A replayed delivery reuses the queued retry instead of adding one.
    await processWebhook(body);
    const jobs = await retryJobs(early);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload).toEqual({ accountId, status: { id: early, status: "delivered", timestamp: expect.any(String) } });

    // Still unknown and fresh: the retry job fails so the queue backs off.
    await expect(handleJob(asJob(jobs[0]))).rejects.toMatchObject({ name: "StatusAwaitingPersistenceError" });
    const earlyId = await outbound(early);
    await handleJob(asJob(jobs[0]));
    expect((await owner.query("SELECT status FROM messages WHERE id=$1", [earlyId])).rows[0].status).toBe("delivered");
  });

  it("drops a retry for a wamid that never gets a row once the persistence grace has passed", async () => {
    const never = `wamid.${randomUUID()}`;
    await processWebhook(delivery([{ id: never, status: "read", timestamp: now(), recipient_id: "15551230000" }]));
    const [job] = await retryJobs(never);
    const stale = { ...job, payload: { ...job.payload, status: { ...job.payload.status, timestamp: String(Math.floor(Date.now() / 1000) - 60) } } };
    await expect(handleJob(asJob(stale))).resolves.toBeUndefined();
  });

  it("rejects a retry job whose payload names another tenant", async () => {
    const job = { id: randomUUID(), type: "whatsapp.status_retry", tenant_id: accountId,
      payload: { accountId: randomUUID(), status: { id: "wamid.X", status: "read", timestamp: now() } } };
    await expect(handleJob(asJob(job))).rejects.toThrow("tenant mismatch");
  });
});
