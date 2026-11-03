import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disconnectDatabases, getWorkerPrisma } from "@/lib/db/prisma";
import { ingestInboundMessage, type IngestInboundInput } from "@/lib/whatsapp/ingest";
import { parseReferral } from "./referrals";

// Click-to-WhatsApp attribution end to end: the inbound pipeline stores the
// referral with its message, the job payload carries a summary without the
// click id, and the database keeps the click id away from the app role and
// other tenants.

const configured = config({ path: ".env.test", quiet: true }).parsed;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
const ownerUrl = process.env.TEST_DATABASE_URL;
let owner: pg.Client;
const accountId = randomUUID(), otherAccountId = randomUUID(), userId = randomUUID(), otherUserId = randomUUID();
let phoneSequence = 0;
const CLICK_ID = "ARAkLkA8rmlFeiCktEJQ-QTwRiyYHAFDLMNDBH0CD3qpjd0HR4irJ6LEkR7JwFF4XvnO2E4Nx0-eM-GABDLOPaOdRMv-_zfUQ2a";

async function asRole<T>(role: "bodhinox_app" | "bodhinox_worker", account: string, user: string, action: () => Promise<T>): Promise<T> {
  await owner.query("BEGIN");
  try {
    await owner.query(`SET LOCAL ROLE ${role}`);
    await owner.query("SELECT set_config('app.account_id',$1,true),set_config('app.user_id',$2,true),set_config('app.account_role','owner',true)", [account, user]);
    const result = await action();
    await owner.query("COMMIT");
    return result;
  } catch (error) {
    await owner.query("ROLLBACK");
    throw error;
  }
}

async function fixture(account = accountId, user = userId): Promise<IngestInboundInput> {
  return asRole("bodhinox_worker", account, user, async () => {
    const contactId = (await owner.query("INSERT INTO contacts(account_id,user_id,phone) VALUES($1,$2,$3) RETURNING id", [account, user, `${Date.now()}${++phoneSequence}`])).rows[0].id;
    const conversationId = (await owner.query("INSERT INTO conversations(account_id,user_id,contact_id,status) VALUES($1,$2,$3,'open') RETURNING id", [account, user, contactId])).rows[0].id;
    return { accountId: account, userId: user, contactId, conversationId, metaMessageId: `wamid.${randomUUID()}`, contentType: "text", contentText: "Hi, is this still available?",
      mediaUrl: null, mediaType: null, interactiveReplyId: null, replyToMessageId: null, createdAt: new Date(), wasContactCreated: true, wasConversationCreated: true };
  });
}

const adReferral = () => parseReferral({ source_url: "https://fb.me/abc", source_id: "120211234567890", source_type: "ad",
  headline: "Summer sale", body: "Tap to chat", media_type: "image", ctwa_clid: CLICK_ID });

const jobPayload = async (messageId: string) =>
  (await owner.query("SELECT payload FROM jobs WHERE dedupe_key=$1", [`inbound:${messageId}`])).rows[0]?.payload as Record<string, unknown> | undefined;

describe.skipIf(!ownerUrl || !workerUrl)("click-to-WhatsApp referral attribution", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if ((await owner.query("SELECT current_database() AS name")).rows[0].name !== "bodhinox_test") throw new Error("Referral tests require the isolated bodhinox_test database");
    const worker = await getWorkerPrisma().$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
    if (worker[0].name !== "bodhinox_test") throw new Error("Worker URL must target the same isolated database");
    await owner.query("BEGIN");
    await owner.query("SET LOCAL ROLE bodhinox_auth");
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Referral test owner','test-only-hash'),($3,$4,'Other referral owner','test-only-hash')", [userId, `${userId}@example.invalid`, otherUserId, `${otherUserId}@example.invalid`]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Referral integration',$2),($3,'Other referral tenant',$4)", [accountId, userId, otherAccountId, otherUserId]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($3,$4,'owner')", [accountId, userId, otherAccountId, otherUserId]);
    await owner.query("COMMIT");
  });
  afterAll(async () => {
    if (owner) {
      await owner.query("DELETE FROM accounts WHERE id=ANY($1::uuid[])", [[accountId, otherAccountId]]);
      await owner.query("DELETE FROM auth_users WHERE id=ANY($1::uuid[])", [[userId, otherUserId]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it("stores one referral per message across redeliveries and puts only a summary in the job", async () => {
    const input = { ...(await fixture()), referral: adReferral() };
    const first = await ingestInboundMessage(input);
    const again = await ingestInboundMessage(input);
    expect(first.inserted).toBe(true);
    expect(again.inserted).toBe(false);
    const rows = (await owner.query("SELECT id::text, message_id::text, source_id, source_type, headline, ctwa_clid, has_click_id FROM ad_referrals WHERE account_id=$1 AND wa_message_id=$2", [accountId, input.metaMessageId])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ message_id: first.messageId, source_id: "120211234567890", source_type: "ad", headline: "Summer sale", ctwa_clid: CLICK_ID, has_click_id: true });
    const payload = await jobPayload(first.messageId);
    expect(payload?.adReferral).toEqual({ id: rows[0].id, sourceId: "120211234567890", sourceType: "ad", headline: "Summer sale", sourceUrl: "https://fb.me/abc" });
    expect(JSON.stringify(payload)).not.toContain(CLICK_ID);
  });

  it("keeps the message when the referral is malformed or cannot be stored", async () => {
    const garbage = { ...(await fixture()), referral: parseReferral({ source_id: "act_1'; DROP TABLE x", source_type: { nested: true }, headline: 7, ctwa_clid: "x".repeat(10_000) }) };
    const kept = await ingestInboundMessage(garbage);
    expect(kept.inserted).toBe(true);
    expect((await owner.query("SELECT count(*)::int AS n FROM messages WHERE id=$1", [kept.messageId])).rows[0].n).toBe(1);

    // A value the CHECKs refuse (bypassing the parser) is dropped under its savepoint; the message and its job stay.
    const refused = { ...(await fixture()), referral: { ...adReferral()!, sourceId: "1_2" } };
    const stored = await ingestInboundMessage(refused);
    expect(stored.inserted).toBe(true);
    expect((await owner.query("SELECT count(*)::int AS n FROM ad_referrals WHERE wa_message_id=$1", [refused.metaMessageId])).rows[0].n).toBe(0);
    const payload = await jobPayload(stored.messageId);
    expect(payload).toBeDefined();
    expect(payload).not.toHaveProperty("adReferral");
  });

  it("hides the click id from the app role and every referral from other tenants", async () => {
    const input = { ...(await fixture()), referral: adReferral() };
    const { messageId } = await ingestInboundMessage(input);
    // The app role reads by message (wa_message_id is not granted to it either).
    const visible = await asRole("bodhinox_app", accountId, userId, async () =>
      (await owner.query("SELECT has_click_id, source_id FROM ad_referrals WHERE message_id=$1", [messageId])).rows);
    expect(visible).toEqual([{ has_click_id: true, source_id: "120211234567890" }]);
    await expect(asRole("bodhinox_app", accountId, userId, () => owner.query("SELECT ctwa_clid FROM ad_referrals"))).rejects.toThrow(/permission denied/);
    await expect(asRole("bodhinox_app", accountId, userId, () => owner.query("SELECT id FROM ad_referrals WHERE ctwa_clid IS NOT NULL"))).rejects.toThrow(/permission denied/);
    await expect(asRole("bodhinox_app", accountId, userId, () => owner.query("INSERT INTO ad_referrals(contact_id,wa_message_id,source_type) VALUES($1,'x','ad')", [input.contactId]))).rejects.toThrow(/permission denied/);
    for (const role of ["bodhinox_app", "bodhinox_worker"] as const) {
      const leaked = await asRole(role, otherAccountId, otherUserId, async () =>
        (await owner.query("SELECT id FROM ad_referrals WHERE message_id=$1", [messageId])).rows);
      expect(leaked).toEqual([]);
    }
  });

  it("refuses a referral that points at another tenant's contact", async () => {
    const other = await fixture(otherAccountId, otherUserId);
    await expect(asRole("bodhinox_worker", accountId, userId, () =>
      owner.query("INSERT INTO ad_referrals(account_id,contact_id,wa_message_id,source_type) VALUES($1,$2,$3,'ad')", [accountId, other.contactId, `wamid.${randomUUID()}`]),
    )).rejects.toThrow(/foreign key|violates/);
    await expect(asRole("bodhinox_worker", accountId, userId, () =>
      owner.query("INSERT INTO ad_referrals(account_id,contact_id,wa_message_id,source_type) VALUES($1,$2,$3,'ad')", [otherAccountId, other.contactId, `wamid.${randomUUID()}`]),
    )).rejects.toThrow(/row-level security|violates/);
  });

  it("accepts an ad_click flow trigger", async () => {
    const flowId = await asRole("bodhinox_worker", accountId, userId, async () =>
      (await owner.query("INSERT INTO flows(account_id,user_id,name,trigger_type,trigger_config) VALUES($1,$2,'From ads','ad_click',$3) RETURNING id", [accountId, userId, JSON.stringify({ ad_ids: ["120211234567890"] })])).rows[0].id);
    expect(flowId).toBeTruthy();
  });
});
