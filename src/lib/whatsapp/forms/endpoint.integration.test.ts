import { randomBytes, randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { encrypt } from '@/lib/whatsapp/encryption';
import { formsPrivateKey, formsSessionStore } from './session-store';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const admin = randomUUID(), agent = randomUUID(), outsider = randomUUID();
const asAdmin: TenantContext = { accountId: accountA, userId: admin, role: 'admin' };
const asAgent: TenantContext = { accountId: accountA, userId: agent, role: 'agent' };
const definition = { version: 1, screens: [{ id: 'ONE', title: 'One', button_label: 'Send', fields: [{ id: 'name', type: 'short_text', label: 'Name' }] }] };
const token = () => randomBytes(32).toString('base64url');
const phoneA = String(Date.now()).slice(-9) + '1';
let owner: pg.Client;
let formA = '';

const insertSession = (flowToken: string, expiresIn = '1 day') =>
  withTenant(asAgent, (tx) => tx.$queryRaw<{ id: string }[]>`
    INSERT INTO whatsapp_form_sessions(flow_token,form_id,expires_at)
    VALUES(${flowToken},${formA}::uuid,now() + ${expiresIn}::interval) RETURNING id::text`).then((rows) => rows[0].id);
/** The statement the encryption-key route runs after Meta accepts the key. */
const storeKey = (ctx: TenantContext, privateKeyPem: string) =>
  withTenant(ctx, (tx) => tx.$executeRaw`
    UPDATE whatsapp_config SET forms_public_key = 'test-only-public', forms_private_key_enc = ${encrypt(privateKeyPem)}, forms_key_uploaded_at = now()
    WHERE account_id = ${ctx.accountId}::uuid AND phone_number_id = ${phoneA}`);

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('WhatsApp forms endpoint storage on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string; role: string }[]>`SELECT current_database() AS name, current_user AS role`;
    if (!/test/i.test(app[0].name) || app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Forms endpoint test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[admin, agent, outsider]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Endpoint A',$2),($3,'Endpoint B',$4)", [accountA, admin, accountB, outsider]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'agent'),($4,$5,'owner')", [accountA, admin, agent, accountB, outsider]);
    await owner.query("INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,access_token) VALUES($1,$2,$3,'test-only-encrypted-token')", [accountA, admin, phoneA]);
    formA = (await withTenant(asAdmin, (tx) => tx.$queryRaw<{ id: string }[]>`
      INSERT INTO whatsapp_forms(user_id,name,category,definition,uses_endpoint)
      VALUES(${admin}::uuid,'Endpoint form','LEAD_GENERATION',${JSON.stringify(definition)}::jsonb,true) RETURNING id::text`))[0].id;
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[admin, agent, outsider]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('stores the forms key for admins only and returns it to the worker of that account alone', async () => {
    expect(await formsPrivateKey(accountA)).toBeNull();
    expect(await storeKey(asAgent, 'test-only-agent-key')).toBe(0);
    expect(await storeKey(asAdmin, 'test-only-private-key')).toBe(1);
    expect(await formsPrivateKey(accountA)).toBe('test-only-private-key');
    expect(await formsPrivateKey(accountB)).toBeNull();
  });

  it('keeps answers per session, completes once and isolates tokens by account', async () => {
    const flowToken = token();
    const sessionId = await insertSession(flowToken);
    const store = formsSessionStore(accountA);
    expect(await store.find(flowToken)).toEqual({ id: sessionId, answers: {}, expired: false, completed: false, definition });
    expect(await formsSessionStore(accountB).find(flowToken)).toBeNull();

    await store.saveAnswers(sessionId, { name: 'Ana', topics: ['a'] });
    await store.saveAnswers(sessionId, { name: 'Ana Lima' });
    expect((await store.find(flowToken))?.answers).toEqual({ name: 'Ana Lima', topics: ['a'] });
    // Another account's worker scope cannot write to this session.
    await formsSessionStore(accountB).saveAnswers(sessionId, { name: 'Mallory' });

    expect(await store.complete(sessionId, { agree: true })).toEqual({ name: 'Ana Lima', topics: ['a'], agree: true });
    expect(await store.complete(sessionId, { agree: false })).toBeNull();
    expect(await store.find(flowToken)).toMatchObject({ completed: true });
  });

  it('reports expiry and will not complete an expired session', async () => {
    const flowToken = token();
    const sessionId = await insertSession(flowToken, '-1 minute');
    const store = formsSessionStore(accountA);
    expect(await store.find(flowToken)).toMatchObject({ expired: true });
    expect(await store.complete(sessionId, { name: 'Late' })).toBeNull();
  });

  it('only accepts an object for the answers column', async () => {
    const sessionId = await insertSession(token());
    await expect(withTenant({ accountId: accountA, role: 'owner' }, (tx) =>
      tx.$executeRaw`UPDATE whatsapp_form_sessions SET answers = '[]'::jsonb WHERE id = ${sessionId}::uuid`, getWorkerPrisma())).rejects.toThrow();
  });
});
