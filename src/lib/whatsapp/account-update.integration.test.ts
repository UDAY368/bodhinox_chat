// account_update on PostgreSQL: a removal disconnects every number of that WABA in
// the workspace (token cleared, audited) and Settings shows why; a warning keeps
// the number connected; a stale or replayed removal cannot disconnect a number
// reconnected since; another workspace's numbers are never touched.
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { encrypt } from '@/lib/whatsapp/encryption';
import { applyAccountUpdate, parseAccountUpdate } from './account-update';
import { listNumbers } from './numbers';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const ownerA = randomUUID(), ownerB = randomUUID();
const seed = String(Date.now()).slice(-9);
const wabaA = `61${seed}`, wabaOther = `62${seed}`, wabaB = `63${seed}`;
let owner: pg.Client;

async function addNumber(accountId: string, userId: string, phoneNumberId: string, wabaId: string, connectedAt: string): Promise<string> {
  return (await owner.query(
    `INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,waba_id,access_token,verify_token,status,connected_at)
     VALUES($1,$2,$3,$4,$5,$6,'connected',$7) RETURNING id`,
    [accountId, userId, phoneNumberId, wabaId, encrypt('test-only-token'), encrypt('test-only-verify'), connectedAt],
  )).rows[0].id;
}
const numberRow = async (id: string) =>
  (await owner.query('SELECT status, access_token, meta_account_event, meta_account_detail FROM whatsapp_config WHERE id=$1', [id])).rows[0];
const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('account_update webhook on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Account update test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[ownerA, ownerB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Account update A',$2),($3,'Account update B',$4)", [accountA, ownerA, accountB, ownerB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($3,$4,'owner')", [accountA, ownerA, accountB, ownerB]);
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[ownerA, ownerB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('warns without disconnecting, then a removal disconnects every number of that WABA only', async () => {
    const a1 = await addNumber(accountA, ownerA, `71${seed}`, wabaA, '2026-10-01T00:00:00Z');
    const a2 = await addNumber(accountA, ownerA, `72${seed}`, wabaA, '2026-10-01T00:00:00Z');
    const aOther = await addNumber(accountA, ownerA, `73${seed}`, wabaOther, '2026-10-01T00:00:00Z');
    const b1 = await addNumber(accountB, ownerB, `74${seed}`, wabaB, '2026-10-01T00:00:00Z');

    const warn = parseAccountUpdate(wabaA, at('2026-11-01T00:00:00Z'), { event: 'ACCOUNT_VIOLATION', violation_info: { violation_type: 'SCAM' } }, [])!;
    expect(await applyAccountUpdate(accountA, warn, getWorkerPrisma())).toEqual({ matched: 2, disconnected: 0 });
    expect(await numberRow(a1)).toMatchObject({ status: 'connected', meta_account_event: 'ACCOUNT_VIOLATION', meta_account_detail: 'SCAM' });

    // Settings (app role, the workspace's own tenant transaction) shows the problem.
    const listed = await withTenant({ accountId: accountA, userId: ownerA, role: 'owner' }, (tx) => listNumbers(tx, accountA), getPrisma());
    expect(listed.find((n) => n.id === a1)?.account_issue).toMatchObject({ event: 'ACCOUNT_VIOLATION', detail: 'SCAM' });
    expect(listed.find((n) => n.id === aOther)?.account_issue ?? null).toBeNull();

    // Applying another workspace's id to this WABA matches nothing there.
    expect(await applyAccountUpdate(accountB, warn, getWorkerPrisma())).toEqual({ matched: 0, disconnected: 0 });

    const removal = parseAccountUpdate('1', at('2026-11-02T00:00:00Z'), { event: 'PARTNER_REMOVED', waba_info: { waba_id: wabaA } }, [])!;
    expect(await applyAccountUpdate(accountA, removal, getWorkerPrisma())).toEqual({ matched: 2, disconnected: 2 });
    for (const id of [a1, a2]) expect(await numberRow(id)).toMatchObject({ status: 'disconnected', access_token: '', meta_account_event: 'PARTNER_REMOVED' });
    expect(await numberRow(aOther)).toMatchObject({ status: 'connected', meta_account_event: null });
    expect(await numberRow(b1)).toMatchObject({ status: 'connected', meta_account_event: null });

    const audit = await owner.query("SELECT metadata FROM audit_logs WHERE account_id=$1 AND action='whatsapp_account.meta_update' ORDER BY created_at", [accountA]);
    expect(audit.rows.map((r) => r.metadata.event)).toEqual(['ACCOUNT_VIOLATION', 'PARTNER_REMOVED']);

    // A replay changes nothing and an older event never overwrites the newer one.
    expect(await applyAccountUpdate(accountA, removal, getWorkerPrisma())).toEqual({ matched: 2, disconnected: 0 });
    await applyAccountUpdate(accountA, warn, getWorkerPrisma());
    expect(await numberRow(a1)).toMatchObject({ meta_account_event: 'PARTNER_REMOVED' });
  });

  it('does not disconnect a number reconnected after the event', async () => {
    const waba = `64${seed}`;
    const id = await addNumber(accountA, ownerA, `75${seed}`, waba, '2026-11-05T00:00:00Z');
    const stale = parseAccountUpdate(waba, at('2026-11-01T00:00:00Z'), { event: 'ACCOUNT_DELETED' }, [])!;
    expect(await applyAccountUpdate(accountA, stale, getWorkerPrisma())).toEqual({ matched: 1, disconnected: 0 });
    expect(await numberRow(id)).toMatchObject({ status: 'connected' });
    const listed = await withTenant({ accountId: accountA, userId: ownerA, role: 'owner' }, (tx) => listNumbers(tx, accountA), getPrisma());
    expect(listed.find((n) => n.id === id)?.account_issue ?? null).toBeNull();
  });
});
