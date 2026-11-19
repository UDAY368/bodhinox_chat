import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Store plan Phase 8 batch 1 on PostgreSQL: quotes (a pre-filled shop session: expiry, one send per
// request, prices worked out again at checkout, tenancy and role), order tags and internal notes
// (agents write, other workspaces cannot see or change them, never in the buyer's view), the admin-only
// CSV export (tenancy, phone masking, formula safety, date range) and the risk hint computed on read.
// Meta is never called: the text sender is a fake.
const sends = vi.hoisted(() => ({ apiText: vi.fn() }));
vi.mock('@/lib/whatsapp/meta-api', async (original) => ({
  ...(await original<typeof import('@/lib/whatsapp/meta-api')>()),
  sendTextMessage: (...args: unknown[]) => sends.apiText(...args),
}));

import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { encrypt } from '@/lib/whatsapp/encryption';
import { placeOrder } from './checkout';
import { exportOrdersCsv } from './order-export';
import { getOrder, listOrders, OrderError, parseOrderFilters, updateOrder } from './orders';
import { createQuote, listQuotes, parseQuoteInput } from './quotes';
import { assertOpen, loadOrderView, loadSession, loadStorefrontView, quoteSessionTx, setAddressTx, setPaymentMethodTx, updateCartTx } from './storefront';
import { StoreError } from './store-settings';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
process.env.APP_URL ??= 'https://app.example.test';
process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);

const account = randomUUID(), other = randomUUID(), owner = randomUUID(), admin = randomUUID(), agent = randomUUID(), viewer = randomUUID();
const asAdmin: TenantContext & { userId: string } = { accountId: account, userId: admin, role: 'admin' };
const asAgent: TenantContext & { userId: string } = { accountId: account, userId: agent, role: 'agent' };
const asViewer: TenantContext & { userId: string } = { accountId: account, userId: viewer, role: 'viewer' };
const asOther: TenantContext & { userId: string } = { accountId: other, userId: owner, role: 'owner' };
const product = randomUUID(), variant = randomUUID(), otherProduct = randomUUID(), otherVariant = randomUUID(), number = randomUUID(), otherNumber = randomUUID();
const names = ['buyer', 'silent', 'risky', 'burst', 'first', 'plain', 'otherBuyer'] as const;
const contacts = Object.fromEntries(names.map((n) => [n, randomUUID()])) as Record<(typeof names)[number], string>;
const conversations: Record<string, string> = {};
const ADDRESS = { name: 'Test buyer', phone: '+919876543210', line1: '1 MG Road', city: 'Bengaluru', state: 'Karnataka', state_code: '29',
  postal_code: '560001', country: 'IN' };
let db: pg.Client;

const run = <T,>(fn: (tx: TenantTransaction) => Promise<T>) => withTenant({ accountId: account, role: 'owner' }, fn, getWorkerPrisma());

const quoteInput = (over: Record<string, unknown> = {}) => ({
  contactId: contacts.buyer, lines: [{ variantId: variant, qty: 2 }], note: 'Here is your quote', expiresInHours: 48, clientRequestId: randomUUID(), ...over,
});
const sentText = () => String(sends.apiText.mock.calls.at(-1)?.[0]?.text ?? '');

async function insertOrder(over: Record<string, unknown> = {}) {
  const row = { id: randomUUID(), ac: account, contact: contacts.plain, status: 'new', pay: 'online', total: 50_000, address: null as unknown, at: new Date(),
    codConfirmation: null as string | null, ...over };
  await db.query(`INSERT INTO orders(id,account_id,source,contact_id,currency,subtotal_minor,total_minor,status,payment_method,shipping_address,created_at,cod_confirmation)
    VALUES($1,$2,'manual',$3,'INR',$4,$4,$5,$6,$7::jsonb,$8,$9)`,
  [row.id, row.ac, row.contact, row.total, row.status, row.pay, row.address ? JSON.stringify(row.address) : null, row.at, row.codConfirmation]);
  return row.id as string;
}

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('store phase 8 order admin tools on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'P8 admin', 'test-only-hash' FROM unnest($1::uuid[]) x",
      [[owner, admin, agent, viewer]]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'P8 admin tools',$3),($2,'P8 other',$3)", [account, other, owner]);
    await db.query("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic'),($2,'basic')", [account, other]);
    await db.query(`INSERT INTO account_memberships(account_id,user_id,role,mask_phone_numbers) VALUES($1,$2,'owner',false),($1,$3,'admin',false),
      ($1,$4,'agent',true),($1,$5,'viewer',false),($6,$2,'owner',false)`, [account, owner, admin, agent, viewer, other]);
    await db.query(`INSERT INTO whatsapp_config(id,account_id,user_id,phone_number_id,access_token,status,is_default)
      VALUES($1,$2,$3,$4,$8,'connected',true),($5,$6,$3,$7,$8,'connected',true)`,
    [number, account, owner, `pn-${account}`, otherNumber, other, `pn-${other}`, encrypt('token-test')]);
    for (const [i, key] of names.entries()) {
      const ac = key === 'otherBuyer' ? other : account;
      await db.query(`INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,$4,$5)`,
        [contacts[key], ac, owner, key === 'plain' ? '=cmd|calc' : `Buyer ${key}`, `+14155${String(i).padStart(5, '0')}`]);
      conversations[contacts[key]] = (await db.query(`INSERT INTO conversations(account_id,user_id,contact_id,whatsapp_config_id) VALUES($1,$2,$3,$4) RETURNING id`,
        [ac, owner, contacts[key], key === 'otherBuyer' ? otherNumber : number])).rows[0].id;
    }
    // Only the buyer wrote recently: "silent" is outside the customer window.
    await db.query(`INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text) VALUES($1,$2,'customer','text','hi')`,
      [account, conversations[contacts.buyer]]);
    await db.query(`INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text) VALUES($1,$2,'customer','text','hi')`,
      [other, conversations[contacts.otherBuyer]]);
    await db.query(`INSERT INTO commerce_settings(account_id,currency,prices_include_tax,default_tax_rate_bps,checkout_enabled,reservation_minutes,cod_enabled,cod_fee_minor)
      VALUES($1,'INR',true,1800,true,15,true,0),($2,'INR',true,1800,true,15,true,0)`, [account, other]);
    await db.query(`INSERT INTO shipping_rates(account_id,name,country,fee_minor) VALUES($1,'India','IN',5000),($2,'India','IN',5000)`, [account, other]);
    await db.query(`INSERT INTO shop_products(id,account_id,name,status,content_reviewed_at) VALUES($1,$2,'Tulsi drops','published',now()),($3,$4,'Other drops','published',now())`,
      [product, account, otherProduct, other]);
    await db.query(`INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor) VALUES($1,$2,$3,'TUL-60',49900),($4,$5,$6,'OTH-1',9900)`,
      [variant, account, product, otherVariant, other, otherProduct]);
    await db.query(`INSERT INTO inventory_levels(account_id,variant_id,on_hand) VALUES($1,$2,1000),($3,$4,1000)`, [account, variant, other, otherVariant]);
  });

  beforeEach(() => {
    sends.apiText.mockReset().mockImplementation(async () => ({ messageId: `wamid.q.${randomUUID()}` }));
  });

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM outbound_intents WHERE account_id=ANY($1::uuid[])', [[account, other]]);
      await db.query('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[account, other]]);
      await db.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[account, other]]);
      await db.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[owner, admin, agent, viewer]]);
      await db.end();
    }
    await disconnectDatabases();
  });

  describe('quotes', () => {
    it('pre-fills a shop session, sends the link once with the note, and a replay changes nothing', async () => {
      const input = quoteInput();
      const first = await createQuote(asAgent, input);
      expect(sends.apiText).toHaveBeenCalledTimes(1);
      expect(sentText()).toContain('Here is your quote');
      expect(sentText()).toMatch(/https?:\/\//);
      const [row] = (await db.query('SELECT is_quote, quote_note, cart, purpose, created_by, expires_at, contact_id FROM storefront_sessions WHERE id=$1', [first.sessionId])).rows;
      expect(row).toMatchObject({ is_quote: true, quote_note: 'Here is your quote', purpose: 'shop', created_by: agent, contact_id: contacts.buyer });
      expect(row.cart).toEqual([{ variant_id: variant, qty: 2 }]);
      const hours = (row.expires_at.getTime() - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(47.5);
      expect(hours).toBeLessThan(48.1);
      // Staff sent it: no automatic abandoned-cart reminder is queued for it.
      expect((await db.query("SELECT 1 FROM jobs WHERE tenant_id=$1 AND dedupe_key LIKE $2", [account, `%${first.sessionId}%`])).rowCount).toBe(0);
      expect((await db.query("SELECT 1 FROM audit_logs WHERE account_id=$1 AND action='commerce.quote_created' AND resource_id=$2", [account, first.sessionId])).rowCount).toBe(1);

      const again = await createQuote(asAgent, input);
      expect(again.sessionId).toBe(first.sessionId);
      expect(sends.apiText).toHaveBeenCalledTimes(1);
    });

    it('never locks a price: the customer is quoted the current catalogue price at checkout', async () => {
      const q = await createQuote(asAgent, quoteInput());
      await db.query('UPDATE shop_variants SET price_minor=59900 WHERE id=$1', [variant]);
      try {
        const price = await run(async (tx) => (await quoteSessionTx(tx, account, (await loadSession(tx, account, q.sessionId))!)).result);
        if (!price.ok) throw new Error(`refused: ${price.code}`);
        expect(price.quote.subtotalMinor).toBe(2 * 59_900);
      } finally {
        await db.query('UPDATE shop_variants SET price_minor=49900 WHERE id=$1', [variant]);
      }
    });

    it('cannot be opened or changed once it has expired (or been revoked)', async () => {
      const q = await createQuote(asAgent, quoteInput());
      expect((await run((tx) => loadStorefrontView(tx, account, q.sessionId)))?.open).toBe(true);
      await db.query("UPDATE storefront_sessions SET expires_at=now() - interval '1 second' WHERE id=$1", [q.sessionId]);
      expect((await run((tx) => loadStorefrontView(tx, account, q.sessionId)))?.open).toBe(false);
      await expect(run(async (tx) => assertOpen((await loadSession(tx, account, q.sessionId))!))).rejects.toMatchObject({ code: 'session_expired' });
      await expect(run((tx) => updateCartTx(tx, account, q.sessionId, { expectedVersion: 1, lines: [{ variantId: variant, qty: 1 }] })))
        .rejects.toMatchObject({ code: 'session_expired' });
      expect((await listQuotes(asAgent)).find((x) => x.id === q.sessionId)?.state).toBe('expired');
    });

    it('is refused before anything is made or sent: outside the customer window, no cart, bad variant, blocked contact, viewer', async () => {
      const before = (await db.query('SELECT count(*)::int AS n FROM storefront_sessions WHERE account_id=$1', [account])).rows[0].n;
      await expect(createQuote(asAgent, quoteInput({ contactId: contacts.silent }))).rejects.toMatchObject({ code: 'outside_window' });
      await expect(createQuote(asAgent, quoteInput({ lines: [{ variantId: otherVariant, qty: 1 }] }))).rejects.toMatchObject({ code: 'variant_unavailable' });
      await expect(createQuote(asViewer, quoteInput())).rejects.toBeTruthy();
      await db.query("UPDATE contacts SET blocked_at=now() WHERE id=$1", [contacts.buyer]);
      try {
        await expect(createQuote(asAgent, quoteInput())).rejects.toMatchObject({ code: 'contact_blocked' });
      } finally {
        await db.query('UPDATE contacts SET blocked_at=NULL WHERE id=$1', [contacts.buyer]);
      }
      expect(sends.apiText).not.toHaveBeenCalled();
      expect((await db.query('SELECT count(*)::int AS n FROM storefront_sessions WHERE account_id=$1', [account])).rows[0].n).toBe(before);
      expect(() => parseQuoteInput({ contact_id: contacts.buyer, client_request_id: randomUUID(), lines: [] })).toThrow(StoreError);
    });

    it('is invisible and unusable from another workspace', async () => {
      const q = await createQuote(asAgent, quoteInput());
      expect((await listQuotes(asOther)).map((x) => x.id)).not.toContain(q.sessionId);
      expect((await listQuotes(asAgent)).map((x) => x.id)).toContain(q.sessionId);
      expect(await withTenant({ accountId: other, role: 'owner' }, (tx) => loadSession(tx, other, q.sessionId), getWorkerPrisma())).toBeNull();
      await expect(createQuote(asOther, quoteInput({ clientRequestId: randomUUID() }))).rejects.toMatchObject({ code: 'contact_not_found' });
      await expect(createQuote(asOther, quoteInput({ contactId: contacts.otherBuyer, lines: [{ variantId: variant, qty: 1 }] })))
        .rejects.toMatchObject({ code: 'variant_unavailable' });
      expect(sends.apiText).toHaveBeenCalledTimes(1);
    });

    it('is used through the normal checkout: the order is the quote session, priced by the server, and the quote reads as ordered', async () => {
      const q = await createQuote(asAgent, quoteInput({ lines: [{ variantId: variant, qty: 1 }] }));
      await run((tx) => setAddressTx(tx, account, q.sessionId, { expectedVersion: 1, address: ADDRESS }));
      await run((tx) => setPaymentMethodTx(tx, account, q.sessionId, { expectedVersion: 2, paymentMethod: 'cod' }));
      const quote = await run(async (tx) => (await quoteSessionTx(tx, account, (await loadSession(tx, account, q.sessionId))!)).result);
      if (!quote.ok) throw new Error(`refused: ${quote.code}`);
      const placed = await placeOrder(account, q.sessionId, { expectedVersion: 3, expectedTotalMinor: quote.quote.totalMinor, clientRequestId: randomUUID() });
      expect((await listQuotes(asAgent)).find((x) => x.id === q.sessionId)?.state).toBe('ordered');

      // The internal note and tags never reach the buyer's view of their order.
      await updateOrder(asAgent, placed.orderId, { note: 'INTERNAL-SECRET-NOTE', tags: ['internal-tag-x'] });
      const view = await run((tx) => loadOrderView(tx, account, placed.orderId));
      expect(JSON.stringify(view)).not.toMatch(/INTERNAL-SECRET-NOTE|internal-tag-x/);
      expect(JSON.stringify(await run((tx) => loadStorefrontView(tx, account, q.sessionId)))).not.toMatch(/INTERNAL-SECRET-NOTE|internal-tag-x/);
    });
  });

  describe('tags and internal notes', () => {
    it('lets an agent set cleaned, deduplicated tags and a note, and filters the list by tag', async () => {
      const id = await insertOrder();
      const saved = await updateOrder(asAgent, id, { tags: ['vip', 'rush'], note: 'Call before shipping' });
      expect(saved.tags).toEqual(['vip', 'rush']);
      expect(saved.note).toBe('Call before shipping');
      expect((await listOrders(asAgent, parseOrderFilters(new URLSearchParams('tag=VIP')))).orders.map((o) => o.id)).toContain(id);
      expect((await listOrders(asAgent, { tag: 'nope' })).orders.map((o) => o.id)).not.toContain(id);
      expect((await updateOrder(asAgent, id, { tags: [] })).tags).toEqual([]);
      expect(() => parseOrderFilters(new URLSearchParams('tag==bad'))).toThrow(OrderError);
    });

    it('is refused for a viewer and invisible to, and untouchable by, another workspace', async () => {
      const id = await insertOrder();
      await updateOrder(asAgent, id, { tags: ['keep'], note: 'secret' });
      await expect(updateOrder(asViewer, id, { tags: ['viewer-edit'] })).rejects.toBeTruthy();
      await expect(updateOrder(asOther, id, { tags: ['other-edit'], note: 'other-note' })).rejects.toMatchObject({ code: 'not_found' });
      await expect(getOrder(asOther, id)).rejects.toMatchObject({ code: 'not_found' });
      expect((await listOrders(asOther, { tag: 'keep' })).orders).toEqual([]);
      const [row] = (await db.query('SELECT tags, note FROM orders WHERE id=$1', [id])).rows;
      expect(row).toEqual({ tags: ['keep'], note: 'secret' });
    });

    it('caps the tags in the database too', async () => {
      const id = await insertOrder();
      await expect(db.query('UPDATE orders SET tags=$2::text[] WHERE id=$1', [id, Array.from({ length: 11 }, (_, i) => `t${i}`)])).rejects.toThrow(/orders_tags_check/);
    });

    it('lets the app role change tags and nothing money-related', async () => {
      const id = await insertOrder();
      await expect(withTenant(asAgent, (tx) => tx.$executeRaw`UPDATE orders SET total_minor=1 WHERE id=${id}::uuid`)).rejects.toBeTruthy();
    });
  });

  describe('csv export', () => {
    it('exports only this workspace, defuses formulas, honours masking and the date range', async () => {
      const mine = await insertOrder({ contact: contacts.plain, at: new Date('2026-11-10T10:00:00Z') });
      const old = await insertOrder({ contact: contacts.plain, at: new Date('2026-01-10T10:00:00Z') });
      const theirs = await insertOrder({ ac: other, contact: contacts.otherBuyer });
      await updateOrder(asAgent, mine, { tags: ['vip'] });

      const everything = await exportOrdersCsv(asAdmin, {});
      expect(everything.csv).toContain(mine.slice(0, 8).toUpperCase());
      expect(everything.csv).toContain(old.slice(0, 8).toUpperCase());
      expect(everything.csv).not.toContain(theirs.slice(0, 8).toUpperCase());
      expect(everything.csv).not.toContain('Buyer otherBuyer');
      expect(everything.csv).toContain('"\'=cmd|calc"');
      expect(everything.csv).toContain('"vip"');
      expect(everything.csv).toContain('"\'+14155');
      expect(everything.truncated).toBe(false);

      const ranged = await exportOrdersCsv(asAdmin, { from: new Date('2026-11-01T00:00:00Z'), to: new Date('2026-11-30T00:00:00Z') });
      expect(ranged.csv).toContain(mine.slice(0, 8).toUpperCase());
      expect(ranged.csv).not.toContain(old.slice(0, 8).toUpperCase());

      // A member whose numbers are masked gets them masked in the file too.
      const masked = await exportOrdersCsv(asAgent, {});
      expect(masked.csv).not.toContain('+14155');
      expect(masked.csv).not.toContain('14155000');
      expect((await exportOrdersCsv(asOther, {})).csv).not.toContain(mine.slice(0, 8).toUpperCase());
    });
  });

  describe('risk hint on read', () => {
    it('is low for an ordinary order and high with a bad COD history, a declined confirmation and a bad pincode', async () => {
      const fine = await insertOrder({ contact: contacts.first, address: { country: 'IN', postal_code: '560001' }, at: new Date('2026-10-01T10:00:00Z') });
      expect((await getOrder(asAgent, fine)).risk).toEqual({ level: 'low', reasons: [] });

      await insertOrder({ contact: contacts.risky, pay: 'cod', status: 'cancelled', at: new Date('2026-10-01T10:00:00Z') });
      await insertOrder({ contact: contacts.risky, pay: 'cod', status: 'new', codConfirmation: 'declined', at: new Date('2026-10-05T10:00:00Z') });
      const bad = await insertOrder({ contact: contacts.risky, pay: 'cod', codConfirmation: 'declined', address: { country: 'IN', postal_code: '12' }, at: new Date('2026-11-01T10:00:00Z') });
      const risk = (await getOrder(asAgent, bad)).risk;
      expect(risk.level).toBe('high');
      expect(risk.reasons).toEqual(expect.arrayContaining(['cod_history', 'cod_declined', 'pincode_invalid']));
      expect((await listOrders(asAgent, { contactId: contacts.risky })).orders.find((o) => o.id === bad)?.risk.level).toBe('high');
    });

    it('flags a burst of orders from one contact, and never uses another workspace\'s orders', async () => {
      const base = Date.parse('2026-11-12T10:00:00Z');
      const ids = [];
      for (let i = 0; i < 3; i++) ids.push(await insertOrder({ contact: contacts.burst, at: new Date(base + i * 60_000) }));
      expect((await getOrder(asAgent, ids[2])).risk.reasons).toContain('order_burst');
      const lone = await insertOrder({ ac: other, contact: contacts.otherBuyer });
      expect((await getOrder(asOther, lone)).risk).toEqual({ level: 'low', reasons: [] });
    });
  });
});
