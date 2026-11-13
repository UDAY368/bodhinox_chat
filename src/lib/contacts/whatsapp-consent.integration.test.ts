// WhatsApp consent recorded by a member, on PostgreSQL:
// - Opting in clears an opt-out and stamps opted_in_at / opt_in_source 'agent';
//   opting out keeps the first opt-out time. Both write one audit row with ids
//   and the state only, and a repeat changes nothing and audits nothing.
// - Another workspace's contact is never touched (null, no audit row).
// - A viewer cannot change consent (row-level security on contacts).
// - The browser data contract refuses direct writes of the consent columns.
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases } from '@/lib/db/prisma';
import { validateWrite } from '@/lib/data/contracts';
import { setWhatsAppConsent } from './whatsapp-consent';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const A = randomUUID(), B = randomUUID();
const ownerA = randomUUID(), agentA = randomUUID(), viewerA = randomUUID(), ownerB = randomUUID();
const seed = String(Date.now()).slice(-8);
let db: pg.Client;
let contactA: string, contactB: string;
const q = (sql: string, params: unknown[] = []) => db.query(sql, params);
const row = async (id: string) =>
  (await q('SELECT opted_out_at, opt_out_source, opted_in_at, opt_in_source FROM contacts WHERE id=$1', [id])).rows[0];
const audits = async (account: string, contact: string) =>
  (await q("SELECT user_id, metadata FROM audit_logs WHERE account_id=$1 AND resource_id=$2 AND action='contact.consent_changed' ORDER BY created_at", [account, contact])).rows;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('WhatsApp consent recorded by a member', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await q('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    for (const id of [ownerA, agentA, viewerA, ownerB])
      await q("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Consent','test-only-hash')", [id, `${id}@example.invalid`]);
    await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Consent A',$2),($3,'Consent B',$4)", [A, ownerA, B, ownerB]);
    await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'agent'),($1,$4,'viewer'),($5,$6,'owner')",
      [A, ownerA, agentA, viewerA, B, ownerB]);
    contactA = (await q("INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$3,'Consent A') RETURNING id", [A, ownerA, `1418${seed}1`])).rows[0].id;
    contactB = (await q("INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$3,'Consent B') RETURNING id", [B, ownerB, `1418${seed}2`])).rows[0].id;
  });
  afterAll(async () => {
    if (db) {
      await q('DELETE FROM audit_logs WHERE account_id = ANY($1::uuid[])', [[A, B]]).catch(() => undefined);
      await q('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[A, B]]).catch(() => undefined);
      await q('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[ownerA, agentA, viewerA, ownerB]]).catch(() => undefined);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('records an opt-in, then an opt-out that wins, each audited once', async () => {
    const agent = { accountId: A, userId: agentA, role: 'agent' as const };
    const first = await setWhatsAppConsent(agent, contactA, 'opted_in');
    expect(first?.changed).toBe(true);
    expect(first?.contact.opt_in_source).toBe('agent');
    expect((await row(contactA)).opted_in_at).not.toBeNull();

    const again = await setWhatsAppConsent(agent, contactA, 'opted_in');
    expect(again?.changed).toBe(false);

    const out = await setWhatsAppConsent(agent, contactA, 'opted_out');
    expect(out?.changed).toBe(true);
    const stored = await row(contactA);
    expect(stored.opt_out_source).toBe('agent');
    expect(stored.opted_in_at).not.toBeNull(); // the last opt-in stays as history

    const firstOut = stored.opted_out_at;
    expect((await setWhatsAppConsent(agent, contactA, 'opted_out'))?.changed).toBe(false);
    expect((await row(contactA)).opted_out_at).toEqual(firstOut);

    const trail = await audits(A, contactA);
    expect(trail.map((a) => a.metadata.state)).toEqual(['opted_in', 'opted_out']);
    expect(trail.every((a) => a.user_id === agentA && Object.keys(a.metadata).sort().join() === 'channel,state')).toBe(true);
  });

  it("never touches another workspace's contact", async () => {
    const before = await row(contactB);
    expect(await setWhatsAppConsent({ accountId: A, userId: ownerA, role: 'owner' }, contactB, 'opted_out')).toBeNull();
    expect(await row(contactB)).toEqual(before);
    expect(await audits(A, contactB)).toHaveLength(0);
    expect(await audits(B, contactB)).toHaveLength(0);
  });

  it('a viewer cannot change consent', async () => {
    const before = await row(contactA);
    // Row-level security either refuses the write or matches no row; either way nothing changes.
    const result = await setWhatsAppConsent({ accountId: A, userId: viewerA, role: 'viewer' }, contactA, 'opted_in').catch(() => null);
    expect(result?.changed ?? false).toBe(false);
    expect(await row(contactA)).toEqual(before);
  });

  it('clearing an opt-out never records an opt-in', async () => {
    const agent = { accountId: A, userId: agentA, role: 'agent' as const };
    await setWhatsAppConsent(agent, contactA, 'opted_out');
    const before = await row(contactA);
    const cleared = await setWhatsAppConsent(agent, contactA, 'cleared');
    expect(cleared?.changed).toBe(true);
    const after = await row(contactA);
    expect(after.opted_out_at).toBeNull();
    expect(after.opt_out_source).toBeNull();
    expect(after.opted_in_at).toEqual(before.opted_in_at);
    expect(after.opt_in_source).toEqual(before.opt_in_source);
    expect((await setWhatsAppConsent(agent, contactA, 'cleared'))?.changed).toBe(false);
    expect((await audits(A, contactA)).at(-1)?.metadata.state).toBe('cleared');
  });

  it('the browser contract refuses direct consent writes', () => {
    const tenant = { accountId: A, userId: agentA, role: 'agent' as const };
    for (const field of ['opted_out_at', 'opt_out_source', 'opted_in_at', 'opt_in_source'])
      expect(() => validateWrite('contacts', { [field]: null }, tenant, true, 'update')).toThrow(/server-managed/);
    expect(() => validateWrite('contacts', { opted_in_at: null }, tenant, false, 'update')).not.toThrow();
  });
});
