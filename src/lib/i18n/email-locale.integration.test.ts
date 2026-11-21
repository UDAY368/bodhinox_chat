// Staff email language on PostgreSQL: a member's own language, else the
// workspace default, else the deployment default (English), read as the app
// and worker roles inside one workspace; another workspace's members and
// preferences are never seen. Also the account-email lookup for a known user.
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { disconnectDatabases, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { userEmailLocale } from '@/lib/auth/user-email-locale';
import { billingEmailRecipients } from '@/lib/billing/billing-notify';
import { memberEmailLocales, workspaceEmailLocale } from './email-locale';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
const authUrl = process.env.TEST_AUTH_DATABASE_URL || configured?.AUTH_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
if (authUrl) process.env.AUTH_DATABASE_URL = authUrl;

const accountA = randomUUID(), accountB = randomUUID();
const chose = randomUUID(), plain = randomUUID(), other = randomUUID(), admin = randomUUID();
let owner: pg.Client;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('staff email language on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    delete process.env.NEXT_PUBLIC_APP_LOCALE;
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Locale test', 'test-only-hash' FROM unnest($1::uuid[]) x",
      [[chose, plain, other, admin]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id,default_language) VALUES($1,'Locale A',$2,'pt'),($3,'Locale B',$4,NULL)",
      [accountA, chose, accountB, other]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'agent'),($4,$5,'owner'),($1,$6,'admin')",
      [accountA, chose, plain, accountB, other, admin]);
    await owner.query(`INSERT INTO profiles(user_id,full_name,email,account_id,account_role) VALUES
      ($1,'Chose','chose@example.invalid',$5,'owner'),($2,'Plain','plain@example.invalid',$5,'agent'),
      ($3,'Admin','admin@example.invalid',$5,'admin'),($4,'Other','other@example.invalid',$6,'owner')`,
      [chose, plain, admin, other, accountA, accountB]);
    await owner.query("INSERT INTO member_preferences(account_id,user_id,language) VALUES($1,$2,'ko'),($3,$4,'es')",
      [accountA, chose, accountB, other]);
  });

  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM profiles WHERE user_id=ANY($1::uuid[])', [[chose, plain, other, admin]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[chose, plain, other, admin]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('picks the member’s language, else the workspace default (worker role)', async () => {
    const locales = await withTenant({ accountId: accountA }, (tx) => memberEmailLocales(tx, accountA, [chose, plain, other]),
      getWorkerPrisma());
    expect(locales.get(chose)).toBe('ko');
    expect(locales.get(plain)).toBe('pt');
    // A member of another workspace is not read from this one.
    expect(locales.has(other)).toBe(false);
  });

  it('falls back to English when neither the member nor the workspace chose (app role)', async () => {
    const locales = await withTenant({ accountId: accountB }, (tx) => memberEmailLocales(tx, accountB, [other]));
    expect(locales.get(other)).toBe('es');
    await owner.query('DELETE FROM member_preferences WHERE account_id=$1', [accountB]);
    const after = await withTenant({ accountId: accountB }, (tx) => memberEmailLocales(tx, accountB, [other]));
    expect(after.get(other)).toBe('en');
    expect(await withTenant({ accountId: accountB }, (tx) => workspaceEmailLocale(tx, accountB))).toBe('en');
    expect(await withTenant({ accountId: accountA }, (tx) => workspaceEmailLocale(tx, accountA))).toBe('pt');
  });

  it('cannot read another workspace’s rows by naming it while scoped to this one', async () => {
    const locales = await withTenant({ accountId: accountA }, (tx) => memberEmailLocales(tx, accountB, [other]));
    expect(locales.size).toBe(0);
  });

  it.skipIf(!authUrl)('finds a known user’s language for account emails (home workspace)', async () => {
    expect(await userEmailLocale(chose)).toBe('ko');
    expect(await userEmailLocale(plain, accountA)).toBe('pt');
    expect(await userEmailLocale(randomUUID())).toBeUndefined();
  });

  it('groups billing emails by each owner/admin’s language, and uses the workspace language for the billing address', async () => {
    const byAdmins = await billingEmailRecipients(accountA);
    expect(byAdmins.workspace).toBe('pt');
    // The agent is not emailed; another workspace's owner is never read.
    expect(byAdmins.groups).toEqual([
      { locale: 'pt', to: ['admin@example.invalid'] },
      { locale: 'ko', to: ['chose@example.invalid'] },
    ]);
    await owner.query(`INSERT INTO billing_profiles(account_id,legal_name,address_line1,city,state_code,postal_code,email)
      VALUES($1,'Locale A','1 MG Road','Pune','27','411001','billing@example.invalid')`, [accountA]);
    expect((await billingEmailRecipients(accountA)).groups).toEqual([{ locale: 'pt', to: ['billing@example.invalid'] }]);
  });
});
