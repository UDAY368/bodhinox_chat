import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import type { TenantContext } from '@/lib/db/tenant';
import { AudienceFilterError, AudienceNotFoundError } from '@/lib/audience/filter';
import { BulkCountChangedError, bulkContactAction } from './bulk';
import { importContactBatch } from './import';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;

const accountA = randomUUID(), accountB = randomUUID();
const admin = randomUUID(), agent = randomUUID(), viewer = randomUUID(), outsider = randomUUID();
const vip = randomUUID(), lead = randomUUID(), foreignTag = randomUUID(), list = randomUUID(), foreignList = randomUUID();
const a: TenantContext = { accountId: accountA, userId: agent, role: 'agent' };
const viewerA: TenantContext = { accountId: accountA, userId: viewer, role: 'viewer' };
const b: TenantContext = { accountId: accountB, userId: outsider, role: 'owner' };
let owner: pg.Client;

const count = async (sql: string, values: unknown[]) => (await owner.query(sql, values)).rows[0].n as number;

describe.skipIf(!ownerUrl || !appUrl)('contact import batches and bulk actions on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string; role: string }[]>`SELECT current_database() AS name, current_user AS role`;
    if (!/test/i.test(app[0].name) || app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Import test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[admin, agent, viewer, outsider]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Import A',$2),($3,'Import B',$4)", [accountA, admin, accountB, outsider]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'agent'),($1,$4,'viewer'),($5,$6,'owner')", [accountA, admin, agent, viewer, accountB, outsider]);
    await owner.query("INSERT INTO tags(id,account_id,user_id,name) VALUES($1,$4,$5,'VIP'),($2,$4,$5,'Lead'),($3,$6,$7,'Foreign')", [vip, lead, foreignTag, accountA, admin, accountB, outsider]);
    await owner.query("INSERT INTO contact_lists(id,account_id,user_id,name) VALUES($1,$3,$4,'Bulk'),($2,$5,$6,'Foreign')", [list, foreignList, accountA, agent, accountB, outsider]);
    // More than the 1,000 rows a default browser select returns (finding 5).
    await owner.query(`INSERT INTO contacts(account_id,user_id,name,phone)
      SELECT $1, $2, 'Seed ' || g, '+9170000' || lpad(g::text, 5, '0') FROM generate_series(1, 1100) g`, [accountA, agent]);
    await owner.query("INSERT INTO contacts(account_id,user_id,name,phone,company) VALUES($1,$2,'Asha','+14155550201','Old Co'),($3,$4,'Foreign','+14155550299',NULL)", [accountA, agent, accountB, outsider]);
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[admin, agent, viewer, outsider]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('inserts new numbers, skips existing ones past the first 1,000 contacts, and keeps apostrophes', async () => {
    const rows = [
      ...Array.from({ length: 150 }, (_, i) => ({ phone: `9170000${String(i + 900).padStart(5, '0')}` })),
      { phone: '919876500001', name: "Siobhan O'Brien", company: "Kelly's", tagIds: [vip, foreignTag] },
      { phone: '919876500001', name: 'Repeated in the batch' },
      { phone: '919876500002', name: 'New two' },
    ];
    expect(await importContactBatch(a, { rows })).toEqual({ imported: 2, updated: 0, skipped: 151, tagsAssigned: 1, fieldsSet: 0, fieldsRejected: 0 });
    const created = await owner.query("SELECT id, phone, name, company FROM contacts WHERE account_id=$1 AND phone_normalized='919876500001'", [accountA]);
    expect(created.rows[0]).toMatchObject({ phone: '+919876500001', name: "Siobhan O'Brien", company: "Kelly's" });
    // The other workspace's tag is never linked.
    expect(await count('SELECT count(*)::int AS n FROM contact_tags WHERE contact_id=$1', [created.rows[0].id])).toBe(1);
    expect(await count('SELECT count(*)::int AS n FROM contacts WHERE account_id=$1', [accountA])).toBe(1103);
  });

  it('updates existing contacts and tags them only when asked; blanks keep stored values', async () => {
    const asha = { phone: '14155550201', name: 'Asha Rao', tagIds: [lead] };
    expect(await importContactBatch(a, { rows: [asha] })).toEqual({ imported: 0, updated: 0, skipped: 1, tagsAssigned: 0, fieldsSet: 0, fieldsRejected: 0 });
    expect(await importContactBatch(a, { rows: [asha], updateExisting: true })).toEqual({ imported: 0, updated: 1, skipped: 0, tagsAssigned: 1, fieldsSet: 0, fieldsRejected: 0 });
    const row = (await owner.query("SELECT id, name, company FROM contacts WHERE account_id=$1 AND phone_normalized='14155550201'", [accountA])).rows[0];
    expect(row).toMatchObject({ name: 'Asha Rao', company: 'Old Co' });
    // Same values again: nothing changes, the tag link already exists.
    expect(await importContactBatch(a, { rows: [asha], updateExisting: true })).toEqual({ imported: 0, updated: 0, skipped: 1, tagsAssigned: 0, fieldsSet: 0, fieldsRejected: 0 });
  });

  it('carries an opt-out or block from the file and never clears one', async () => {
    const at = '2026-10-01T08:00:00.000Z';
    // A new contact keeps the file's opt-out (source 'import') and block.
    expect(await importContactBatch(a, { rows: [{ phone: '919876500020', optedOutAt: at, blockedAt: at }] })).toMatchObject({ imported: 1 });
    const fresh = (await owner.query("SELECT opted_out_at, opt_out_source, blocked_at FROM contacts WHERE account_id=$1 AND phone_normalized='919876500020'", [accountA])).rows[0];
    expect(fresh).toMatchObject({ opt_out_source: 'import' });
    expect(fresh.opted_out_at.toISOString()).toBe(at);
    expect(fresh.blocked_at.toISOString()).toBe(at);

    // An existing subscribed contact is opted out only when updating was chosen.
    await owner.query("INSERT INTO contacts(account_id,user_id,name,phone) VALUES($1,$2,'Subscribed','+919876500021')", [accountA, agent]);
    const row = { phone: '919876500021', optedOutAt: at };
    expect(await importContactBatch(a, { rows: [row] })).toMatchObject({ updated: 0, skipped: 1 });
    expect(await importContactBatch(a, { rows: [row], updateExisting: true })).toMatchObject({ updated: 1 });
    const opted = (await owner.query("SELECT opted_out_at, opt_out_source FROM contacts WHERE account_id=$1 AND phone_normalized='919876500021'", [accountA])).rows[0];
    expect(opted.opt_out_source).toBe('import');
    expect(opted.opted_out_at.toISOString()).toBe(at);

    // An agent's earlier opt-out keeps its date and source; a row without one clears nothing.
    await owner.query("UPDATE contacts SET opted_out_at='2026-09-01T00:00:00Z', opt_out_source='agent' WHERE account_id=$1 AND phone_normalized='919876500020'", [accountA]);
    expect(await importContactBatch(a, { rows: [{ phone: '919876500020', optedOutAt: at }, { phone: '919876500021', name: 'Renamed' }], updateExisting: true }))
      .toMatchObject({ updated: 1, skipped: 1 });
    const kept = (await owner.query("SELECT phone_normalized, opted_out_at, opt_out_source FROM contacts WHERE account_id=$1 AND phone_normalized IN ('919876500020','919876500021') ORDER BY 1", [accountA])).rows;
    expect(kept.map((r) => [r.phone_normalized, r.opt_out_source, r.opted_out_at.toISOString()])).toEqual([
      ['919876500020', 'agent', '2026-09-01T00:00:00.000Z'],
      ['919876500021', 'import', at],
    ]);
  });

  it('keeps workspaces apart and refuses viewers and malformed rows', async () => {
    // The same number in another workspace is that workspace's own contact; A's row is untouched.
    expect(await importContactBatch(b, { rows: [{ phone: '14155550201', name: 'B copy' }] })).toMatchObject({ imported: 1 });
    expect((await owner.query("SELECT name FROM contacts WHERE account_id=$1 AND phone_normalized='14155550201'", [accountA])).rows[0].name).toBe('Asha Rao');
    await expect(importContactBatch(viewerA, { rows: [{ phone: '919876500009' }] })).rejects.toThrow();
    await expect(importContactBatch(a, { rows: [{ phone: '9876543210x' }] })).rejects.toBeInstanceOf(AudienceFilterError);
    await expect(importContactBatch(a, { rows: [{ phone: '919876500010', account_id: accountB }] })).rejects.toBeInstanceOf(AudienceFilterError);
    expect(await count("SELECT count(*)::int AS n FROM contacts WHERE phone_normalized IN ('919876500009','919876500010')", [])).toBe(0);
  });

  it('acts on every contact matching a view, only when the count is still the one shown', async () => {
    const view = { tagIds: [vip] };
    await owner.query(`INSERT INTO contact_tags(account_id,contact_id,tag_id)
      SELECT account_id, id, $2 FROM contacts WHERE account_id=$1 AND name LIKE 'Seed 10%'`, [accountA, vip]);
    const tagged = await count('SELECT count(*)::int AS n FROM contact_tags WHERE tag_id=$1', [vip]);
    expect(tagged).toBe(112); // O'Brien, Seed 10, Seed 100-109 and Seed 1000-1099

    await expect(bulkContactAction(a, { scope: view, action: { type: 'add_to_list', listId: list }, expected: tagged - 1 }))
      .rejects.toBeInstanceOf(BulkCountChangedError);
    expect(await count('SELECT count(*)::int AS n FROM contact_list_members WHERE list_id=$1', [list])).toBe(0);

    expect(await bulkContactAction(a, { scope: view, action: { type: 'add_to_list', listId: list }, expected: tagged }))
      .toEqual({ matched: tagged, changed: tagged });
    expect(await bulkContactAction(a, { scope: { listId: list, search: 'Seed 100' }, action: { type: 'add_tag', tagId: lead }, expected: 11 }))
      .toEqual({ matched: 11, changed: 11 });
    // Another workspace's list or tag is not found; nothing changes.
    await expect(bulkContactAction(a, { scope: view, action: { type: 'add_to_list', listId: foreignList }, expected: tagged }))
      .rejects.toBeInstanceOf(AudienceNotFoundError);
    await expect(bulkContactAction(a, { scope: view, action: { type: 'add_tag', tagId: foreignTag }, expected: tagged }))
      .rejects.toBeInstanceOf(AudienceNotFoundError);
    await expect(bulkContactAction(b, { scope: { listId: list }, action: { type: 'delete' }, expected: tagged }))
      .rejects.toBeInstanceOf(AudienceNotFoundError);
    await expect(bulkContactAction(viewerA, { scope: { listId: list }, action: { type: 'remove_from_list', listId: list }, expected: tagged }))
      .rejects.toThrow();

    expect(await bulkContactAction(a, { scope: { listId: list }, action: { type: 'remove_from_list', listId: list }, expected: tagged }))
      .toEqual({ matched: tagged, changed: tagged });
  });

  it('matches the unfiltered page search, commas and brackets included, and deletes only those', async () => {
    await owner.query("INSERT INTO contacts(account_id,user_id,name,phone) VALUES($1,$2,'Sharma, Raj','+919811100001'),($1,$2,'Sharma (Raj)','+919811100002')", [accountA, agent]);
    const before = await count('SELECT count(*)::int AS n FROM contacts WHERE account_id=$1', [accountA]);
    expect(await bulkContactAction(a, { scope: { search: 'Sharma, Raj' }, action: { type: 'delete' }, expected: 1 }))
      .toEqual({ matched: 1, changed: 1 });
    expect(await count('SELECT count(*)::int AS n FROM contacts WHERE account_id=$1', [accountA])).toBe(before - 1);
    expect(await count('SELECT count(*)::int AS n FROM contacts WHERE account_id=$1', [accountB])).toBe(2);
  });
});
