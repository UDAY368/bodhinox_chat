import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import type { TenantContext } from '@/lib/db/tenant';
import type { QuerySpec } from '@/lib/data/types';
import { executeQuery } from '@/lib/repositories/crm';
import { executeRpc } from '@/lib/repositories/rpc';
import { AudienceFilterError } from '@/lib/audience/filter';
import { changeListMembers, createList, listContacts } from '@/lib/audience/lists';
import { createSegment, previewAudience, segmentContacts } from '@/lib/audience/segments';
import { loadDashboardOperations } from '@/lib/dashboard/operations';
import { projectRealtimePayload } from '@/lib/realtime/projection';
import { maskRealtimePayload, resolvePhoneMask } from './masking-apply';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;

const accountA = randomUUID();
const admin = randomUUID(), masked = randomUUID(), plain = randomUUID(), viewer = randomUUID();
const asAdmin: TenantContext = { accountId: accountA, userId: admin, role: 'admin' };
const asMasked: TenantContext = { accountId: accountA, userId: masked, role: 'agent' };
const asPlain: TenantContext = { accountId: accountA, userId: plain, role: 'agent' };
const asViewer: TenantContext = { accountId: accountA, userId: viewer, role: 'viewer' };
const seed = String(Date.now()).slice(-8);
// +44 7700 9xxxxx style: 12 digits, unique per run.
const phone = `+447${seed}1`;
const digits = phone.slice(1);
const last4 = digits.slice(-4);
const nameless = `+447${seed}2`;
let owner: pg.Client;
let contact = '';
let tag = '';

const select = (context: TenantContext, spec: Partial<QuerySpec> & { resource: string }) =>
  executeQuery({ operation: 'select', filters: [], ...spec } as QuerySpec, context, true);
// The full number in any spelling: E.164, digits, or the 7+ digit tail.
const leaks = (value: unknown) => {
  const text = JSON.stringify(value);
  return text.includes(digits) || text.includes(digits.slice(-9)) || text.includes(nameless.slice(-9));
};

describe.skipIf(!ownerUrl || !appUrl)('phone masking on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Mask test', 'test-only-hash' FROM unnest($1::uuid[]) x",
      [[admin, masked, plain, viewer]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Mask A',$2)", [accountA, admin]);
    await owner.query(`INSERT INTO account_memberships(account_id,user_id,role,mask_phone_numbers) VALUES
      ($1,$2,'admin',false),($1,$3,'agent',true),($1,$4,'agent',false),($1,$5,'viewer',true)`, [accountA, admin, masked, plain, viewer]);
    contact = (await owner.query("INSERT INTO contacts(account_id,user_id,phone,name,wa_user_id) VALUES($1,$2,$3,'Asha',$4) RETURNING id",
      [accountA, admin, phone, digits])).rows[0].id;
    const unnamed = (await owner.query('INSERT INTO contacts(account_id,user_id,phone) VALUES($1,$2,$3) RETURNING id', [accountA, admin, nameless])).rows[0].id;
    await owner.query('INSERT INTO conversations(account_id,user_id,contact_id) VALUES($1,$2,$3),($1,$2,$4)', [accountA, admin, contact, unnamed]);
    // A waiting customer message puts the unnamed contact in the dashboard queue.
    await owner.query(`INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,message_id,status)
      SELECT $1, id, 'customer', 'text', 'Hi', $3, 'delivered' FROM conversations WHERE account_id=$1 AND contact_id=$2`, [accountA, unnamed, `mask-${seed}`]);
    tag = (await owner.query("INSERT INTO tags(account_id,user_id,name) VALUES($1,$2,'VIP') RETURNING id", [accountA, admin])).rows[0].id;
    await owner.query('INSERT INTO contact_tags(account_id,contact_id,tag_id) VALUES($1,$2,$3)', [accountA, contact, tag]);
  });

  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id = $1::uuid', [accountA]).catch(() => undefined);
      await owner.query('DELETE FROM accounts WHERE id=$1', [accountA]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[admin, masked, plain, viewer]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('resolves the flag from the live membership', async () => {
    expect(await resolvePhoneMask(asMasked)).toBe(true);
    expect(await resolvePhoneMask(asViewer)).toBe(true);
    expect(await resolvePhoneMask(asPlain)).toBe(false);
    expect(await resolvePhoneMask(asAdmin)).toBe(false);
  });

  it('masks contacts list and detail for a masked member only', async () => {
    const list = await select(asMasked, { resource: 'contacts' });
    expect(list.error).toBeNull();
    expect(list.data.length).toBe(2);
    expect(leaks(list)).toBe(false);
    const row = list.data.find((c: { id: string }) => c.id === contact);
    expect(row.phone).toMatch(/^\+44 7\d•+\d{3}$/);
    expect(row.phone.endsWith(digits.slice(-3))).toBe(true);
    const detail = await select(asViewer, { resource: 'contacts', filters: [{ field: 'id', op: 'eq', value: contact }], cardinality: 'single' });
    expect(detail.data.name).toBe('Asha');
    expect(leaks(detail)).toBe(false);
    expect((await select(asPlain, { resource: 'contacts', filters: [{ field: 'id', op: 'eq', value: contact }], cardinality: 'single' })).data.phone).toBe(phone);
    expect((await select(asAdmin, { resource: 'contacts', filters: [{ field: 'id', op: 'eq', value: contact }], cardinality: 'single' })).data.wa_user_id).toBe(digits);
  });

  it('masks the contact embedded in conversation list and detail', async () => {
    const list = await select(asMasked, { resource: 'conversations', projection: '*, contact:contacts(*)' });
    expect(list.error).toBeNull();
    expect(list.data.length).toBe(2);
    expect(leaks(list)).toBe(false);
    const detail = await select(asMasked, {
      resource: 'conversations', projection: 'id, contact:contacts(id,name,phone,wa_user_id)',
      filters: [{ field: 'contact_id', op: 'eq', value: contact }], cardinality: 'single',
    });
    expect(detail.data.contact.name).toBe('Asha');
    expect(leaks(detail)).toBe(false);
  });

  it('masks numbers returned by a mutation', async () => {
    const updated = await executeQuery({
      resource: 'contacts', operation: 'update', values: { company: 'Acme' }, returning: true,
      filters: [{ field: 'id', op: 'eq', value: contact }],
    } as QuerySpec, asMasked, true);
    expect(updated.error).toBeNull();
    expect(updated.data[0].company).toBe('Acme');
    expect(leaks(updated)).toBe(false);
  });

  it('searches by the last four digits only', async () => {
    const search = (term: string, context = asMasked) =>
      select(context, { resource: 'contacts', or: [`name.ilike.%${term}%,phone.ilike.%${term}%,email.ilike.%${term}%`] });
    expect((await search(last4)).data.map((c: { id: string }) => c.id)).toEqual([contact]);
    expect((await search(digits)).data).toEqual([]);
    expect((await search(digits.slice(-6))).data).toEqual([]);
    // A middle window of four digits is not a suffix, so it matches nothing.
    expect((await search(digits.slice(-7, -3))).data).toEqual([]);
    expect((await search('asha')).data.map((c: { id: string }) => c.id)).toEqual([contact]);
    expect((await search(digits, asPlain)).data.map((c: { id: string }) => c.id)).toEqual([contact]);
    const exact = await select(asMasked, { resource: 'contacts', filters: [{ field: 'phone', op: 'eq', value: phone }] });
    expect(exact.data).toEqual([]);
    const related = await select(asMasked, { resource: 'conversations', filters: [{ field: 'contacts.wa_user_id', op: 'eq', value: digits }] });
    expect(related.data).toEqual([]);
    const sorted = await select(asMasked, { resource: 'contacts', orders: [{ field: 'phone', ascending: true }] });
    expect(sorted.error?.code).toBe('PHONE_MASKED');
  });

  it('masks and limits the contacts-by-tags search', async () => {
    const rpc = (term: string | null, context = asMasked) =>
      executeRpc<{ contact: Record<string, string>; total_count: number }[]>('filter_contacts_by_tags', { p_tag_ids: [tag], p_search: term }, context, true);
    const all = await rpc(null);
    expect(all.error).toBeNull();
    expect(all.data!.map((r) => r.contact.id)).toEqual([contact]);
    expect(Number(all.data![0].total_count)).toBe(1);
    expect(leaks(all)).toBe(false);
    expect((await rpc(last4)).data!.map((r) => r.contact.id)).toEqual([contact]);
    expect((await rpc(digits)).data).toEqual([]);
    expect((await rpc(digits, asPlain)).data![0].contact.phone).toBe(phone);
  });

  it('masks list and segment pages and refuses number-probing filters', async () => {
    const list = await createList(asAdmin, { name: `Mask ${seed}` });
    await changeListMembers(asAdmin, list.id, { add: [contact] });
    const page = await listContacts(asMasked, list.id, { offset: 0, limit: 25 });
    expect(page?.contacts.map((c) => c.id)).toEqual([contact]);
    expect(leaks(page)).toBe(false);
    expect((await listContacts(asMasked, list.id, { offset: 0, limit: 25, search: digits }))?.contacts).toEqual([]);
    expect((await listContacts(asMasked, list.id, { offset: 0, limit: 25, search: last4 }))?.contacts.map((c) => c.id)).toEqual([contact]);
    expect(JSON.stringify(await listContacts(asPlain, list.id, { offset: 0, limit: 25 }))).toContain(digits);

    const probe = { conditions: [{ field: 'phone', op: 'contains', value: digits.slice(-6) }] };
    await expect(previewAudience(asMasked, { filter: probe })).rejects.toBeInstanceOf(AudienceFilterError);
    await expect(createSegment(asMasked, { name: `Probe ${seed}`, filter: probe })).rejects.toBeInstanceOf(AudienceFilterError);
    expect((await previewAudience(asPlain, { filter: probe })).total).toBe(1);
    const segment = await createSegment(asAdmin, { name: `Tagged ${seed}`, filter: { conditions: [{ field: 'tags', op: 'has_any', tagIds: [tag] }] } });
    const segmentPage = await segmentContacts(asMasked, segment.id, { offset: 0, limit: 25 });
    expect(segmentPage.contacts.map((c) => c.id)).toEqual([contact]);
    expect(leaks(segmentPage)).toBe(false);
  });

  it('shows an unnamed contact as Contact, not its number, on the dashboard', async () => {
    const overview = await loadDashboardOperations(asMasked, 7);
    expect(leaks(overview)).toBe(false);
    expect(JSON.stringify(overview)).toContain('"name":"Contact"');
    expect(JSON.stringify(await loadDashboardOperations(asPlain, 7))).toContain(nameless);
  });

  it('masks numbers quoted in notification titles and bodies for a masked member only', async () => {
    await owner.query(`INSERT INTO notifications(account_id,user_id,type,title,body) VALUES
      ($1,$2,'mention',$4,$5),($1,$3,'mention',$4,$5)`,
      [accountA, masked, plain, `New chat from ${phone}`, `Call back on ${digits} before 2026-11-03`]);
    const mine = await select(asMasked, { resource: 'notifications', filters: [{ field: 'type', op: 'eq', value: 'mention' }] });
    expect(mine.error).toBeNull();
    expect(mine.data).toHaveLength(1);
    expect(leaks(mine)).toBe(false);
    expect(mine.data[0].title).toContain(digits.slice(-3));
    // Dates in the same text are kept.
    expect(mine.data[0].body).toContain('2026-11-03');
    const theirs = await select(asPlain, { resource: 'notifications', filters: [{ field: 'type', op: 'eq', value: 'mention' }] });
    expect(theirs.data).toHaveLength(1);
    expect(theirs.data[0].title).toBe(`New chat from ${phone}`);
  });

  it('refuses number writes from a masked member and keeps the stored number', async () => {
    const write = (context: TenantContext, spec: Partial<QuerySpec>) =>
      executeQuery({ resource: 'contacts', filters: [], ...spec } as QuerySpec, context, true);
    const byId = [{ field: 'id', op: 'eq', value: contact }];
    // The masked display value saved back by an edit form, a candidate number, and a WhatsApp id.
    for (const values of [{ name: 'Asha', phone: '+44 7•••••••••1' }, { phone: `+447${seed}9` }, { wa_user_id: '447000000000' }]) {
      const result = await write(asMasked, { operation: 'update', values, filters: byId } as Partial<QuerySpec>);
      expect(result.error).toMatchObject({ code: 'PHONE_MASKED' });
    }
    // Inserting a number would confirm an existing one through the unique index.
    const insert = await write(asMasked, { operation: 'insert', values: { name: 'Probe', phone } } as Partial<QuerySpec>);
    expect(insert.error).toMatchObject({ code: 'PHONE_MASKED' });
    const insertNew = await write(asMasked, { operation: 'insert', values: { name: 'Probe', phone: `+447${seed}8` } } as Partial<QuerySpec>);
    expect(insertNew.error).toMatchObject({ code: 'PHONE_MASKED' });
    const stored = (await owner.query('SELECT phone, phone_normalized, wa_user_id, name FROM contacts WHERE id=$1', [contact])).rows[0];
    expect(stored).toMatchObject({ phone, wa_user_id: digits, name: 'Asha' });
    expect(stored.phone_normalized).toContain(digits.slice(-9));
    expect((await owner.query('SELECT count(*)::int AS n FROM contacts WHERE account_id=$1', [accountA])).rows[0].n).toBe(2);
    // Other fields stay editable, and an unmasked member may still change the number.
    expect((await write(asMasked, { operation: 'update', values: { name: 'Asha' }, filters: byId } as Partial<QuerySpec>)).error).toBeNull();
    expect((await write(asPlain, { operation: 'update', values: { phone }, filters: byId } as Partial<QuerySpec>)).error).toBeNull();
  });

  it('masks numbers in broadcast recipient template variables, read and realtime', async () => {
    const broadcast = (await owner.query(
      "INSERT INTO broadcasts(account_id,user_id,name,template_name) VALUES($1,$2,'Mask campaign','hello') RETURNING id",
      [accountA, admin])).rows[0].id;
    const recipient = (await owner.query(
      "INSERT INTO broadcast_recipients(account_id,broadcast_id,contact_id,template_params) VALUES($1,$2,$3,$4::jsonb) RETURNING id",
      [accountA, broadcast, contact, JSON.stringify(['Asha', phone, digits])])).rows[0].id;
    const read = (context: TenantContext) => select(context, {
      resource: 'broadcast_recipients', projection: 'contact_id,template_params', filters: [{ field: 'broadcast_id', op: 'eq', value: broadcast }],
    });
    const mine = await read(asMasked);
    expect(mine.error).toBeNull();
    expect(mine.data).toHaveLength(1);
    expect(leaks(mine)).toBe(false);
    expect(mine.data[0].template_params[0]).toBe('Asha');
    expect(mine.data[0].template_params[1]).toContain(digits.slice(-3));
    expect((await read(asPlain)).data[0].template_params).toEqual(['Asha', phone, digits]);
    // The outbox row the trigger wrote, as the event stream sends it.
    const event = (await owner.query(
      "SELECT payload FROM outbox_events WHERE account_id=$1 AND event_type='broadcast_recipients.INSERT' AND payload->'new'->>'id'=$2",
      [accountA, recipient])).rows[0].payload;
    expect(leaks(event)).toBe(true);
    expect(leaks(maskRealtimePayload(projectRealtimePayload(event), true))).toBe(false);
    expect(leaks(maskRealtimePayload(projectRealtimePayload(event), false))).toBe(true);
  });

  it('takes effect as soon as an admin turns masking off', async () => {
    await owner.query('UPDATE account_memberships SET mask_phone_numbers=false WHERE user_id=$1', [viewer]);
    const detail = await select(asViewer, { resource: 'contacts', filters: [{ field: 'id', op: 'eq', value: contact }], cardinality: 'single' });
    expect(detail.data.phone).toBe(phone);
    await owner.query('UPDATE account_memberships SET mask_phone_numbers=true WHERE user_id=$1', [viewer]);
  });
});
