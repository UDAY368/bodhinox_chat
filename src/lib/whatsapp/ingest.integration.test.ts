import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disconnectDatabases, getWorkerPrisma } from "@/lib/db/prisma";
import { applyProviderStatus, ingestInboundMessage, runInboundStage, type IngestInboundInput } from "./ingest";
import { UncertainDispatchError } from "@/lib/jobs/dispatch";

const configured=config({ path: ".env.test", quiet: true }).parsed;
const workerUrl=process.env.TEST_WORKER_DATABASE_URL||configured?.WORKER_DATABASE_URL;
if(workerUrl) process.env.WORKER_DATABASE_URL=workerUrl;
const ownerUrl = process.env.TEST_DATABASE_URL;
let owner: pg.Client;
const accountId=randomUUID(),otherAccountId=randomUUID(),userId=randomUUID(),otherUserId=randomUUID();
let phoneSequence=0;

async function fixture():Promise<IngestInboundInput> {
  await owner.query("BEGIN");
  try {
    await owner.query("SET LOCAL ROLE bodhinox_worker");
    await owner.query("SELECT set_config('app.account_id',$1,true),set_config('app.user_id',$2,true),set_config('app.account_role','owner',true)",[accountId,userId]);
    const contactId=(await owner.query("INSERT INTO contacts(account_id,user_id,phone) VALUES($1,$2,$3) RETURNING id",[accountId,userId,`${Date.now()}${++phoneSequence}`])).rows[0].id;
    const conversationId=(await owner.query("INSERT INTO conversations(account_id,user_id,contact_id,status) VALUES($1,$2,$3,'closed') RETURNING id",[accountId,userId,contactId])).rows[0].id;
    await owner.query("COMMIT");
    return {accountId,userId,contactId,conversationId,metaMessageId:randomUUID(),contentType:"text",contentText:"Test inbound",
      mediaUrl:null,mediaType:null,interactiveReplyId:null,replyToMessageId:null,createdAt:new Date(),wasContactCreated:true,wasConversationCreated:true};
  } catch(error) {await owner.query("ROLLBACK");throw error;}
}

describe.skipIf(!ownerUrl||!workerUrl)("durable inbound ingestion and status guarantees", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if ((await owner.query("SELECT current_database() AS name")).rows[0].name !== "bodhinox_test") throw new Error("Inbound tests require the isolated bodhinox_test database");
    const worker=await getWorkerPrisma().$queryRaw<{name:string}[]>`SELECT current_database() AS name`;
    if(worker[0].name!=="bodhinox_test") throw new Error("Worker URL must target the same isolated database");
    await owner.query("BEGIN");
    await owner.query("SET LOCAL ROLE bodhinox_auth");
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Inbound test owner','test-only-hash'),($3,$4,'Other test owner','test-only-hash')",[userId,`${userId}@example.invalid`,otherUserId,`${otherUserId}@example.invalid`]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Inbound integration',$2),($3,'Other inbound tenant',$4)",[accountId,userId,otherAccountId,otherUserId]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($3,$4,'owner')",[accountId,userId,otherAccountId,otherUserId]);
    await owner.query("COMMIT");
  });
  afterAll(async () => {
    if(owner) {
      await owner.query("DELETE FROM accounts WHERE id=ANY($1::uuid[])",[[accountId,otherAccountId]]);
      await owner.query("DELETE FROM auth_users WHERE id=ANY($1::uuid[])",[[userId,otherUserId]]);
      await owner.end();
    }
    await disconnectDatabases();
  });
  it("has persistent per-message stage checkpoints instead of process-local progress", async () => {
    const row = (await owner.query("SELECT to_regclass('public.inbound_action_steps') AS table_name")).rows[0];
    expect(row.table_name).toBe("inbound_action_steps");
  });

  it("keeps creation markers across a pre-ingest crash without marking later messages as new entities",async()=>{
    const columns=(await owner.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('contacts','conversations') AND column_name='inbound_created_meta_id'")).rows;
    expect(columns).toHaveLength(2);
    const input=await fixture();
    await owner.query("UPDATE contacts SET inbound_created_meta_id=$1 WHERE id=$2",[input.metaMessageId,input.contactId]);
    await owner.query("UPDATE conversations SET inbound_created_meta_id=$1 WHERE id=$2",[input.metaMessageId,input.conversationId]);
    const markers=(await owner.query("SELECT c.inbound_created_meta_id AS contact_marker,v.inbound_created_meta_id AS conversation_marker FROM contacts c JOIN conversations v ON v.contact_id=c.id WHERE c.id=$1 AND v.id=$2",[input.contactId,input.conversationId])).rows[0];
    const retry={...input,wasContactCreated:markers.contact_marker===input.metaMessageId,wasConversationCreated:markers.conversation_marker===input.metaMessageId};
    const first=await ingestInboundMessage(retry);
    expect((await owner.query("SELECT payload FROM jobs WHERE dedupe_key=$1",[`inbound:${first.messageId}`])).rows[0].payload).toMatchObject({wasContactCreated:true,wasConversationCreated:true});
    const nextMetaId=randomUUID();
    const next=await ingestInboundMessage({...input,metaMessageId:nextMetaId,wasContactCreated:markers.contact_marker===nextMetaId,wasConversationCreated:markers.conversation_marker===nextMetaId});
    expect((await owner.query("SELECT payload FROM jobs WHERE dedupe_key=$1",[`inbound:${next.messageId}`])).rows[0].payload).toMatchObject({wasContactCreated:false,wasConversationCreated:false});
  });

  it("retries an early provider status until outbound persistence exists and then preserves stale no-ops",async()=>{
    const input=await fixture();
    const event={id:input.metaMessageId,status:"read",timestamp:String(Math.floor(Date.now()/1000))};
    await expect(applyProviderStatus(accountId,event)).rejects.toMatchObject({name:"StatusAwaitingPersistenceError"});
    expect((await owner.query("SELECT count(*)::int AS count FROM jobs WHERE tenant_id=$1 AND payload->>'metaMessageId'=$2",[accountId,input.metaMessageId])).rows[0].count).toBe(0);
    const messageId=(await owner.query("INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,message_id,status) VALUES($1,$2,'bot','text','Test outbound',$3,'sent') RETURNING id",[accountId,input.conversationId,input.metaMessageId])).rows[0].id;
    await applyProviderStatus(accountId,event);
    await expect(applyProviderStatus(accountId,{...event,status:"delivered"})).resolves.toBeUndefined();
    await expect(applyProviderStatus(accountId,event)).resolves.toBeUndefined();
    expect((await owner.query("SELECT status FROM messages WHERE id=$1",[messageId])).rows[0].status).toBe("read");
    expect((await owner.query("SELECT count(*)::int AS count FROM jobs WHERE dedupe_key=$1",[`status:${messageId}:read`])).rows[0].count).toBe(1);
  });

  it("concurrent duplicates commit exactly one message, unread increment and action job",async()=>{
    const input=await fixture();
    const results=await Promise.all([ingestInboundMessage(input),ingestInboundMessage(input)]);
    expect(results.filter(result=>result.inserted)).toHaveLength(1);
    expect(results.map(result=>result.messageId)).toEqual([results[0].messageId,results[0].messageId]);
    expect((await owner.query("SELECT unread_count,status FROM conversations WHERE id=$1",[input.conversationId])).rows[0]).toEqual({unread_count:1,status:"open"});
    const jobs=(await owner.query("SELECT payload FROM jobs WHERE tenant_id=$1 AND dedupe_key=$2",[accountId,`inbound:${results[0].messageId}`])).rows;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload).toMatchObject({kind:"message",messageId:results[0].messageId,accountId,isFirstInboundMessage:true});
    expect(Object.keys(jobs[0].payload)).not.toContain("accessToken");
  });

  it("job persistence failure rolls back message, unread and committed domain events",async()=>{
    const input=await fixture();
    const before=(await owner.query("SELECT count(*)::int AS count FROM outbox_events WHERE account_id=$1",[accountId])).rows[0].count;
    const name=`test_fail_ingest_${randomUUID().replaceAll("-","")}`;
    await owner.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tenant_id='${accountId}'::uuid AND NEW.type='inbound.actions' THEN RAISE EXCEPTION 'Simulated test queue persistence failure'; END IF; RETURN NEW; END $$`);
    await owner.query(`CREATE TRIGGER ${name} BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    try {
      await expect(ingestInboundMessage(input)).rejects.toBeDefined();
      expect((await owner.query("SELECT id FROM messages WHERE conversation_id=$1",[input.conversationId])).rows).toEqual([]);
      expect((await owner.query("SELECT unread_count,status FROM conversations WHERE id=$1",[input.conversationId])).rows[0]).toEqual({unread_count:0,status:"closed"});
      expect((await owner.query("SELECT count(*)::int AS count FROM outbox_events WHERE account_id=$1",[accountId])).rows[0].count).toBe(before);
    } finally {
      await owner.query(`DROP TRIGGER ${name} ON jobs`);
      await owner.query(`DROP FUNCTION ${name}()`);
    }
  });

  it("stores a shared location's coordinates for flows, and nothing extra for plain text",async()=>{
    const input=await fixture();
    const location={location:{latitude:12.97,longitude:77.59,name:"Office"}};
    const {messageId}=await ingestInboundMessage({...input,contentType:"location",contentText:"Office - 12.97,77.59",interactivePayload:location});
    const plain=await ingestInboundMessage({...input,metaMessageId:randomUUID()});
    const rows=(await owner.query("SELECT id,interactive_payload FROM messages WHERE id=ANY($1::uuid[])",[[messageId,plain.messageId]])).rows;
    expect(rows.find(row=>row.id===messageId)?.interactive_payload).toEqual(location);
    expect(rows.find(row=>row.id===plain.messageId)?.interactive_payload).toBeNull();
  });

  it("serializes distinct first inbounds so only one actions payload is marked first",async()=>{
    const input=await fixture();
    const results=await Promise.all([ingestInboundMessage(input),ingestInboundMessage({...input,metaMessageId:randomUUID()})]);
    expect(results.filter(result=>result.isFirstInboundMessage)).toHaveLength(1);
    expect((await owner.query("SELECT unread_count FROM conversations WHERE id=$1",[input.conversationId])).rows[0].unread_count).toBe(2);
  });

  it("concurrent and reordered provider status events never downgrade messages or recipient counters",async()=>{
    const input=await fixture();
    const message=(await ingestInboundMessage(input)).messageId;
    await owner.query("UPDATE messages SET status='sent' WHERE id=$1",[message]);
    const broadcast=(await owner.query("INSERT INTO broadcasts(account_id,user_id,name,template_name) VALUES($1,$2,'Status test','test-template') RETURNING id",[accountId,userId])).rows[0].id;
    await owner.query("INSERT INTO broadcast_recipients(account_id,broadcast_id,contact_id,whatsapp_message_id,status) VALUES($1,$2,$3,$4,'sent')",[accountId,broadcast,input.contactId,input.metaMessageId]);
    const event={id:input.metaMessageId,timestamp:String(Math.floor(Date.now()/1000))};
    await Promise.all(["read","sent","delivered"].map(status=>applyProviderStatus(accountId,{...event,status})));
    await applyProviderStatus(accountId,{...event,status:"failed",errors:[{code:123,title:"Late failed event"}]});
    await applyProviderStatus(accountId,{...event,status:"sent"});
    expect((await owner.query("SELECT status FROM messages WHERE id=$1",[message])).rows[0].status).toBe("read");
    expect((await owner.query("SELECT status FROM broadcast_recipients WHERE broadcast_id=$1",[broadcast])).rows[0].status).toBe("read");
    expect((await owner.query("SELECT sent_count,delivered_count,read_count,failed_count FROM broadcasts WHERE id=$1",[broadcast])).rows[0]).toEqual({sent_count:1,delivered_count:1,read_count:1,failed_count:0});
    const readJobs=(await owner.query("SELECT id FROM jobs WHERE dedupe_key=$1",[`status:${message}:read`])).rows;
    expect(readJobs).toHaveLength(1);
  });

  it("completed inbound stages replay their saved result without invoking the action again",async()=>{
    const input=await fixture();const message=(await ingestInboundMessage(input)).messageId;let calls=0;
    const action=async()=>{calls++;return {consumed:true};};
    expect(await runInboundStage(accountId,message,"flow",action)).toEqual({consumed:true});
    expect(await runInboundStage(accountId,message,"flow",action)).toEqual({consumed:true});
    expect(calls).toBe(1);
  });

  it("interrupted or failed stages stay uncertain and cannot resend automatically",async()=>{
    const input=await fixture();const message=(await ingestInboundMessage(input)).messageId;let calls=0;
    await owner.query("INSERT INTO inbound_action_steps(account_id,message_id,stage,status) VALUES($1,$2,'interrupted','dispatching')",[accountId,message]);
    await expect(runInboundStage(accountId,message,"interrupted",async()=>{calls++;})).rejects.toBeInstanceOf(UncertainDispatchError);
    expect(calls).toBe(0);
    const failed=async()=>{calls++;throw new Error("Simulated uncertain provider stage");};
    await expect(runInboundStage(accountId,message,"ai_reply",failed)).rejects.toBeInstanceOf(UncertainDispatchError);
    await expect(runInboundStage(accountId,message,"ai_reply",failed)).rejects.toBeInstanceOf(UncertainDispatchError);
    expect(calls).toBe(1);
    expect((await owner.query("SELECT status FROM inbound_action_steps WHERE message_id=$1 AND stage='ai_reply'",[message])).rows[0].status).toBe("uncertain");
  });

  it("rejects a cross-tenant conversation before any message or job can persist",async()=>{
    const input=await fixture();
    await expect(ingestInboundMessage({...input,accountId:otherAccountId,userId:otherUserId})).rejects.toThrow("Inbound conversation is unavailable");
    expect((await owner.query("SELECT id FROM messages WHERE account_id=$1",[otherAccountId])).rows).toEqual([]);
    expect((await owner.query("SELECT id FROM jobs WHERE tenant_id=$1",[otherAccountId])).rows).toEqual([]);
  });
});
