import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { withTenant } from "./tenant";

config({ path: ".env.test", quiet: true });
const connectionString = process.env.TEST_DATABASE_URL;
const accountA = randomUUID(), accountB = randomUUID(), userA = randomUUID(), userB = randomUUID();
let pool: pg.Pool;

async function tenant<T>(accountId: string | null, operation: (db: pg.PoolClient) => Promise<T>, role = "bodhinox_app") {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query(`SET LOCAL ROLE ${role}`);
    await db.query("SELECT set_config('app.account_id',$1,true),set_config('app.user_id',$2,true),set_config('app.account_role','owner',true)", [accountId || "", accountId === accountB ? userB : userA]);
    const result = await operation(db);
    await db.query("COMMIT");
    return result;
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
}

describe.skipIf(!connectionString)("real PostgreSQL tenant and concurrency guarantees", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString, max: 2 });
    const name = await pool.query("SELECT current_database() AS name");
    if (!/test/i.test(name.rows[0].name)) throw new Error("Integration tests require a separately named test database");
    await pool.query("BEGIN");
    await pool.query("SET LOCAL ROLE bodhinox_auth");
    await pool.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Test owner','test-only-hash'),($3,$4,'Test owner B','test-only-hash')", [userA,`${userA}@example.invalid`,userB,`${userB}@example.invalid`]);
    await pool.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Integration A',$2),($3,'Integration B',$4)",[accountA,userA,accountB,userB]);
    await pool.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($3,$4,'owner')",[accountA,userA,accountB,userB]);
    await pool.query("INSERT INTO profiles(user_id,email,full_name,account_id,account_role) VALUES($1,$2,'Test owner',$3,'owner'),($4,$5,'Test owner B',$6,'owner')",[userA,`${userA}@example.invalid`,accountA,userB,`${userB}@example.invalid`,accountB]);
    await pool.query("COMMIT");
  });
  afterAll(async () => { await pool?.end(); });

  it("installs all retained entities and runtime roles cannot bypass tenant policies", async () => {
    const tables = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
    expect(tables.rows.map(row => row.table_name)).toEqual(expect.arrayContaining(["contacts","flows","ai_knowledge_chunks","jobs","auth_users"]));
    const roles = await pool.query("SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=ANY($1)",[["bodhinox_app","bodhinox_auth","bodhinox_worker"]]);
    expect(roles.rows).toHaveLength(3);
    for (const row of roles.rows) { expect(row.rolsuper).toBe(false); expect(row.rolbypassrls).toBe(false); }
  });

  it("isolates overlapping phone identities and rejects cross-tenant related IDs", async () => {
    const contactA = await tenant(accountA, async db => (await db.query("INSERT INTO contacts(user_id,phone) VALUES($1,'+91 12345') RETURNING id",[userA])).rows[0].id);
    const contactB = await tenant(accountB, async db => (await db.query("INSERT INTO contacts(user_id,phone) VALUES($1,'+91 12345') RETURNING id",[userB])).rows[0].id);
    const tagB = await tenant(accountB, async db => (await db.query("INSERT INTO tags(user_id,name) VALUES($1,'Other tenant') RETURNING id",[userB])).rows[0].id);
    expect(await tenant(accountA,async db => (await db.query("SELECT id FROM contacts WHERE id=$1",[contactB])).rows)).toEqual([]);
    await expect(tenant(accountA,db=>db.query("INSERT INTO contact_tags(contact_id,tag_id) VALUES($1,$2)",[contactA,tagB]))).rejects.toMatchObject({code:"23503"});
    await expect(tenant(accountA,db=>db.query("INSERT INTO contacts(account_id,user_id,phone) VALUES($1,$2,'555')",[accountB,userA]))).rejects.toMatchObject({code:"42501"});
    await expect(tenant(accountA,db=>db.query("INSERT INTO contacts(user_id,phone) VALUES($1,'9112345')",[userA]))).rejects.toMatchObject({code:"23505"});
  });

  it("missing transaction scope returns no domain rows and pool reuse clears tenant settings", async () => {
    expect(await tenant(null,async db=>(await db.query("SELECT id FROM contacts")).rows)).toEqual([]);
    await tenant(accountA,db=>db.query("SELECT id FROM contacts"));
    expect(await tenant(null,async db=>(await db.query("SELECT id FROM contacts")).rows)).toEqual([]);
    const local = await pool.query("SELECT NULLIF(current_setting('app.account_id',true),'') AS tenant");
    expect(local.rows[0].tenant).toBeNull();
  });

  it("identity credentials have no arbitrary CRM access", async () => {
    await expect(tenant(accountA,db=>db.query("SELECT * FROM contacts"),"bodhinox_auth")).rejects.toMatchObject({code:"42501"});
  });

  it("preserves message idempotency, atomic unread increments and active-flow uniqueness", async () => {
    const contact = await tenant(accountA,async db=>(await db.query("INSERT INTO contacts(user_id,phone) VALUES($1,'777') RETURNING id",[userA])).rows[0].id);
    const conversation = await tenant(accountA,async db=>(await db.query("INSERT INTO conversations(user_id,contact_id) VALUES($1,$2) RETURNING id",[userA,contact])).rows[0].id);
    await tenant(accountA,db=>db.query("INSERT INTO messages(conversation_id,sender_type,message_id) VALUES($1,'customer','unique-provider-message')",[conversation]));
    await expect(tenant(accountA,db=>db.query("INSERT INTO messages(conversation_id,sender_type,message_id) VALUES($1,'customer','unique-provider-message')",[conversation]))).rejects.toMatchObject({code:"23505"});
    await Promise.all(Array.from({length:8},()=>tenant(accountA,db=>db.query("SELECT bump_conversation_on_inbound($1,'hello')",[conversation]))));
    const unread = await tenant(accountA,async db=>(await db.query("SELECT unread_count FROM conversations WHERE id=$1",[conversation])).rows[0].unread_count);
    expect(unread).toBe(8);
    const flow = await tenant(accountA,async db=>(await db.query("INSERT INTO flows(user_id,name,trigger_type) VALUES($1,'Test','manual') RETURNING id",[userA])).rows[0].id);
    await tenant(accountA,db=>db.query("INSERT INTO flow_runs(flow_id,user_id,contact_id) VALUES($1,$2,$3)",[flow,userA,contact]));
    await expect(tenant(accountA,db=>db.query("INSERT INTO flow_runs(flow_id,user_id,contact_id) VALUES($1,$2,$3)",[flow,userA,contact]))).rejects.toMatchObject({code:"23505"});
  });

  it("orders same-second customer messages by durable arrival under both runtime roles", async () => {
    const contact = await tenant(accountA,async db=>(await db.query("INSERT INTO contacts(user_id,phone) VALUES($1,'arrival-order-fixture') RETURNING id",[userA])).rows[0].id);
    const conversation = await tenant(accountA,async db=>(await db.query("INSERT INTO conversations(user_id,contact_id) VALUES($1,$2) RETURNING id",[userA,contact])).rows[0].id);
    for (const [index,role] of ['bodhinox_app','bodhinox_worker'].entries()) {
      await tenant(accountA,db=>db.query("INSERT INTO messages(conversation_id,sender_type,content_text,created_at) VALUES($1,'customer',$2,'2026-10-19T10:00:00Z')",[conversation,`question-${index}`]),role);
    }
    const rows = await tenant(accountA,async db=>(await db.query("SELECT content_text FROM messages WHERE conversation_id=$1 ORDER BY created_at DESC,arrival_sequence DESC",[conversation])).rows);
    expect(rows.map(row=>row.content_text)).toEqual(['question-1','question-0']);
  });

  it("keeps lexical retrieval scoped and callable under the constrained role", async () => {
    await tenant(accountA,async db=>{
      const doc=(await db.query("INSERT INTO ai_knowledge_documents(title,content) VALUES('FAQ','Cancellation policy') RETURNING id")).rows[0].id;
      await db.query("INSERT INTO ai_knowledge_chunks(document_id,content) VALUES($1,'Cancellation policy refund')",[doc]);
      expect((await db.query("SELECT * FROM match_ai_knowledge_fts($1,'refund',10)",[accountA])).rows).toHaveLength(1);
      expect((await db.query("SELECT * FROM match_ai_knowledge_fts($1,'refund',10)",[accountB])).rows).toEqual([]);
    });
  });

  it("retrieves natural questions by meaningful keywords and ranks keyword coverage", async () => {
    await tenant(accountA,async db=>{
      const doc=(await db.query("INSERT INTO ai_knowledge_documents(title,content) VALUES('Delivery FAQ','Delivery details') RETURNING id")).rows[0].id;
      const chunks=(await db.query("INSERT INTO ai_knowledge_chunks(document_id,content) VALUES($1,'Overnight shipping costs 25 dollars.'),($1,'Shipping is available worldwide.'),($1,'You can ask us about the weather.') RETURNING id",[doc])).rows;
      const found=(await db.query("SELECT * FROM match_ai_knowledge_fts($1,$2,10)",[accountA,"Could you please explain your overnight shipping charges?"])).rows;
      expect(found.map(row=>row.id)).toEqual([chunks[0].id,chunks[1].id]);
      expect(found[0].rank).toBeGreaterThan(found[1].rank);
      expect((await db.query("SELECT * FROM match_ai_knowledge_fts($1,$2,10)",[accountA,"Could you please explain your telescope warranty?"])).rows).toEqual([]);
      expect((await db.query("SELECT * FROM match_ai_knowledge_fts($1,$2,10)",[accountA,"Could you please explain what this is about?"])).rows).toEqual([]);
      expect((await db.query("SELECT * FROM match_ai_knowledge_fts($1,$2,10)",[accountB,"overnight shipping"])).rows).toEqual([]);
      expect((await db.query("SELECT * FROM match_ai_knowledge_fts($1,$2,1)",[accountA,"overnight shipping"])).rows.map(row=>row.id)).toEqual([chunks[0].id]);
      expect((await db.query("SELECT * FROM match_ai_knowledge_fts($1,$2,0)",[accountA,"overnight shipping"])).rows).toEqual([]);
      // Query punctuation must never become tsquery syntax or broaden to function words.
      expect((await db.query("SELECT * FROM match_ai_knowledge_fts($1,$2,10)",[accountA,"'overnight' | !telescope & (shipping):*"])).rows.map(row=>row.id)).toEqual([chunks[0].id,chunks[1].id]);
    });
  });

  it("stores lease fencing and replayable outbound result columns", async () => {
    const fields=await pool.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND ((table_name='jobs' AND column_name='lease_token') OR (table_name='outbound_intents' AND column_name='result'))");
    expect(fields.rows.map(row=>`${row.table_name}.${row.column_name}`).sort()).toEqual(["jobs.lease_token","outbound_intents.result"]);
  });

  it("resolves a WABA only for the worker and fails closed for ambiguous tenant mapping", async () => {
    const waba=randomUUID();
    await tenant(accountA,db=>db.query("INSERT INTO whatsapp_config(user_id,phone_number_id,waba_id,access_token) VALUES($1,$2,$3,'test-only-encrypted-token')",[userA,randomUUID(),waba]));
    await expect(tenant(null,db=>db.query("SELECT crm_resolve_waba_account($1)",[waba]))).rejects.toMatchObject({code:"42501"});
    const resolved=await tenant(null,async db=>(await db.query("SELECT crm_resolve_waba_account($1) AS account_id",[waba])).rows[0].account_id,"bodhinox_worker");
    expect(resolved).toBe(accountA);
    await tenant(accountB,db=>db.query("INSERT INTO whatsapp_config(user_id,phone_number_id,waba_id,access_token) VALUES($1,$2,$3,'test-only-encrypted-token')",[userB,randomUUID(),waba]));
    const ambiguous=await tenant(null,async db=>(await db.query("SELECT crm_resolve_waba_account($1) AS account_id",[waba])).rows[0].account_id,"bodhinox_worker");
    expect(ambiguous).toBeNull();
  });

  it("executes atomic broadcast creation, counters and historical contact deletion", async () => {
    await tenant(accountA,async db=>{
      const contacts=(await db.query("INSERT INTO contacts(user_id,phone) VALUES($1,$2),($1,$3) RETURNING id",[userA,`${Date.now()}001`,`${Date.now()}002`])).rows.map(row=>row.id);
      const recipients=(await db.query("SELECT * FROM create_broadcast_with_recipients($1::uuid,$2::uuid,'Test campaign','promo','en_US',2,$3::uuid[])",[accountA,userA,contacts])).rows;
      expect(recipients).toHaveLength(2);
      await db.query("UPDATE broadcast_recipients SET status='delivered' WHERE id=$1",[recipients[0].recipient_id]);
      await db.query("UPDATE broadcast_recipients SET status='failed' WHERE id=$1",[recipients[1].recipient_id]);
      const before=(await db.query("SELECT sent_count,delivered_count,failed_count FROM broadcasts WHERE id=$1",[recipients[0].broadcast_id])).rows[0];
      expect(before).toEqual({sent_count:1,delivered_count:1,failed_count:1});
      await db.query("SELECT recompute_broadcast_counts($1)",[recipients[0].broadcast_id]);
      await db.query("DELETE FROM contacts WHERE id=$1",[contacts[0]]);
      const historic=(await db.query("SELECT contact_id,account_id,status FROM broadcast_recipients WHERE id=$1",[recipients[0].recipient_id])).rows[0];
      expect(historic).toEqual({contact_id:null,account_id:accountA,status:"delivered"});
    });
  });

  it("executes tenant-scoped pgvector retrieval under the constrained role", async () => {
    await tenant(accountA,async db=>{
      const embedding=JSON.stringify([1,...Array.from({length:1535},()=>0)]);
      const doc=(await db.query("INSERT INTO ai_knowledge_documents(title,content) VALUES('Semantic FAQ','Reference passage') RETURNING id")).rows[0].id;
      await db.query("INSERT INTO ai_knowledge_chunks(document_id,content,embedding) VALUES($1,'Reference passage',$2::vector)",[doc,embedding]);
      const found=(await db.query("SELECT * FROM match_ai_knowledge_semantic($1,$2,5)",[accountA,embedding])).rows;
      expect(found).toHaveLength(1);
      expect(found[0].distance).toBe(0);
      expect((await db.query("SELECT * FROM match_ai_knowledge_semantic($1,$2,5)",[accountB,embedding])).rows).toEqual([]);
    });
  });

  it("allows only the worker to enumerate workspaces with payment work to reconcile", async () => {
    await tenant(accountA,db=>db.query("INSERT INTO payment_links(account_id,provider,reference_id,amount_minor,currency,status) VALUES($1,'razorpay',$2,100,'INR','unknown')",[accountA,`pl_rec_${accountA.replace(/-/g,"").slice(0,24)}`]),"bodhinox_worker");
    await expect(tenant(null,db=>db.query("SELECT * FROM crm_accounts_for_payment_reconcile()"))).rejects.toMatchObject({code:"42501"});
    const rows=await tenant(null,async db=>(await db.query("SELECT * FROM crm_accounts_for_payment_reconcile()")).rows,"bodhinox_worker");
    expect(rows.map(row=>row.account_id)).toContain(accountA);
    expect(rows.map(row=>row.account_id)).not.toContain(accountB);
    for(const row of rows) expect(Object.keys(row)).toEqual(["account_id"]);
  });

  it("allows only the worker to enumerate scheduling account IDs", async () => {
    await tenant(accountA,db=>db.query("INSERT INTO automations(user_id,name,trigger_type,is_active) VALUES($1,'Scheduled test','time_based',true)",[userA]));
    await expect(tenant(null,db=>db.query("SELECT * FROM crm_accounts_for_scheduling()"))).rejects.toMatchObject({code:"42501"});
    const rows=await tenant(null,async db=>(await db.query("SELECT * FROM crm_accounts_for_scheduling()")).rows,"bodhinox_worker");
    expect(rows.map(row=>row.account_id)).toContain(accountA);
    expect(rows.map(row=>row.account_id)).not.toContain(accountB);
    for(const row of rows) expect(Object.keys(row)).toEqual(["account_id"]);
  });

  it("allows agent bot-pause changes, denies viewer changes and exposes the scoped flag to the worker",async()=>{
    const column=(await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='conversations' AND column_name='bot_paused'")).rows;
    expect(column).toHaveLength(1);
    const appUrl=process.env.TEST_APP_DATABASE_URL;
    const workerUrl=process.env.TEST_WORKER_DATABASE_URL||process.env.WORKER_DATABASE_URL;
    if(!appUrl||!workerUrl)throw new Error("Separate constrained test app and worker URLs are required");
    const app=new PrismaClient({adapter:new PrismaPg({connectionString:appUrl})});
    const worker=new PrismaClient({adapter:new PrismaPg({connectionString:workerUrl})});
    try {
      const contact=await tenant(accountA,async db=>(await db.query("INSERT INTO contacts(user_id,phone) VALUES($1,$2) RETURNING id",[userA,`${Date.now()}999`])).rows[0].id);
      const conversation=await tenant(accountA,async db=>(await db.query("INSERT INTO conversations(user_id,contact_id) VALUES($1,$2) RETURNING id",[userA,contact])).rows[0].id);
      expect(await withTenant({accountId:accountA,userId:userA,role:"agent"},tx=>tx.$executeRaw`UPDATE conversations SET bot_paused=true WHERE id=${conversation}::uuid`,app)).toBe(1);
      expect(await withTenant({accountId:accountA,userId:userA,role:"viewer"},tx=>tx.$executeRaw`UPDATE conversations SET bot_paused=false WHERE id=${conversation}::uuid`,app)).toBe(0);
      const rows=await withTenant({accountId:accountA},tx=>tx.$queryRaw<{bot_paused:boolean}[]>`SELECT bot_paused FROM conversations WHERE id=${conversation}::uuid`,worker);
      expect(rows).toEqual([{bot_paused:true}]);
    } finally {await Promise.all([app.$disconnect(),worker.$disconnect()]);}
  });
});
