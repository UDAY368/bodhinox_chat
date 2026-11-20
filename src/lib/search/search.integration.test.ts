import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AudienceFilterError } from '@/lib/audience/filter';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import type { TenantContext } from '@/lib/db/tenant';
import { searchContacts } from './contacts';
import { globalSearch } from './global';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;

const accountA = randomUUID(), accountB = randomUUID();
const adminA = randomUUID(), maskedA = randomUUID(), viewerA = randomUUID(), ownerB = randomUUID();
const users = [adminA, maskedA, viewerA, ownerB];
const asAdmin: TenantContext = { accountId: accountA, userId: adminA, role: 'admin' };
const asMasked: TenantContext = { accountId: accountA, userId: maskedA, role: 'agent' };
const asViewer: TenantContext = { accountId: accountA, userId: viewerA, role: 'viewer' };
const asB: TenantContext = { accountId: accountB, userId: ownerB, role: 'owner' };
const BULK = 55;
let owner: pg.Client;
const ids: Record<string, string> = {};

describe.skipIf(!ownerUrl || !appUrl)('contact and global search on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');

    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Search test', 'test-only-hash' FROM unnest($1::uuid[]) x", [users]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Search A',$2),($3,'Search B',$4)", [accountA, adminA, accountB, ownerB]);
    await owner.query(`INSERT INTO account_memberships(account_id,user_id,role,mask_phone_numbers) VALUES
      ($1,$2,'admin',false),($1,$3,'agent',true),($1,$4,'viewer',false),($5,$6,'owner',false)`,
    [accountA, adminA, maskedA, viewerA, accountB, ownerB]);

    const contact = async (key: string, account: string, user: string, phone: string, name: string | null, at: string) => {
      ids[key] = (await owner.query('INSERT INTO contacts(account_id,user_id,phone,name,created_at) VALUES($1,$2,$3,$4,$5) RETURNING id',
        [account, user, phone, name, at])).rows[0].id;
    };
    await contact('asha', accountA, adminA, '+91 98765 43210', 'Asha Rao', '2026-11-10T10:00:00.123456Z');
    await contact('ravi', accountA, adminA, '9876500001', 'Ravi', '2026-11-11T10:00:00Z');
    await contact('ashaB', accountB, ownerB, '+91 98765 43210', 'Asha Secret', '2026-11-12T10:00:00Z');
    // Many contacts created in the same instant, so paging must break ties by id.
    await owner.query(`INSERT INTO contacts(account_id,user_id,phone,name,created_at)
      SELECT $1, $2, '7000' || lpad(n::text, 6, '0'), 'Bulk ' || n, '2026-11-01T00:00:00.000001Z' FROM generate_series(1, ${BULK}) n`, [accountA, adminA]);

    // Commerce and bookings for both accounts.
    for (const [account, user, key] of [[accountA, adminA, 'asha'], [accountB, ownerB, 'ashaB']] as const) {
      const suffix = account === accountA ? 'A' : 'B';
      ids[`order${suffix}`] = (await owner.query(`INSERT INTO orders(account_id,source,contact_id,currency,subtotal_minor,external_id)
        VALUES($1,'storefront',$2,'INR',1000,$3) RETURNING id`, [account, ids[key], `WA1042${suffix}`])).rows[0].id;
      ids[`product${suffix}`] = (await owner.query("INSERT INTO shop_products(account_id,name,created_by) VALUES($1,$2,$3) RETURNING id",
        [account, `Silk Saree ${suffix}`, user])).rows[0].id;
      await owner.query('INSERT INTO shop_variants(account_id,product_id,sku) VALUES($1,$2,$3)', [account, ids[`product${suffix}`], `SAREE-RED-${suffix}`]);
      const location = (await owner.query("INSERT INTO appointment_locations(account_id,name,timezone) VALUES($1,'Main','Asia/Kolkata') RETURNING id", [account])).rows[0].id;
      const service = (await owner.query("INSERT INTO appointment_services(account_id,name,mode,duration_minutes) VALUES($1,'Haircut','offline',30) RETURNING id", [account])).rows[0].id;
      ids[`booking${suffix}`] = (await owner.query(`INSERT INTO appointments(account_id,contact_id,service_id,location_id,start_at,end_at,timezone,status,source,service_name)
        VALUES($1,$2,$3,$4,'2026-12-01T05:00:00Z','2026-12-01T05:30:00Z','Asia/Kolkata','confirmed','staff','Haircut') RETURNING id`,
      [account, ids[key], service, location])).rows[0].id;
    }
  });

  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [users]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('matches a name case-insensitively within the caller account only', async () => {
    const page = await searchContacts(asAdmin, { q: 'ASHA' });
    expect(page.contacts.map((c) => c.id)).toEqual([ids.asha]);
    expect(page.contacts[0]).toMatchObject({ name: 'Asha Rao', phone: '+91 98765 43210', channel: 'whatsapp' });
    expect((await searchContacts(asB, { q: 'asha' })).contacts.map((c) => c.id)).toEqual([ids.ashaB]);
  });

  it('matches a number however it is typed, never across accounts', async () => {
    for (const q of ['98765 43210', '+91 98765', '9876543210', '919876543210']) {
      const found = (await searchContacts(asAdmin, { q })).contacts.map((c) => c.id);
      expect(found, q).toContain(ids.asha);
      expect(found, q).not.toContain(ids.ashaB);
    }
  });

  it('pages with a cursor through rows created in the same instant without gaps or repeats', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Awaited<ReturnType<typeof searchContacts>> = await searchContacts(asAdmin, { q: 'bulk', limit: 20, cursor });
      seen.push(...page.contacts.map((c) => c.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(BULK);
    expect(new Set(seen).size).toBe(BULK);
  });

  it('lists the newest contacts for an empty query and caps the page size', async () => {
    const page = await searchContacts(asAdmin, { q: '', limit: 500 });
    expect(page.contacts).toHaveLength(50);
    expect(page.contacts.slice(0, 2).map((c) => c.id)).toEqual([ids.ravi, ids.asha]);
    expect(page.nextCursor).not.toBeNull();
  });

  it('refuses a forged cursor', async () => {
    await expect(searchContacts(asAdmin, { q: '', cursor: 'not-a-cursor' })).rejects.toBeInstanceOf(AudienceFilterError);
  });

  it('masks numbers and limits number search for a masked member', async () => {
    expect((await searchContacts(asMasked, { q: '9876543210' })).contacts).toEqual([]);
    const hits = (await searchContacts(asMasked, { q: '3210' })).contacts;
    expect(hits.map((c) => c.id)).toEqual([ids.asha]);
    expect(hits[0].phone).not.toContain('98765');
  });

  it('finds contacts, orders, products and bookings of the caller account', async () => {
    const result = await globalSearch(asAdmin, { q: 'asha' });
    expect(result.contacts.map((c) => c.href)).toEqual([`/contacts/${ids.asha}`]);
    expect(result.orders.map((o) => o.id)).toEqual([ids.orderA]);
    expect(result.orders[0]).toMatchObject({ title: '#WA1042A', subtitle: 'Asha Rao', href: `/commerce/orders/${ids.orderA}` });
    expect(result.bookings.map((b) => b.href)).toEqual([`/appointments?id=${ids.bookingA}`]);
    expect((await globalSearch(asAdmin, { q: '#wa1042' })).orders.map((o) => o.id)).toEqual([ids.orderA]);
    expect((await globalSearch(asAdmin, { q: ids.orderA.slice(0, 8).toUpperCase() })).orders.map((o) => o.id)).toEqual([ids.orderA]);
    const sku = await globalSearch(asAdmin, { q: 'saree-red' });
    expect(sku.products).toEqual([{ id: ids.productA, title: 'Silk Saree A', subtitle: 'SAREE-RED-A', href: `/commerce/catalogue/${ids.productA}` }]);
    expect((await globalSearch(asAdmin, { q: '+91 98765' })).bookings.map((b) => b.id)).toEqual([ids.bookingA]);
  });

  it('never returns another account rows, and hides orders and products from viewers', async () => {
    const all = JSON.stringify(await globalSearch(asAdmin, { q: 'a' })) + JSON.stringify(await globalSearch(asAdmin, { q: 'sa' }))
      + JSON.stringify(await globalSearch(asAdmin, { q: 'WA1042B' }));
    for (const key of ['ashaB', 'orderB', 'productB', 'bookingB']) expect(all).not.toContain(ids[key]);
    expect(await globalSearch(asAdmin, { q: 'a' })).toEqual({ contacts: [], orders: [], products: [], bookings: [] });
    const viewer = await globalSearch(asViewer, { q: 'asha' });
    expect(viewer.orders).toEqual([]);
    expect(viewer.products).toEqual([]);
    expect(viewer.contacts).toHaveLength(1);
    expect(viewer.bookings).toHaveLength(1);
    const limited = await globalSearch(asAdmin, { q: 'bulk', limit: 100 });
    expect(limited.contacts).toHaveLength(8);
  });
});
