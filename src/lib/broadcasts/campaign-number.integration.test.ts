import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getWorkerPrisma } from '@/lib/db/prisma';
import { encrypt } from '@/lib/whatsapp/encryption';
import { createCampaign } from './create-campaign';

// A campaign stores the number it sends from (broadcasts.whatsapp_config_id):
// the default when none is named, only this workspace's numbers, and only a
// template from that number's WABA.
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountId = randomUUID(), otherAccountId = randomUUID(), userId = randomUUID();
const templateA = randomUUID(), templateB = randomUUID(), contactId = randomUUID();
const scope = { accountId, userId, role: 'agent' as const };
const digits = () => String(Date.now()).slice(-8) + String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
let owner: pg.Client;
let numberA = '', numberB = '', foreignNumber = '';

const payload = (templateId: string, whatsappConfigId?: string) => ({
  name: `Campaign ${randomUUID()}`, templateId, audience: { type: 'all' as const }, variables: {},
  ...(whatsappConfigId ? { whatsappConfigId } : {}),
});

describe.skipIf(!ownerUrl || !workerUrl)('campaign sending number', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl }); await owner.connect();
    if ((await owner.query('SELECT current_database() AS name')).rows[0].name !== 'bodhinox_test') throw new Error('Campaign tests require isolated bodhinox_test');
    const worker = await getWorkerPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (worker[0].role !== 'bodhinox_worker') throw new Error('Campaign tests require constrained test worker');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Number agent','test-only-hash')", [userId, `${userId}@example.invalid`]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Two numbers',$2),($3,'Other numbers',$2)", [accountId, userId, otherAccountId]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'agent'),($3,$2,'owner')", [accountId, userId, otherAccountId]);
    const insertNumber = async (account: string, waba: string) => (await owner.query(
      `INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,waba_id,access_token,status)
       VALUES($1,$2,$3,$4,$5,'connected') RETURNING id`, [account, userId, digits(), waba, encrypt('test-only-token')])).rows[0].id as string;
    numberA = await insertNumber(accountId, 'waba-a');      // first number: the default
    numberB = await insertNumber(accountId, 'waba-b');
    foreignNumber = await insertNumber(otherAccountId, 'waba-c');
    await owner.query(`INSERT INTO message_templates(id,account_id,user_id,name,body_text,status,waba_id)
      VALUES($1,$3,$4,'number_a_template','Hi','APPROVED','waba-a'),($2,$3,$4,'number_b_template','Hello','APPROVED','waba-b')`,
    [templateA, templateB, accountId, userId]);
    await owner.query("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'Asha','14155550123')", [contactId, accountId, userId]);
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountId, otherAccountId]]);
      await owner.query('DELETE FROM auth_users WHERE id=$1', [userId]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  const storedNumber = async (id: string) =>
    (await owner.query('SELECT whatsapp_config_id FROM broadcasts WHERE id=$1', [id])).rows[0].whatsapp_config_id;

  it('stores the default number when none is named', async () => {
    const { id } = await createCampaign(scope, payload(templateA));
    expect(await storedNumber(id)).toBe(numberA);
  });

  it('stores the named number of this workspace', async () => {
    const { id } = await createCampaign(scope, payload(templateB, numberB));
    expect(await storedNumber(id)).toBe(numberB);
  });

  it("refuses another workspace's number and a template from another WABA, persisting nothing", async () => {
    const before = (await owner.query('SELECT count(*)::int AS n FROM broadcasts WHERE account_id=$1', [accountId])).rows[0].n;
    await expect(createCampaign(scope, payload(templateA, foreignNumber))).rejects.toMatchObject({ status: 400, code: 'whatsapp_number_unavailable' });
    await expect(createCampaign(scope, payload(templateA, numberB))).rejects.toMatchObject({ status: 422, code: 'template_wrong_number' });
    expect((await owner.query('SELECT count(*)::int AS n FROM broadcasts WHERE account_id=$1', [accountId])).rows[0].n).toBe(before);
  });
});
