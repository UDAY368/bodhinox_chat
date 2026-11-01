import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminClient } from "@/lib/data/admin";
import { disconnectDatabases, getWorkerPrisma } from "@/lib/db/prisma";
import { encrypt } from "@/lib/whatsapp/encryption";
import { createBroadcast } from "./broadcast-core";

const configured = config({ path: ".env.test", quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
const accountId = randomUUID(), userId = randomUUID();
let owner: pg.Client;

describe.skipIf(!ownerUrl || !workerUrl)("public API broadcast creation on PostgreSQL", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    const ownerName = (await owner.query("SELECT current_database() AS name")).rows[0].name;
    const workerName = await getWorkerPrisma().$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
    if (!/test/i.test(ownerName) || workerName[0].name !== ownerName) throw new Error("Broadcast tests require isolated matching test database URLs");
    await owner.query("BEGIN");
    await owner.query("SET LOCAL ROLE bodhinox_auth");
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'API broadcast test','test-only-hash')", [userId, `${userId}@example.invalid`]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'API broadcast',$2)", [accountId, userId]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner')", [accountId, userId]);
    await owner.query("COMMIT");
    await owner.query("INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,access_token) VALUES($1,$2,$3,$4)",
      [accountId, userId, `test-${accountId}`, encrypt("test-only-token")]);
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

  it("commits the campaign, frozen recipient params and its dispatch job together", async () => {
    const plan = await createBroadcast(createAdminClient({ accountId, role: "owner" }), accountId, userId, {
      name: "API launch",
      templateName: "promo",
      recipients: [{ to: "+14155550123", params: ["Jane"] }, { to: "+14155550124" }],
    });
    expect(plan.planned).toHaveLength(2);
    const recipients = (await owner.query("SELECT template_params FROM broadcast_recipients WHERE broadcast_id=$1 ORDER BY template_params::text", [plan.broadcastId])).rows;
    expect(recipients.map((r) => r.template_params)).toEqual([[], ["Jane"]]);
    const jobs = (await owner.query("SELECT type,tenant_id,payload FROM jobs WHERE dedupe_key=$1", [`broadcast:${plan.broadcastId}:initial`])).rows;
    expect(jobs).toEqual([{ type: "broadcast.dispatch", tenant_id: accountId, payload: { broadcastId: plan.broadcastId } }]);
  });

  it("drops opted-out and blocked recipients as rejected", async () => {
    await owner.query("INSERT INTO contacts(account_id,user_id,name,phone,opted_out_at) VALUES($1,$2,'Opted out','14155550181',NOW())", [accountId, userId]);
    await owner.query("INSERT INTO contacts(account_id,user_id,name,phone,blocked_at) VALUES($1,$2,'Blocked','14155550182',NOW())", [accountId, userId]);
    const plan = await createBroadcast(createAdminClient({ accountId, role: "owner" }), accountId, userId, {
      templateName: "promo",
      recipients: [{ to: "+14155550181" }, { to: "+14155550182" }, { to: "+14155550183" }],
    });
    expect(plan.rejected).toBe(2);
    expect(plan.planned).toHaveLength(1);
    await expect(createBroadcast(createAdminClient({ accountId, role: "owner" }), accountId, userId, {
      templateName: "promo",
      recipients: [{ to: "+14155550181" }],
    })).rejects.toMatchObject({ status: 400 });
  });
});
