import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { disconnectDatabases, getWorkerPrisma } from '@/lib/db/prisma';
import { templateFlowTokens } from './send';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID(), userA = randomUUID(), userB = randomUUID();
const contactA = randomUUID();
const flowId = `flow-${randomUUID()}`;
let owner: pg.Client;

const sessions = (accountId: string) => owner.query('SELECT flow_token,form_id,contact_id,expires_at FROM whatsapp_form_sessions WHERE account_id=$1', [accountId])
  .then((r) => r.rows);

describe.skipIf(!ownerUrl || !workerUrl)('broadcast FLOW-button sessions on PostgreSQL (R9)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const worker = await getWorkerPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (worker[0].role !== 'bodhinox_worker') throw new Error('Requires constrained worker credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Template tokens test', 'test-only-hash' FROM unnest($1::uuid[]) x",
      [[userA, userB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Tokens A',$2),($3,'Tokens B',$4)", [accountA, userA, accountB, userB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($3,$4,'owner')", [accountA, userA, accountB, userB]);
    await owner.query("INSERT INTO contacts(id,account_id,user_id,phone,name) VALUES($1,$2,$3,'15550003333','Customer')", [contactA, accountA, userA]);
    await owner.query(`INSERT INTO whatsapp_forms(account_id,user_id,name,category,definition,meta_flow_id,status)
      VALUES($1,$2,'Signup','SIGN_UP','{"version":1,"screens":[]}'::jsonb,$3,'published')`, [accountA, userA, flowId]);
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[userA, userB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  const buttons = [{ type: 'QUICK_REPLY' }, { type: 'FLOW', flow_id: flowId }];

  it('creates one session per recipient key and returns the same token on every retry', async () => {
    const key = `broadcast:${randomUUID()}:${randomUUID()}:form-sessions`;
    const first = await templateFlowTokens({ accountId: accountA, buttons, contactId: contactA, conversationId: null, intentKey: key });
    expect(Object.keys(first ?? {})).toEqual(['1']);
    const again = await templateFlowTokens({ accountId: accountA, buttons, contactId: contactA, conversationId: null, intentKey: key });
    expect(again).toEqual(first);
    const rows = await sessions(accountA);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ flow_token: first![1], contact_id: contactA });
    // A template button may be tapped days later.
    expect(new Date(rows[0].expires_at).getTime() - Date.now()).toBeGreaterThan(700 * 3_600_000);
    const intent = await owner.query('SELECT status,result FROM outbound_intents WHERE idempotency_key=$1', [`${accountA}:${key}`]);
    expect(intent.rows[0]).toMatchObject({ status: 'accepted', result: { 1: first![1] } });

    // Another recipient gets its own session.
    const other = await templateFlowTokens({ accountId: accountA, buttons, contactId: contactA, conversationId: null,
      intentKey: `broadcast:${randomUUID()}:${randomUUID()}:form-sessions` });
    expect(other![1]).not.toBe(first![1]);
    expect(await sessions(accountA)).toHaveLength(2);
  });

  it('never finds another account\'s form, and its intent key cannot collide across accounts', async () => {
    const key = `broadcast:${randomUUID()}:${randomUUID()}:form-sessions`;
    expect(await templateFlowTokens({ accountId: accountB, buttons, contactId: null, conversationId: null, intentKey: key })).toBeUndefined();
    expect(await sessions(accountB)).toHaveLength(0);
    const tokensA = await templateFlowTokens({ accountId: accountA, buttons, contactId: contactA, conversationId: null, intentKey: key });
    expect(Object.keys(tokensA ?? {})).toEqual(['1']);
  });
});
