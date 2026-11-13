// Contacts redesign on PostgreSQL (migrations 20261114002000-2200):
// - Profile saves change one field, record a timeline row with the field name
//   only, refuse a duplicate number and an owner from another workspace, and
//   never touch another workspace's contact.
// - Custom values are checked against the field type; a field's type cannot
//   change (trigger); choice edits clear values that are no longer a choice;
//   deleting a field strips it from segments and refuses to empty one.
// - The contacts table filters by owner and consent, sorts by name, and bulk
//   assign owner refuses a non-member and records one timeline row per contact.
// - contact_activity is FORCE RLS: no cross-tenant or viewer inserts.
// - The overview lists the timeline and an Instagram switch needs an identity.
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { bulkContactAction, scopeContacts } from './bulk';
import { createCustomField, deleteCustomField, listCustomFields, updateCustomField } from './custom-fields';
import { setInstagramConsentByMember } from './instagram-member-consent';
import { contactOverview, setContactCustomValue, updateContactField } from './profile';

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
let zed: string, amy: string, other: string;
const q = (sql: string, params: unknown[] = []) => db.query(sql, params);
const asOwner = { accountId: A, userId: ownerA, role: 'owner' as const };
const asAgent = { accountId: A, userId: agentA, role: 'agent' as const };
const asViewer = { accountId: A, userId: viewerA, role: 'viewer' as const };
const activity = async (contact: string) =>
  (await q('SELECT kind, actor_id::text, detail FROM contact_activity WHERE contact_id=$1 ORDER BY created_at, id', [contact])).rows;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('contacts redesign', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await q('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    for (const id of [ownerA, agentA, viewerA, ownerB])
      await q("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Redesign','test-only-hash')", [id, `${id}@example.invalid`]);
    await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Redesign A',$2),($3,'Redesign B',$4)", [A, ownerA, B, ownerB]);
    await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'agent'),($1,$4,'viewer'),($5,$6,'owner')",
      [A, ownerA, agentA, viewerA, B, ownerB]);
    zed = (await q("INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$3,'Zed') RETURNING id", [A, ownerA, `+1419${seed}1`])).rows[0].id;
    amy = (await q("INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$3,'Amy') RETURNING id", [A, ownerA, `+1419${seed}2`])).rows[0].id;
    other = (await q("INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$3,'Other') RETURNING id", [B, ownerB, `+1419${seed}3`])).rows[0].id;
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

  it('saves one profile field at a time with a timeline row naming the field only', async () => {
    expect(await updateContactField(asAgent, zed, 'city', ' Pune ')).toMatchObject({ city: 'Pune' });
    expect(await updateContactField(asAgent, zed, 'city', 'Pune')).toMatchObject({ city: 'Pune' });
    const rows = await activity(zed);
    expect(rows).toEqual([{ kind: 'field_changed', actor_id: agentA, detail: { field: 'city' } }]);
    await expect(updateContactField(asAgent, zed, 'phone', `+1419${seed}2`)).rejects.toMatchObject({ code: 'duplicate_phone' });
    await expect(updateContactField(asAgent, zed, 'owner_id', ownerB)).rejects.toMatchObject({ code: 'not_member' });
    expect(await updateContactField(asAgent, zed, 'owner_id', agentA)).toMatchObject({ owner_id: agentA });
    expect(await updateContactField(asAgent, zed, 'blocked', true)).toMatchObject({ blocked_at: expect.any(String) });
    expect(await updateContactField(asAgent, other, 'city', 'Leak')).toBeNull();
    expect((await q('SELECT city FROM contacts WHERE id=$1', [other])).rows[0].city).toBeNull();
  });

  it('checks custom values against the field type and keeps the type fixed', async () => {
    const plan = await createCustomField(asOwner, { name: `Plan ${seed}`, type: 'choice', choices: ['Starter', 'Growth'] });
    const seats = await createCustomField(asOwner, { name: `Seats ${seed}`, type: 'number' });
    await expect(setContactCustomValue(asAgent, zed, seats.id, 'many')).rejects.toMatchObject({ code: 'not_a_number' });
    expect(await setContactCustomValue(asAgent, zed, seats.id, '12')).toEqual({ value: '12' });
    expect(await setContactCustomValue(asAgent, zed, plan.id, 'growth')).toEqual({ value: 'Growth' });
    expect(await setContactCustomValue(asAgent, other, plan.id, 'Growth')).toBeNull();
    await expect(q("UPDATE custom_fields SET field_type='text' WHERE id=$1", [seats.id])).rejects.toThrow(/cannot change/);

    const listed = await listCustomFields(asViewer);
    expect(listed.find((f) => f.id === plan.id)).toMatchObject({ field_type: 'choice', choices: ['Starter', 'Growth'], filled: 1 });

    // Dropping a choice clears the values that used it.
    expect(await updateCustomField(asOwner, plan.id, { choices: ['Starter', 'Annual'] })).toMatchObject({ filled: 0 });

    const segment = (await q("INSERT INTO segments(account_id,user_id,name,filter) VALUES($1,$2,$3,$4::jsonb) RETURNING id",
      [A, ownerA, `Only seats ${seed}`, JSON.stringify({ conditions: [{ field: 'custom_field', fieldId: seats.id, op: 'is_not_empty' }] })])).rows[0].id;
    await expect(deleteCustomField(asOwner, seats.id)).rejects.toMatchObject({ code: 'segment_needs_field' });
    await q("UPDATE segments SET filter=$2::jsonb WHERE id=$1", [segment,
      JSON.stringify({ conditions: [{ field: 'name', op: 'is_not_empty' }, { field: 'custom_field', fieldId: seats.id, op: 'is_not_empty' }] })]);
    expect(await deleteCustomField(asOwner, seats.id)).toEqual({ values: 1, segments: 1 });
    expect((await q('SELECT filter FROM segments WHERE id=$1', [segment])).rows[0].filter).toEqual({ conditions: [{ field: 'name', op: 'is_not_empty' }] });
    // Agents read fields but cannot create them (RLS on custom_fields).
    await expect(createCustomField(asAgent, { name: `Agent ${seed}`, type: 'text' })).rejects.toThrow();
  });

  it('filters the table by owner and consent, sorts by name and assigns owners in bulk', async () => {
    const owned = await scopeContacts(asViewer, { ownerId: agentA }, { offset: 0, limit: 25 });
    expect(owned.contacts.map((c) => c.id)).toEqual([zed]);
    const none = await scopeContacts(asViewer, { ownerId: 'none' }, { offset: 0, limit: 25, sort: 'name', dir: 'asc' });
    expect(none.contacts.map((c) => c.name)).toEqual(['Amy']);
    expect((await scopeContacts(asViewer, { consent: 'opted_out' }, { offset: 0, limit: 25 })).total).toBe(0);

    await expect(bulkContactAction(asAgent, { scope: { contactIds: [amy] }, action: { type: 'assign_owner', ownerId: ownerB }, expected: 1 }))
      .rejects.toThrow(/member/);
    expect(await bulkContactAction(asAgent, { scope: {}, action: { type: 'assign_owner', ownerId: ownerA }, expected: 2 }))
      .toEqual({ matched: 2, changed: 2 });
    expect((await q("SELECT count(*)::int AS n FROM contact_activity WHERE account_id=$1 AND kind='owner_changed'", [A])).rows[0].n).toBeGreaterThanOrEqual(3);
    const sorted = await scopeContacts(asViewer, {}, { offset: 0, limit: 25, sort: 'name', dir: 'desc' });
    expect(sorted.contacts.map((c) => c.name)).toEqual(['Zed', 'Amy']);
    expect(sorted.contacts[0]).toHaveProperty('owner_id', ownerA);
  });

  it('keeps contact_activity inside the workspace and away from viewers', async () => {
    await expect(withTenant(asAgent, (tx) => tx.$executeRaw`INSERT INTO contact_activity(account_id,contact_id,kind) VALUES(${B}::uuid,${other}::uuid,'blocked')`))
      .rejects.toThrow();
    await expect(withTenant(asViewer, (tx) => tx.$executeRaw`INSERT INTO contact_activity(account_id,contact_id,kind) VALUES(${A}::uuid,${amy}::uuid,'blocked')`))
      .rejects.toThrow();
    const seenByB = await withTenant({ accountId: B, userId: ownerB, role: 'owner' }, (tx) =>
      tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM contact_activity WHERE contact_id=${zed}::uuid`);
    expect(seenByB[0].n).toBe(0);
  });

  it('lists the timeline and refuses an Instagram switch without an identity', async () => {
    const overview = await contactOverview(asViewer, zed);
    expect(overview?.has_instagram).toBe(false);
    const kinds = overview!.timeline.map((e) => e.kind);
    expect(kinds).toContain('created');
    expect(kinds).toContain('field_changed');
    expect(kinds).toContain('blocked');
    expect(JSON.stringify(overview!.timeline)).not.toContain('Pune');
    expect(await contactOverview(asViewer, other)).toBeNull();
    expect(await setInstagramConsentByMember(asAgent, zed, 'opted_out')).toBe('no_identity');
    expect(await setInstagramConsentByMember(asAgent, other, 'opted_out')).toBe('not_found');
  });
});
