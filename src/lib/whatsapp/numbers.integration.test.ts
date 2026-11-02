import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { encrypt } from '@/lib/whatsapp/encryption';
import {
  NoNumberError,
  getConfigForPhoneNumberId,
  getNumberConfig,
  listNumbers,
  setDefaultNumber,
} from './numbers';
import { processWebhook } from './process-webhook';

const webhook = vi.hoisted(() => ({ dispatch: vi.fn(async () => {}) }));
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: webhook.dispatch }));

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID(), accountC = randomUUID();
const adminA = randomUUID(), agentA = randomUUID(), ownerB = randomUUID(), ownerC = randomUUID();
const asAdminA: TenantContext = { accountId: accountA, userId: adminA, role: 'admin' };
const asAgentA: TenantContext = { accountId: accountA, userId: agentA, role: 'agent' };
const asB: TenantContext = { accountId: accountB, userId: ownerB, role: 'owner' };
const asC: TenantContext = { accountId: accountC, userId: ownerC, role: 'owner' };
// Meta ids are numeric and globally unique; derive per-run values so reruns never collide.
const seed = String(Date.now()).slice(-9);
const phoneA1 = `71${seed}`, phoneA2 = `72${seed}`, phoneB = `73${seed}`;
const wabaA1 = `81${seed}`, wabaA2 = `82${seed}`, wabaB = `83${seed}`;
let owner: pg.Client;
let configA1 = '', configA2 = '', configB = '';

async function addNumber(accountId: string, userId: string, phoneNumberId: string, wabaId: string): Promise<{ id: string; is_default: boolean }> {
  return (await owner.query(
    `INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,waba_id,access_token,status)
     VALUES($1,$2,$3,$4,$5,'connected') RETURNING id,is_default`,
    [accountId, userId, phoneNumberId, wabaId, encrypt('test-only-token')],
  )).rows[0];
}

function inbound(phoneNumberId: string, from: string, metaId: string, text: string) {
  return {
    entry: [{
      id: 'entry',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '1555', phone_number_id: phoneNumberId },
          contacts: [{ profile: { name: 'Test sender' }, wa_id: from }],
          messages: [{ id: metaId, from, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
        },
      }],
    }],
  };
}

const conversationsOf = async (accountId: string, phone: string) =>
  (await owner.query(
    `SELECT v.id,v.whatsapp_config_id FROM conversations v JOIN contacts c ON c.id=v.contact_id
     WHERE v.account_id=$1 AND c.phone=$2 ORDER BY v.created_at`,
    [accountId, phone],
  )).rows as { id: string; whatsapp_config_id: string | null }[];

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('WhatsApp numbers on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string; role: string }[]>`SELECT current_database() AS name, current_user AS role`;
    if (!/test/i.test(app[0].name) || app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await getWorkerPrisma().$queryRaw`SELECT 1`;
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Numbers test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[adminA, agentA, ownerB, ownerC]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Numbers A',$2),($3,'Numbers B',$4),($5,'Numbers C',$6)", [accountA, adminA, accountB, ownerB, accountC, ownerC]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'agent'),($4,$5,'owner'),($6,$7,'owner')", [accountA, adminA, agentA, accountB, ownerB, accountC, ownerC]);
    const a1 = await addNumber(accountA, adminA, phoneA1, wabaA1);
    const a2 = await addNumber(accountA, adminA, phoneA2, wabaA2);
    const b = await addNumber(accountB, ownerB, phoneB, wabaB);
    [configA1, configA2, configB] = [a1.id, a2.id, b.id];
    expect([a1.is_default, a2.is_default, b.is_default]).toEqual([true, false, true]);
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB, accountC]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[adminA, agentA, ownerB, ownerC]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('lists a workspace\'s numbers default first, without tokens, and only its own', async () => {
    const numbers = await withTenant(asAgentA, (tx) => listNumbers(tx, accountA));
    expect(numbers.map((n) => n.id)).toEqual([configA1, configA2]);
    expect(numbers[0]).toMatchObject({ phone_number_id: phoneA1, waba_id: wabaA1, is_default: true });
    for (const n of numbers) expect(Object.keys(n)).not.toContain('access_token');
    // Another tenant asking for A's account id sees nothing.
    expect(await withTenant(asB, (tx) => listNumbers(tx, accountA))).toEqual([]);
  });

  it('resolves the requested number, else the default, and never another workspace\'s', async () => {
    await withTenant(asAgentA, async (tx) => {
      expect((await getNumberConfig(tx, accountA)).id).toBe(configA1);
      expect((await getNumberConfig(tx, accountA, configA2)).id).toBe(configA2);
      await expect(getNumberConfig(tx, accountA, configB)).rejects.toMatchObject({ name: 'NoNumberError', reason: 'not_found' });
      await expect(getNumberConfig(tx, accountA, 'not-a-uuid')).rejects.toBeInstanceOf(NoNumberError);
    });
    await expect(withTenant(asB, (tx) => getNumberConfig(tx, accountA, configA1))).rejects.toMatchObject({ reason: 'not_found' });
    await expect(withTenant(asC, (tx) => getNumberConfig(tx, accountC))).rejects.toMatchObject({ reason: 'none' });
  });

  it('switches the default atomically, admins only, one default per workspace', async () => {
    await withTenant(asAdminA, (tx) => setDefaultNumber(tx, accountA, configA2));
    const rows = (await owner.query('SELECT id,is_default FROM whatsapp_config WHERE account_id=$1', [accountA])).rows;
    expect(Object.fromEntries(rows.map((r) => [r.id, r.is_default]))).toEqual({ [configA1]: false, [configA2]: true });
    expect((await owner.query('SELECT is_default FROM whatsapp_config WHERE id=$1', [configB])).rows[0].is_default).toBe(true);
    await expect(owner.query('UPDATE whatsapp_config SET is_default=TRUE WHERE id=$1', [configA1])).rejects.toMatchObject({ code: '23505' });
    // An agent cannot move it; another workspace cannot even see the number.
    await expect(withTenant(asAgentA, (tx) => setDefaultNumber(tx, accountA, configA1))).rejects.toMatchObject({ reason: 'not_found' });
    await expect(withTenant(asB, (tx) => setDefaultNumber(tx, accountB, configA1))).rejects.toMatchObject({ reason: 'not_found' });
    await withTenant(asAdminA, (tx) => setDefaultNumber(tx, accountA, configA1));
    expect((await withTenant(asAgentA, (tx) => getNumberConfig(tx, accountA))).id).toBe(configA1);
  });

  it('finds a number by its Meta phone number id across workspaces', async () => {
    expect(await getConfigForPhoneNumberId(phoneA2)).toMatchObject({ id: configA2, account_id: accountA });
    expect(await getConfigForPhoneNumberId(phoneB)).toMatchObject({ id: configB, account_id: accountB });
    expect(await getConfigForPhoneNumberId(`79${seed}`)).toBeNull();
  });

  it('routes inbound messages to the number they arrived on, one conversation per number', async () => {
    const sender = `1555${seed}`;
    await processWebhook(inbound(phoneA1, sender, `wamid.a1.${randomUUID()}`, 'hello one'));
    await processWebhook(inbound(phoneA1, sender, `wamid.a1.${randomUUID()}`, 'again one'));
    await processWebhook(inbound(phoneA2, sender, `wamid.a2.${randomUUID()}`, 'hello two'));
    await processWebhook(inbound(phoneB, sender, `wamid.b.${randomUUID()}`, 'hello b'));
    const inA = await conversationsOf(accountA, sender);
    expect(inA.map((c) => c.whatsapp_config_id)).toEqual([configA1, configA2]);
    const counts = (await owner.query('SELECT conversation_id,count(*)::int AS n FROM messages WHERE conversation_id=ANY($1::uuid[]) GROUP BY 1', [inA.map((c) => c.id)])).rows;
    expect(Object.fromEntries(counts.map((r) => [r.conversation_id, r.n]))).toEqual({ [inA[0].id]: 2, [inA[1].id]: 1 });
    const jobs = (await owner.query("SELECT payload FROM jobs WHERE tenant_id=$1 AND payload->>'conversationId'=$2", [accountA, inA[1].id])).rows;
    expect(jobs[0].payload).toMatchObject({ whatsappConfigId: configA2 });
    expect((await conversationsOf(accountB, sender)).map((c) => c.whatsapp_config_id)).toEqual([configB]);
  });

  it('keeps single-number behaviour: a conversation created without a number belongs to the default', async () => {
    const contact = (await owner.query("INSERT INTO contacts(account_id,user_id,phone) VALUES($1,$2,$3) RETURNING id", [accountB, ownerB, `1666${seed}`])).rows[0].id;
    const conversation = (await owner.query('INSERT INTO conversations(account_id,user_id,contact_id) VALUES($1,$2,$3) RETURNING whatsapp_config_id', [accountB, ownerB, contact])).rows[0];
    expect(conversation.whatsapp_config_id).toBe(configB);
    await expect(owner.query('INSERT INTO conversations(account_id,user_id,contact_id) VALUES($1,$2,$3)', [accountB, ownerB, contact])).rejects.toMatchObject({ code: '23505' });
    // An inbound message from that contact lands in the same conversation.
    await processWebhook(inbound(phoneB, `1666${seed}`, `wamid.b.${randomUUID()}`, 'same thread'));
    expect(await conversationsOf(accountB, `1666${seed}`)).toHaveLength(1);
  });

  it('backfills an existing single-number workspace without changing its threads', async () => {
    // A workspace whose rows predate the number: no number to stamp on insert.
    const contact = (await owner.query("INSERT INTO contacts(account_id,user_id,phone) VALUES($1,$2,$3) RETURNING id", [accountC, ownerC, `1777${seed}`])).rows[0].id;
    const conversation = (await owner.query('INSERT INTO conversations(account_id,user_id,contact_id) VALUES($1,$2,$3) RETURNING id,whatsapp_config_id', [accountC, ownerC, contact])).rows[0];
    expect(conversation.whatsapp_config_id).toBeNull();
    const broadcast = (await owner.query("INSERT INTO broadcasts(account_id,user_id,name,template_name) VALUES($1,$2,'b','t') RETURNING id", [accountC, ownerC])).rows[0].id;
    const template = (await owner.query("INSERT INTO message_templates(account_id,user_id,name,body_text) VALUES($1,$2,'tpl','Hi') RETURNING id", [accountC, ownerC])).rows[0].id;
    const number = await addNumber(accountC, ownerC, `74${seed}`, `84${seed}`);
    expect(number.is_default).toBe(true);
    // The migration's own backfill statements, limited to this workspace.
    const sql = readFileSync('prisma/migrations/20261102090000_whatsapp_multi_number/migration.sql', 'utf8');
    const backfills = [...sql.matchAll(/^UPDATE (conversations c|broadcasts b|message_templates t) SET [\s\S]*?;$/gm)].map((m) => m[0]);
    expect(backfills).toHaveLength(3);
    for (const statement of backfills) {
      const alias = /^UPDATE \w+ (\w)/.exec(statement)![1];
      await owner.query(`${statement.slice(0, -1)} AND ${alias}.account_id=$1`, [accountC]);
    }
    expect((await owner.query('SELECT whatsapp_config_id FROM conversations WHERE id=$1', [conversation.id])).rows[0].whatsapp_config_id).toBe(number.id);
    expect((await owner.query('SELECT whatsapp_config_id FROM broadcasts WHERE id=$1', [broadcast])).rows[0].whatsapp_config_id).toBe(number.id);
    expect((await owner.query('SELECT waba_id FROM message_templates WHERE id=$1', [template])).rows[0].waba_id).toBe(`84${seed}`);
    await processWebhook(inbound(`74${seed}`, `1777${seed}`, `wamid.c.${randomUUID()}`, 'still one thread'));
    expect((await conversationsOf(accountC, `1777${seed}`)).map((c) => c.id)).toEqual([conversation.id]);
  });

  it('applies template webhooks only to the WABA they came from', async () => {
    const metaId = `9${seed}`;
    const rows = (await owner.query(
      `INSERT INTO message_templates(account_id,user_id,name,language,body_text,meta_template_id,waba_id,status) VALUES
       ($1,$2,'waba_one','en_US','Hi',$3,$4,'PENDING'),($1,$2,'waba_two','en_US','Hi',$3,$5,'PENDING'),
       ($1,$2,'waba_none','en_US','Hi',$3,NULL,'PENDING') RETURNING id,name`,
      [accountA, adminA, metaId, wabaA1, wabaA2],
    )).rows as { id: string; name: string }[];
    await processWebhook({
      entry: [{ id: wabaA1, changes: [{ field: 'message_template_status_update', value: { event: 'APPROVED', message_template_id: metaId, message_template_name: 'waba_one' } }] }],
    } as never);
    const after = (await owner.query('SELECT name,status,waba_id FROM message_templates WHERE id=ANY($1::uuid[]) ORDER BY name', [rows.map((r) => r.id)])).rows;
    expect(after).toEqual([
      { name: 'waba_none', status: 'APPROVED', waba_id: wabaA1 },
      { name: 'waba_one', status: 'APPROVED', waba_id: wabaA1 },
      { name: 'waba_two', status: 'PENDING', waba_id: wabaA2 },
    ]);
  });
});
