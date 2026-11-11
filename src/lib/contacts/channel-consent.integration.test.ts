// Stage 5 (5D) on PostgreSQL: Instagram subscription is per channel.
// - An Instagram STOP sets instagram_opted_out_at only, ends the contact's
//   Instagram flow runs and parked Instagram automation runs (with a log note),
//   and leaves WhatsApp runs, the contact-wide opt-out and other workspaces alone.
// - START clears it and stamps instagram_opted_in_at; both are idempotent.
// - instagramAutomationAllowed follows it, and is false for another workspace's contact.
// - Settings: admins save (RLS), agents cannot; an attached flow must be this
//   workspace's Instagram or any-channel flow (another workspace's id is invalid_flow).
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases } from '@/lib/db/prisma';
import { encrypt } from '@/lib/whatsapp/encryption';
import {
  applyInstagramConsent,
  ConsentSettingsError,
  instagramAutomationAllowed,
  INSTAGRAM_OPT_OUT_WHILE_WAITING,
  loadConsentSettings,
  saveConsentSettings,
  workerConsentSettings,
} from './channel-consent';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const A = randomUUID(), B = randomUUID();
const ownerA = randomUUID(), adminA = randomUUID(), agentA = randomUUID(), ownerB = randomUUID();
const seed = String(Date.now()).slice(-8);
let db: pg.Client;
const q = (sql: string, params: unknown[] = []) => db.query(sql, params);

interface Thread { contact: string; ig: string; wa: string }
let a: Thread, b: Thread;
let igFlowA: string, waFlowA: string, igFlowB: string;

async function thread(account: string, user: string, igUserId: string): Promise<Thread> {
  const igAccount = (await q(`INSERT INTO instagram_accounts(account_id,ig_user_id,username,access_token_enc,scopes,connected_by_user_id)
    VALUES($1,$2,'shop',$3,$4,$5) RETURNING id`, [account, igUserId, encrypt('test-only-ig-token'),
    ['instagram_business_basic', 'instagram_business_manage_messages'], user])).rows[0].id;
  const contact = (await q("INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$3,'Consent') RETURNING id",
    [account, user, `1417${seed}${igUserId.slice(-1)}`])).rows[0].id;
  await q("INSERT INTO contact_channel_identities(account_id,contact_id,channel,instagram_account_id,external_id) VALUES($1,$2,'instagram',$3,$4)",
    [account, contact, igAccount, `9${igUserId}`]);
  const ig = (await q("INSERT INTO conversations(account_id,user_id,contact_id,channel,instagram_account_id) VALUES($1,$2,$3,'instagram',$4) RETURNING id",
    [account, user, contact, igAccount])).rows[0].id;
  const wa = (await q('INSERT INTO conversations(account_id,user_id,contact_id) VALUES($1,$2,$3) RETURNING id', [account, user, contact])).rows[0].id;
  return { contact, ig, wa };
}
const flow = async (account: string, user: string, scope: string) => (await q(
  "INSERT INTO flows(account_id,user_id,name,trigger_type,status,channel_scope) VALUES($1,$2,'Consent flow','manual','active',$3) RETURNING id",
  [account, user, scope])).rows[0].id as string;
const run = async (account: string, flowId: string, user: string, t: Thread, conversation: string) => (await q(
  "INSERT INTO flow_runs(account_id,flow_id,user_id,contact_id,conversation_id,status,current_node_key) VALUES($1,$2,$3,$4,$5,'active','n1') RETURNING id",
  [account, flowId, user, t.contact, conversation])).rows[0].id as string;
async function parked(account: string, user: string, contact: string, channel: string): Promise<{ pending: string; log: string }> {
  const automation = (await q(`INSERT INTO automations(account_id,user_id,name,trigger_type,trigger_config,is_active,channel)
    VALUES($1,$2,'Wait','new_message_received','{}',true,$3) RETURNING id`, [account, user, channel])).rows[0].id;
  const log = (await q(`INSERT INTO automation_logs(account_id,automation_id,user_id,contact_id,trigger_event,status)
    VALUES($1,$2,$3,$4,'new_message_received','partial') RETURNING id`, [account, automation, user, contact])).rows[0].id;
  const pending = (await q(`INSERT INTO automation_pending_executions(account_id,automation_id,user_id,contact_id,next_step_position,status,run_at,log_id)
    VALUES($1,$2,$3,$4,1,'pending',now() + interval '1 hour',$5) RETURNING id`, [account, automation, user, contact, log])).rows[0].id;
  return { pending, log };
}
const contactRow = async (id: string) => (await q('SELECT instagram_opted_out_at, instagram_opted_in_at, opted_out_at FROM contacts WHERE id=$1', [id])).rows[0];
const runRow = async (id: string) => (await q('SELECT status, end_reason FROM flow_runs WHERE id=$1', [id])).rows[0];
const tenant = (userId: string, role: 'owner' | 'admin' | 'agent', accountId = A) => ({ accountId, userId, role });

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Instagram consent per channel (Stage 5)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await q('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    for (const id of [ownerA, adminA, agentA, ownerB])
      await q("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Consent','test-only-hash')", [id, `${id}@example.invalid`]);
    await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Consent A',$2),($3,'Consent B',$4)", [A, ownerA, B, ownerB]);
    await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'agent'),($5,$6,'owner')",
      [A, ownerA, adminA, agentA, B, ownerB]);
    a = await thread(A, ownerA, `71${seed}1`);
    b = await thread(B, ownerB, `72${seed}2`);
    igFlowA = await flow(A, ownerA, 'instagram');
    waFlowA = await flow(A, ownerA, 'whatsapp');
    igFlowB = await flow(B, ownerB, 'instagram');
  });
  afterAll(async () => {
    if (db) {
      await q('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[A, B]]).catch(() => undefined);
      await q('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[ownerA, adminA, agentA, ownerB]]).catch(() => undefined);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('unsubscribes on Instagram only, ending Instagram runs and waits but not WhatsApp ones', async () => {
    const igRun = await run(A, igFlowA, ownerA, a, a.ig);
    const waRun = await run(A, waFlowA, ownerA, a, a.wa);
    const igWait = await parked(A, ownerA, a.contact, 'instagram');
    const waWait = await parked(A, ownerA, a.contact, 'whatsapp');
    const otherRun = await run(B, igFlowB, ownerB, b, b.ig);
    expect(await instagramAutomationAllowed(A, a.contact)).toBe(true);

    expect(await applyInstagramConsent(A, a.contact, 'opted_out')).toBe(true);
    const row = await contactRow(a.contact);
    expect(row.instagram_opted_out_at).not.toBeNull();
    expect(row.opted_out_at).toBeNull();
    expect(await runRow(igRun)).toEqual({ status: 'cancelled', end_reason: 'contact_opted_out' });
    expect(await runRow(waRun)).toEqual({ status: 'active', end_reason: null });
    expect((await q('SELECT status FROM automation_pending_executions WHERE id=$1', [igWait.pending])).rows[0].status).toBe('expired');
    expect((await q('SELECT error_message FROM automation_logs WHERE id=$1', [igWait.log])).rows[0].error_message).toBe(INSTAGRAM_OPT_OUT_WHILE_WAITING);
    expect((await q('SELECT status FROM automation_pending_executions WHERE id=$1', [waWait.pending])).rows[0].status).toBe('pending');
    expect(await runRow(otherRun)).toEqual({ status: 'active', end_reason: null });
    expect(await instagramAutomationAllowed(A, a.contact)).toBe(false);
    // A repeated STOP (a redelivered webhook) changes nothing, and keeps the first time.
    const first = row.instagram_opted_out_at;
    expect(await applyInstagramConsent(A, a.contact, 'opted_out')).toBe(false);
    expect((await contactRow(a.contact)).instagram_opted_out_at).toEqual(first);
  });

  it('resubscribes on START, once', async () => {
    expect(await applyInstagramConsent(A, a.contact, 'opted_in')).toBe(true);
    const row = await contactRow(a.contact);
    expect(row.instagram_opted_out_at).toBeNull();
    expect(row.instagram_opted_in_at).not.toBeNull();
    expect(await instagramAutomationAllowed(A, a.contact)).toBe(true);
    expect(await applyInstagramConsent(A, a.contact, 'opted_in')).toBe(false);
  });

  it("never acts on another workspace's contact", async () => {
    expect(await instagramAutomationAllowed(A, b.contact)).toBe(false);
    expect(await applyInstagramConsent(A, b.contact, 'opted_out')).toBe(false);
    expect((await contactRow(b.contact)).instagram_opted_out_at).toBeNull();
  });

  it('saves the settings as an admin, refuses an agent, and keeps workspaces apart', async () => {
    const settings = { opt_out_keywords: ['basta'], opt_in_keywords: ['volver'], opt_out_reply: 'Done.', opt_in_reply: null,
      opt_out_flow_id: igFlowA, opt_in_flow_id: null };
    expect(await saveConsentSettings(tenant(adminA, 'admin'), settings)).toEqual(settings);
    await expect(saveConsentSettings(tenant(agentA, 'agent'), { ...settings, opt_out_keywords: ['other'] })).rejects.toThrow();
    expect(await loadConsentSettings(tenant(agentA, 'agent'))).toEqual(settings);
    expect(await workerConsentSettings(A)).toEqual(settings);
    expect((await workerConsentSettings(B)).opt_out_keywords).toEqual([]);
    expect((await loadConsentSettings(tenant(ownerB, 'owner', B))).opt_out_flow_id).toBeNull();
  });

  it("refuses another workspace's flow and a WhatsApp-only flow as invalid_flow, saving nothing", async () => {
    for (const flowId of [igFlowB, waFlowA]) {
      const error = await saveConsentSettings(tenant(adminA, 'admin'), {
        opt_out_keywords: [], opt_in_keywords: [], opt_out_reply: null, opt_in_reply: null, opt_out_flow_id: null, opt_in_flow_id: flowId,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConsentSettingsError);
      expect((error as ConsentSettingsError).code).toBe('invalid_flow');
    }
    expect((await workerConsentSettings(A)).opt_out_keywords).toEqual(['basta']);
  });
});
