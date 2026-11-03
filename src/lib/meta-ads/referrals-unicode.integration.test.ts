import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disconnectDatabases, getWorkerPrisma } from "@/lib/db/prisma";
import { ingestInboundMessage, type IngestInboundInput } from "@/lib/whatsapp/ingest";
import { parseReferral } from "./referrals";

// A referral headline whose 256-unit summary cut lands inside an emoji must not
// put an unpaired surrogate into the inbound.actions job payload: jsonb rejects
// one, which would roll back the whole message transaction on every redelivery.

const configured = config({ path: ".env.test", quiet: true }).parsed;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
const ownerUrl = process.env.TEST_DATABASE_URL;
let owner: pg.Client;
const accountId = randomUUID(), userId = randomUUID();

describe.skipIf(!ownerUrl || !workerUrl)("click-to-WhatsApp referral with an astral headline", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if ((await owner.query("SELECT current_database() AS name")).rows[0].name !== "bodhinox_test") throw new Error("Referral tests require the isolated bodhinox_test database");
    const worker = await getWorkerPrisma().$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
    if (worker[0].name !== "bodhinox_test") throw new Error("Worker URL must target the same isolated database");
    await owner.query("BEGIN");
    await owner.query("SET LOCAL ROLE bodhinox_auth");
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Referral unicode owner','test-only-hash')", [userId, `${userId}@example.invalid`]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Referral unicode',$2)", [accountId, userId]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner')", [accountId, userId]);
    await owner.query("COMMIT");
  });
  afterAll(async () => {
    if (owner) {
      await owner.query("DELETE FROM accounts WHERE id=$1", [accountId]);
      await owner.query("DELETE FROM auth_users WHERE id=$1", [userId]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  async function fixture(): Promise<IngestInboundInput> {
    await owner.query("BEGIN");
    try {
      await owner.query("SET LOCAL ROLE bodhinox_worker");
      await owner.query("SELECT set_config('app.account_id',$1,true),set_config('app.user_id',$2,true),set_config('app.account_role','owner',true)", [accountId, userId]);
      const contactId = (await owner.query("INSERT INTO contacts(account_id,user_id,phone) VALUES($1,$2,$3) RETURNING id", [accountId, userId, `${Date.now()}7`])).rows[0].id;
      const conversationId = (await owner.query("INSERT INTO conversations(account_id,user_id,contact_id,status) VALUES($1,$2,$3,'open') RETURNING id", [accountId, userId, contactId])).rows[0].id;
      await owner.query("COMMIT");
      return { accountId, userId, contactId, conversationId, metaMessageId: `wamid.${randomUUID()}`, contentType: "text", contentText: "Hi",
        mediaUrl: null, mediaType: null, interactiveReplyId: null, replyToMessageId: null, createdAt: new Date(), wasContactCreated: true, wasConversationCreated: true };
    } catch (error) {
      await owner.query("ROLLBACK");
      throw error;
    }
  }

  it("stores the message and its actions job for a 255-ASCII + emoji headline", async () => {
    const headline = `${"h".repeat(255)}\u{1F600} and more`;
    const referral = parseReferral({ source_type: "ad", source_id: "120211234567890", headline, ctwa_clid: "ARAkLkA8rmlFeiCkt" });
    const result = await ingestInboundMessage({ ...(await fixture()), referral });
    expect(result.inserted).toBe(true);
    expect((await owner.query("SELECT count(*)::int AS n FROM messages WHERE id=$1", [result.messageId])).rows[0].n).toBe(1);
    const job = (await owner.query("SELECT payload FROM jobs WHERE dedupe_key=$1", [`inbound:${result.messageId}`])).rows[0]?.payload;
    expect(job?.adReferral?.headline).toBe("h".repeat(255));
    const stored = (await owner.query("SELECT headline FROM ad_referrals WHERE message_id=$1", [result.messageId])).rows[0];
    expect(stored?.headline).toBe(headline);
  });
});
