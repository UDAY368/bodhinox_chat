import { createHash, randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { resolveWhatsAppAccount, verifyWebhookTokenHash } from '@/lib/repositories/routing';
import { encrypt } from '@/lib/whatsapp/encryption';
import { disconnectNumber } from './number-admin';
import { getConfigForPhoneNumberId } from './numbers';
import { processWebhook } from './process-webhook';

const webhook = vi.hoisted(() => ({ dispatch: vi.fn(async () => {}) }));
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: webhook.dispatch }));

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const adminA = randomUUID(), adminB = randomUUID();
const asA: TenantContext = { accountId: accountA, userId: adminA, role: 'admin' };
const asB: TenantContext = { accountId: accountB, userId: adminB, role: 'admin' };
const seed = String(Date.now()).slice(-9);
const phone = `75${seed}`;
const sender = `1888${seed}`;
let owner: pg.Client;
let configA = '';
// A per-run verify token hash for A's number (crm_verify_webhook_token).
const verifyHashA = createHash('sha256').update(`verify-${seed}-${randomUUID()}`).digest('hex');

function inbound(text: string) {
  return {
    entry: [{
      id: 'entry',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '1555', phone_number_id: phone },
          contacts: [{ profile: { name: 'Test sender' }, wa_id: sender }],
          messages: [{ id: `wamid.${randomUUID()}`, from: sender, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
        },
      }],
    }],
  };
}

/** The connect flows' write, as the constrained app role in the tenant's scope. */
const connect = (as: TenantContext) =>
  withTenant(as, (tx) => tx.whatsapp_config.create({
    data: { account_id: as.accountId, user_id: as.userId!, phone_number_id: phone, waba_id: `85${seed}`, access_token: encrypt('test-only-token'), status: 'connected' },
    select: { id: true },
  }));

const threadOf = async (accountId: string) =>
  (await owner.query(
    `SELECT v.id, v.whatsapp_config_id, (SELECT count(*)::int FROM messages m WHERE m.conversation_id=v.id) AS messages
     FROM conversations v JOIN contacts c ON c.id=v.contact_id WHERE v.account_id=$1 AND c.phone=$2 ORDER BY v.created_at`,
    [accountId, sender],
  )).rows as { id: string; whatsapp_config_id: string | null; messages: number }[];

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('A WhatsApp number moving between workspaces', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string; role: string }[]>`SELECT current_database() AS name, current_user AS role`;
    if (!/test/i.test(app[0].name) || app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await getWorkerPrisma().$queryRaw`SELECT 1`;
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Phone unique test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[adminA, adminB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Phone A',$2),($3,'Phone B',$4)", [accountA, adminA, accountB, adminB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($3,$4,'owner')", [accountA, adminA, accountB, adminB]);
    configA = (await connect(asA)).id;
    await owner.query('UPDATE whatsapp_config SET verify_token_hash=$1 WHERE id=$2', [verifyHashA, configA]);
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[adminA, adminB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('refuses a second workspace while the number is connected', async () => {
    expect(await resolveWhatsAppAccount(phone)).toBe(accountA);
    await expect(connect(asB)).rejects.toMatchObject({ code: 'P2002' });
    // A failed Meta registration (status 'disconnected', token kept) still holds the number.
    await owner.query("UPDATE whatsapp_config SET status='disconnected' WHERE id=$1", [configA]);
    await expect(connect(asB)).rejects.toMatchObject({ code: 'P2002' });
    expect(await resolveWhatsAppAccount(phone)).toBe(accountA);
    expect(await verifyWebhookTokenHash(verifyHashA)).toBe(true);
    await owner.query("UPDATE whatsapp_config SET status='connected' WHERE id=$1", [configA]);
  });

  it('lets B connect a number A disconnected, routes inbound to B and leaves A\'s history intact', async () => {
    await processWebhook(inbound('to A'));
    const before = await threadOf(accountA);
    expect(before).toEqual([{ id: expect.any(String), whatsapp_config_id: configA, messages: 1 }]);

    expect(await verifyWebhookTokenHash(verifyHashA)).toBe(true);
    await withTenant(asA, (tx) => disconnectNumber(tx, accountA, configA, adminA));
    // Disconnected everywhere: no workspace holds it, so nothing routes and its
    // kept verify token no longer passes Meta's handshake.
    expect(await resolveWhatsAppAccount(phone)).toBeNull();
    expect((await owner.query('SELECT verify_token_hash FROM whatsapp_config WHERE id=$1', [configA])).rows[0].verify_token_hash).toBe(verifyHashA);
    expect(await verifyWebhookTokenHash(verifyHashA)).toBe(false);
    expect(await getConfigForPhoneNumberId(phone)).toBeNull();

    const configB = (await connect(asB)).id;
    expect(await resolveWhatsAppAccount(phone)).toBe(accountB);
    expect(await getConfigForPhoneNumberId(phone)).toMatchObject({ id: configB, account_id: accountB });

    await processWebhook(inbound('to B'));
    expect(await threadOf(accountB)).toEqual([{ id: expect.any(String), whatsapp_config_id: configB, messages: 1 }]);
    // A keeps its row, its conversation and its message, unchanged.
    expect(await threadOf(accountA)).toEqual(before);
    const rowA = (await owner.query('SELECT status, access_token, phone_number_id FROM whatsapp_config WHERE id=$1', [configA])).rows[0];
    expect(rowA).toEqual({ status: 'disconnected', access_token: '', phone_number_id: phone });
  });

  it('refuses A reconnecting while B holds the number', async () => {
    // The reconnect write both connect flows make: set A's token again.
    await expect(withTenant(asA, (tx) => tx.whatsapp_config.updateMany({
      where: { account_id: accountA, id: configA },
      data: { access_token: encrypt('test-only-token'), status: 'connected' },
    }))).rejects.toMatchObject({ code: 'P2002' });
    expect((await owner.query('SELECT access_token FROM whatsapp_config WHERE id=$1', [configA])).rows[0].access_token).toBe('');
    expect(await resolveWhatsAppAccount(phone)).toBe(accountB);
  });
});
