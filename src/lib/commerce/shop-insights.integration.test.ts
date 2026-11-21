import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Store plan Phase 8, batch 7 on PostgreSQL: shop reports (sales, GST, stock value), the live view counter, shop search, and shop
// redirects. Reports, the live view and redirect edits are admin-only; another workspace sees and changes nothing; a beacon flood is
// capped; old counter rows are deleted; the redirect table refuses off-shop paths and a 201st rule.
const h = vi.hoisted(() => ({ session: { accountId: '', userId: '', role: 'viewer' } as { accountId: string; userId: string; role: string } }));
vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => ({ ...h.session, sessionId: 's', user: { id: h.session.userId, email: 'x@example.invalid', user_metadata: {} } }),
}));
vi.mock('@/lib/auth/account', async (original) => {
  const real = await original<typeof import('@/lib/auth/account')>();
  const { hasMinRole } = await import('@/lib/auth/roles');
  return {
    ...real,
    requireRole: async (minimum: Parameters<typeof hasMinRole>[1]) => {
      if (!hasMinRole(h.session.role as Parameters<typeof hasMinRole>[0], minimum)) throw new real.ForbiddenError('Insufficient workspace role');
      return { ...h.session, account: { id: h.session.accountId, name: 'x' }, db: {} };
    },
  };
});

import { GET as salesRoute } from '@/app/api/analytics/shop-sales/route';
import { GET as taxRoute } from '@/app/api/analytics/shop-tax/route';
import { GET as taxCsvRoute } from '@/app/api/analytics/shop-tax/export/route';
import { GET as stockRoute } from '@/app/api/analytics/shop-stock/route';
import { GET as liveRoute } from '@/app/api/commerce/insights/live/route';
import { GET as redirectsGet, POST as redirectsPost } from '@/app/api/commerce/redirects/route';
import { DELETE as redirectDelete } from '@/app/api/commerce/redirects/[id]/route';
import { POST as beaconRoute } from '@/app/api/public/store/[handle]/live/route';
import { GET as searchRoute } from '@/app/api/public/store/[handle]/search/route';
import { parseRange } from '@/lib/analytics/range';
import { disconnectDatabases, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { addRedirect, listRedirects, parseRedirectInput, removeRedirect, resolveShopRedirect } from './shop-redirects';
import { LIVE_MAX_HITS_PER_MINUTE, LIVE_MAX_PAGES_PER_MINUTE, REDIRECT_LIMIT } from './shop-insights-rules';
import { loadLiveView, purgeLiveHitsTx, recordShopHit } from './shop-live';
import { salesReport, stockValueReport, taxReport } from './shop-reports';
import { searchShop, searchSuggestions } from './shop-search';
import { StoreError } from './store-settings';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
process.env.APP_URL ??= 'https://app.example.test';
const ORIGIN = new URL(process.env.APP_URL).origin;

type Staff = TenantContext & { userId: string };
const A = randomUUID(), B = randomUUID();
const owner = randomUUID(), admin = randomUUID(), agent = randomUUID(), viewer = randomUUID();
const asAdmin: Staff = { accountId: A, userId: admin, role: 'admin' };
const asAgent: Staff = { accountId: A, userId: agent, role: 'agent' };
const bAdmin: Staff = { accountId: B, userId: owner, role: 'admin' };
const ids = Object.fromEntries(['cat', 'rose', 'soap', 'draft', 'future', 'hidden', 'foreign', 'v1', 'v2', 'v3', 'v4', 'v5', 'vForeign', 'po1', 'po2', 'poForeign'].map((n) => [n, randomUUID()])) as Record<string, string>;
const handleA = `p8b7-${A.slice(0, 8)}`, handleB = `p8b7-${B.slice(0, 8)}`;
let db: pg.Client;
let ip = 0;

const q = async <T,>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.query(sql, values)).rows as T[];
const session = (accountId: string, userId: string, role: string) => { h.session = { accountId, userId, role }; };
const as = (who: 'owner' | 'admin' | 'agent' | 'viewer', accountId = A) => session(accountId, who === 'admin' ? admin : who === 'agent' ? agent : who === 'viewer' ? viewer : owner, who);
const call = async (handler: (r: Request) => Promise<Response>, url: string, init?: RequestInit) => {
  const res = await handler(new Request(`${ORIGIN}${url}`, init));
  return { status: res.status, res };
};
const json = async (r: Promise<{ status: number; res: Response }>) => { const { status, res } = await r; return { status, body: await res.json().catch(() => null) as Record<string, unknown> | null }; };
const beacon = (handle: string, path: unknown, over: { origin?: string | null } = {}) => beaconRoute(
  new Request(`${ORIGIN}/api/public/store/${handle}/live`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(over.origin === null ? {} : { origin: over.origin ?? ORIGIN }), 'x-forwarded-for': `198.51.100.${(ip++ % 250) + 1}` },
    body: JSON.stringify({ path }),
  }), { params: Promise.resolve({ handle }) });
const suggest = (handle: string, query: string) => searchRoute(
  new Request(`${ORIGIN}/api/public/store/${handle}/search?q=${encodeURIComponent(query)}`, { headers: { 'x-forwarded-for': `198.51.100.${(ip++ % 250) + 1}` } }), { params: Promise.resolve({ handle }) });
const liveRows = (account: string) => q<{ page: string; hits: number }>('SELECT page, hits FROM shop_live_hits WHERE account_id=$1 ORDER BY page', [account]);

async function paidOrder(over: { id?: string; account?: string; source: string; subtotal: number; refunded?: number; daysAgo: number; paid?: boolean; lines: Array<{ variant: string; qty: number; unit: number; rate: number; tax: number; name: string }> }) {
  const id = over.id ?? randomUUID();
  const account = over.account ?? A;
  const paid = over.paid ?? true;
  const total = over.subtotal + over.lines.reduce((n, l) => n + l.tax, 0);
  await db.query(`INSERT INTO orders(id,account_id,source,currency,subtotal_minor,total_minor,tax_minor,tax_inclusive,status,priced_at,paid_at,amount_paid_minor,amount_refunded_minor,payment_method,created_at)
    VALUES($1,$2,$3,'INR',$4::bigint,$5::bigint,$6::bigint,false,$7,now(),CASE WHEN $8::boolean THEN now() - make_interval(days => $9::int) END,CASE WHEN $8::boolean THEN $5::bigint ELSE 0 END,$10::bigint,'online',now())`,
  [id, account, over.source, over.subtotal, total, over.lines.reduce((n, l) => n + l.tax, 0), paid ? 'paid' : 'new', paid, over.daysAgo, over.refunded ?? 0]);
  for (const l of over.lines) {
    await db.query(`INSERT INTO order_items(account_id,order_id,variant_id,sku,name,quantity,unit_price_minor,currency,tax_rate_bps,tax_minor,discount_minor,line_total_minor)
      VALUES($1,$2,$3,'S',$4,$5,$6::bigint,'INR',$7,$8::bigint,0,$9::bigint)`, [account, id, l.variant, l.name, l.qty, l.unit, l.rate, l.tax, l.qty * l.unit + l.tax]);
  }
  return id;
}

async function document(over: { account?: string; kind: 'receipt' | 'credit_note'; number: string; tax: number; cgst: number; sgst: number; igst: number; subtotal: number; lines: unknown[] }) {
  await db.query(`INSERT INTO commerce_documents(account_id,kind,number,fy,currency,seller,buyer,line_items,subtotal_minor,tax_minor,cgst_minor,sgst_minor,igst_minor,total_minor,issued_at)
    VALUES($1,$2,$3,'2026-27','INR','{}'::jsonb,'{}'::jsonb,$4::jsonb,$5::bigint,$6::bigint,$7::bigint,$8::bigint,$9::bigint,$10::bigint,now())`,
  [over.account ?? A, over.kind, over.number, JSON.stringify(over.lines), over.subtotal, over.tax, over.cgst, over.sgst, over.igst, over.subtotal + over.tax]);
}

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('store phase 8 batch 7: shop insights on PostgreSQL', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    await q("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'P8B7', 'test-only-hash' FROM unnest($1::uuid[]) x", [[owner, admin, agent, viewer]]);
    await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'P8B7 shop',$3),($2,'P8B7 other',$3)", [A, B, owner]);
    await q("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic'),($2,'basic')", [A, B]);
    await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'agent'),($1,$5,'viewer'),($6,$2,'owner')", [A, owner, admin, agent, viewer, B]);
    await q("INSERT INTO commerce_settings(account_id,currency,default_tax_rate_bps,checkout_enabled,cod_enabled,cod_fee_minor) VALUES($1,'INR',500,true,false,0),($2,'INR',500,true,false,0)", [A, B]);
    await q("INSERT INTO shop_storefronts(account_id,handle,published,template) VALUES($1,$2,true,'wellness'),($3,$4,true,'wellness')", [A, handleA, B, handleB]);
    await q("INSERT INTO shop_categories(id,account_id,name) VALUES($1,$2,'Oils')", [ids.cat, A]);
    await q(`INSERT INTO shop_products(id,account_id,name,status,content_reviewed_at,category_id,publish_at,hide_at) VALUES
      ($1,$7,'Rose Oil','published',now(),$8,NULL,NULL), ($2,$7,'Soap Bar','published',now(),NULL,NULL,NULL), ($3,$7,'Draft Cream','draft',NULL,NULL,NULL,NULL),
      ($4,$7,'Future Balm','published',now(),NULL,now() + interval '2 days',NULL), ($5,$7,'Gone Salve','published',now(),NULL,now() - interval '3 days',now() - interval '1 day'),
      ($6,$9,'Rose Foreign','published',now(),NULL,NULL,NULL)`, [ids.rose, ids.soap, ids.draft, ids.future, ids.hidden, ids.foreign, A, ids.cat, B]);
    await q(`INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor,track_inventory) VALUES
      ($1,$7,$8,'ROSE-1',30000,true), ($2,$7,$9,'SOAP-1',40000,true), ($3,$7,$10,'DRAFT-1',1000,true), ($4,$7,$11,'FUT-1',1000,true), ($5,$7,$12,'GONE-1',1000,true), ($6,$13,$14,'ROSE-F',1000,true)`,
    [ids.v1, ids.v2, ids.v3, ids.v4, ids.v5, ids.vForeign, A, ids.rose, ids.soap, ids.draft, ids.future, ids.hidden, B, ids.foreign]);
    await q('INSERT INTO inventory_levels(account_id,variant_id,on_hand) VALUES($1,$2,10),($1,$3,5),($4,$5,7)', [A, ids.v1, ids.v2, B, ids.vForeign]);
    await q(`INSERT INTO purchase_orders(id,account_id,supplier_name,currency,status,ordered_at) VALUES($1,$3,'Old supplier','INR','received',now() - interval '30 days'),($2,$3,'New supplier','INR','received',now() - interval '5 days'),($4,$5,'Foreign','INR','received',now())`,
      [ids.po1, ids.po2, A, ids.poForeign, B]);
    await q(`INSERT INTO purchase_order_lines(account_id,purchase_order_id,variant_id,qty_ordered,qty_received,unit_cost_minor) VALUES($1,$2,$3,10,10,5000),($1,$4,$3,10,10,6000),($5,$6,$7,5,5,9000)`,
      [A, ids.po1, ids.v1, ids.po2, B, ids.poForeign, ids.vForeign]);

    // Sales: 100000 net of tax over two lines with 20000 refunded; a WhatsApp order; a manual order with a refund of one minor unit; an unpaid one; a foreign one.
    await paidOrder({ source: 'storefront', subtotal: 100000, refunded: 20000, daysAgo: 1, lines: [
      { variant: ids.v1, qty: 2, unit: 30000, rate: 500, tax: 3000, name: 'Rose Oil' }, { variant: ids.v2, qty: 1, unit: 40000, rate: 500, tax: 2000, name: 'Soap Bar' }] });
    await paidOrder({ source: 'whatsapp', subtotal: 10000, daysAgo: 2, lines: [{ variant: ids.v1, qty: 1, unit: 10000, rate: 500, tax: 500, name: 'Rose Oil' }] });
    await paidOrder({ source: 'manual', subtotal: 30000, refunded: 1, daysAgo: 1, lines: [
      { variant: ids.v1, qty: 1, unit: 10000, rate: 500, tax: 500, name: 'Rose Oil' }, { variant: ids.v2, qty: 1, unit: 10000, rate: 500, tax: 500, name: 'Soap Bar' },
      { variant: ids.v2, qty: 1, unit: 10000, rate: 500, tax: 500, name: 'Soap Bar' }] });
    await paidOrder({ source: 'storefront', subtotal: 99999, daysAgo: 1, paid: false, lines: [{ variant: ids.v1, qty: 1, unit: 99999, rate: 0, tax: 0, name: 'Rose Oil' }] });
    await paidOrder({ account: B, source: 'storefront', subtotal: 77777, daysAgo: 1, lines: [{ variant: ids.vForeign, qty: 1, unit: 77777, rate: 0, tax: 0, name: 'Rose Foreign' }] });

    // GST: one intra-state receipt with two rates, one inter-state receipt, one credit note, and a foreign receipt.
    await document({ kind: 'receipt', number: 'RCPT/2026-27/901', tax: 6600, cgst: 3300, sgst: 3300, igst: 0, subtotal: 80000, lines: [
      { tax_rate_bps: 500, tax_minor: 3000, line_total_minor: 63000 }, { tax_rate_bps: 1800, tax_minor: 3600, line_total_minor: 23600 }] });
    await document({ kind: 'receipt', number: 'RCPT/2026-27/902', tax: 501, cgst: 0, sgst: 0, igst: 501, subtotal: 10010, lines: [{ tax_rate_bps: 500, tax_minor: 501, line_total_minor: 10511 }] });
    await document({ kind: 'credit_note', number: 'RCPT/2026-27/903', tax: 500, cgst: 250, sgst: 250, igst: 0, subtotal: 8000, lines: [{ tax_rate_bps: null, tax_minor: 500, line_total_minor: 8500 }] });
    await document({ account: B, kind: 'receipt', number: 'RCPT/2026-27/904', tax: 9999, cgst: 0, sgst: 0, igst: 9999, subtotal: 100, lines: [{ tax_rate_bps: 1800, tax_minor: 9999, line_total_minor: 10099 }] });
  });

  beforeEach(async () => {
    await q('DELETE FROM shop_live_hits WHERE account_id = ANY($1::uuid[])', [[A, B]]);
    await q('DELETE FROM shop_redirects WHERE account_id = ANY($1::uuid[])', [[A, B]]);
    await q("UPDATE shop_storefronts SET access_mode='open' WHERE account_id = ANY($1::uuid[])", [[A, B]]);
  });

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[A, B]]);
      await db.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[owner, admin, agent, viewer]]);
      await db.end();
    }
    await disconnectDatabases();
  });

  // ------------------------------------------------------------------ reports
  describe('reports', () => {
    const range = () => parseRange({ preset: '30d' }, 'UTC');

    it('adds up sales by day, channel and product to the same net, with refunds spread to the minor unit', async () => {
      const r = await withTenant(asAdmin, (tx) => salesReport(tx, A, range()));
      const day = r.byDay.reduce((n, d) => n + d.netMinor, 0);
      expect(day).toBe(80000 + 10000 + 29999);
      expect(r.byDay).toHaveLength(2);
      expect(Object.fromEntries(r.byChannel.map((c) => [c.channel, c.netMinor]))).toEqual({ storefront: 80000, whatsapp: 10000, manual: 29999 });
      const gross = r.byProduct.reduce((n, p) => n + p.grossMinor, 0);
      const refunds = r.byProduct.reduce((n, p) => n + p.refundsMinor, 0);
      expect(gross).toBe(140000);
      expect(refunds).toBe(20001);
      expect(r.byProduct.reduce((n, p) => n + p.netMinor, 0)).toBe(day);
      const rose = r.byProduct.find((p) => p.name === 'Rose Oil')!;
      expect(rose.units).toBe(4);
      expect(r.byProduct.map((p) => p.name).sort()).toEqual(['Rose Oil', 'Soap Bar']);
      expect(r.productsTruncated).toBe(false);
    });

    it('leaves out unpaid orders and another workspace', async () => {
      const mine = await withTenant(asAdmin, (tx) => salesReport(tx, A, range()));
      expect(JSON.stringify(mine)).not.toMatch(/99999|77777|Foreign/);
      const theirs = await withTenant(bAdmin, (tx) => salesReport(tx, B, range()));
      expect(theirs.byChannel).toEqual([{ channel: 'storefront', currency: 'INR', orders: 1, netMinor: 77777 }]);
      // Asking for the other workspace's id under my own session still returns nothing of theirs (RLS).
      const crossed = await withTenant(asAdmin, (tx) => salesReport(tx, B, range()));
      expect(crossed.byChannel).toEqual([]);
      expect(crossed.byProduct).toEqual([]);
    });

    it('reports GST per month and rate from the issued documents, with credit notes apart', async () => {
      const t = await withTenant(asAdmin, (tx) => taxReport(tx, A, range()));
      const month = new Date().toISOString().slice(0, 7);
      expect(t.rates).toEqual([
        { month, currency: 'INR', rateBps: 500, taxableMinor: 70010, taxMinor: 3501, cgstMinor: 1500, sgstMinor: 1500, igstMinor: 501 },
        { month, currency: 'INR', rateBps: 1800, taxableMinor: 20000, taxMinor: 3600, cgstMinor: 1800, sgstMinor: 1800, igstMinor: 0 },
      ]);
      expect(t.months).toEqual([{ month, currency: 'INR', receipts: 2, taxMinor: 7101, cgstMinor: 3300, sgstMinor: 3300, igstMinor: 501,
        creditNotes: 1, creditTaxableMinor: 8000, creditTaxMinor: 500, creditCgstMinor: 250, creditSgstMinor: 250, creditIgstMinor: 0 }]);
      expect(JSON.stringify(t)).not.toContain('9999');
    });

    it('values stock at the newest purchase order cost and lists items without a cost apart', async () => {
      const s = await withTenant(asAdmin, (tx) => stockValueReport(tx, A));
      expect(s.totals).toEqual([{ currency: 'INR', units: 10, valueMinor: 60000 }]);
      expect(s.costed).toMatchObject([{ sku: 'ROSE-1', onHand: 10, unitCostMinor: 6000, valueMinor: 60000 }]);
      expect(s.noCost.map((r) => [r.sku, r.onHand])).toEqual([['SOAP-1', 5]]);
      expect(JSON.stringify(s)).not.toContain('ROSE-F');
    });

    it('serves reports to admins only, in the caller workspace', async () => {
      for (const route of [salesRoute, taxRoute, stockRoute]) {
        for (const role of ['viewer', 'agent'] as const) { as(role); expect((await call(route, '/api/analytics/x?preset=30d')).status).toBe(403); }
      }
      as('agent');
      expect((await call(taxCsvRoute, '/api/analytics/shop-tax/export?preset=30d')).status).toBe(403);
      as('admin');
      const sales = await json(call(salesRoute, '/api/analytics/shop-sales?preset=30d'));
      expect(sales.status).toBe(200);
      expect((sales.body!.sales as { byChannel: unknown[] }).byChannel).toHaveLength(3);
      session(B, owner, 'owner');
      const theirs = await json(call(salesRoute, '/api/analytics/shop-sales?preset=30d'));
      expect(JSON.stringify(theirs.body)).not.toContain('Rose Oil');
      expect((await json(call(salesRoute, '/api/analytics/shop-sales?preset=custom&from=2020-01-01&to=2020-02-01'))).status).toBe(200);
      expect((await json(call(salesRoute, '/api/analytics/shop-sales?preset=bogus'))).status).toBe(400);
    });

    it('downloads the GST CSV for admins with a spreadsheet-safe, attachment response', async () => {
      as('admin');
      const { status, res } = await call(taxCsvRoute, '/api/analytics/shop-tax/export?preset=30d');
      expect(status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/csv');
      expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="gst-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv"$/);
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
      expect(text.startsWith('﻿"section"')).toBe(true);
      expect(text).toContain('"receipt_totals"');
      expect(text).not.toContain('9999');
    });
  });

  // ------------------------------------------------------------------ live view
  describe('live view', () => {
    it('counts page views per fixed page key and shows them to the workspace admin only', async () => {
      expect((await beacon(handleA, '/')).status).toBe(200);
      expect((await beacon(handleA, '/')).status).toBe(200);
      expect((await beacon(handleA, `/p/${ids.rose}`)).status).toBe(200);
      expect((await beacon(handleA, '/p/anything-else')).status).toBe(200);
      expect(Object.fromEntries((await liveRows(A)).map((r) => [r.page, r.hits]))).toEqual({ home: 2, [`product:${ids.rose}`]: 1, other: 1 });
      const view = await loadLiveView(asAdmin);
      expect(view.pages.reduce((n, p) => n + p.hits, 0)).toBe(4);
      expect(view.labelled.find((p) => p.page === `product:${ids.rose}`)?.name).toBe('Rose Oil');
      expect(view.active).toBeGreaterThan(0);
      // Another workspace sees none of it, and its own hits stay its own.
      expect((await loadLiveView(bAdmin)).pages).toEqual([]);
      expect((await beacon(handleB, '/cart')).status).toBe(200);
      expect((await loadLiveView(bAdmin)).pages).toEqual([{ page: 'cart', hits: 1 }]);
      expect((await loadLiveView(asAdmin)).pages.some((p) => p.page === 'cart')).toBe(false);
    });

    it('keeps no identifier: the table has only workspace, minute, page and a count', async () => {
      const cols = await q<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name='shop_live_hits' ORDER BY column_name");
      expect(cols.map((c) => c.column_name)).toEqual(['account_id', 'hits', 'minute', 'page']);
    });

    it('is refused for agents (RLS and the route) and for another origin, unknown shops and bad bodies', async () => {
      await beacon(handleA, '/');
      expect((await withTenant(asAgent, (tx) => tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM shop_live_hits`))[0].n).toBe(0);
      expect((await withTenant(asAdmin, (tx) => tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM shop_live_hits`))[0].n).toBe(1);
      as('agent');
      expect((await call(liveRoute, '/api/commerce/insights/live')).status).toBe(403);
      as('admin');
      expect((await json(call(liveRoute, '/api/commerce/insights/live'))).status).toBe(200);
      const before = (await liveRows(A)).length;
      expect((await beacon(handleA, '/all', { origin: 'https://evil.example' })).status).toBeGreaterThanOrEqual(400);
      expect((await beacon(handleA, '/all', { origin: null })).status).toBeGreaterThanOrEqual(400);
      expect((await beacon('no-such-shop', '/')).status).toBe(404);
      expect((await liveRows(A)).length).toBe(before);
    });

    it('answers a locked shop with the plain 404 and counts nothing', async () => {
      await q("UPDATE shop_storefronts SET access_mode='coming_soon' WHERE account_id=$1", [A]);
      expect((await beacon(handleA, '/')).status).toBe(404);
      expect(await liveRows(A)).toEqual([]);
    });

    it('caps a flood: hits per minute and distinct pages per minute', async () => {
      await q("INSERT INTO shop_live_hits(account_id,minute,page,hits) VALUES($1,date_trunc('minute', now()),'other',$2)", [A, LIVE_MAX_HITS_PER_MINUTE]);
      expect(await recordShopHit(handleA, '/')).toBe(true);
      expect((await liveRows(A)).map((r) => r.page)).toEqual(['other']);
      await q('DELETE FROM shop_live_hits WHERE account_id=$1', [A]);

      await q(`INSERT INTO shop_live_hits(account_id,minute,page,hits) SELECT $1, date_trunc('minute', now()), 'page:s' || g, 1 FROM generate_series(1, $2) g`, [A, LIVE_MAX_PAGES_PER_MINUTE]);
      await recordShopHit(handleA, `/p/${ids.rose}`);
      await recordShopHit(handleA, `/p/${ids.soap}`);
      const rows = await liveRows(A);
      expect(rows.some((r) => r.page.startsWith('product:'))).toBe(false);
      expect(rows.find((r) => r.page === 'other')?.hits).toBe(2);
      expect(rows.length).toBe(LIVE_MAX_PAGES_PER_MINUTE + 1);
      // An existing page still counts.
      await recordShopHit(handleA, '/pages/s1');
      expect((await liveRows(A)).find((r) => r.page === 'page:s1')?.hits).toBe(2);
    });

    it('deletes counter rows older than two hours (beacon, report and purge)', async () => {
      await q("INSERT INTO shop_live_hits(account_id,minute,page,hits) VALUES($1,now() - interval '3 hours','home',4),($1,now() - interval '90 minutes','all',1)", [A]);
      await loadLiveView(asAdmin);
      expect((await liveRows(A)).map((r) => r.page)).toEqual(['all']);
      await q("INSERT INTO shop_live_hits(account_id,minute,page,hits) VALUES($1,now() - interval '5 hours','cart',1),($2,now() - interval '5 hours','cart',1)", [A, B]);
      const removed = await withTenant({ accountId: A, role: 'owner' }, (tx) => purgeLiveHitsTx(tx, A), getWorkerPrisma());
      expect(removed).toBe(1);
      // The other workspace's old row is untouched by this workspace's purge.
      expect((await liveRows(B)).map((r) => r.page)).toEqual(['cart']);
      await recordShopHit(handleB, '/');
      expect((await liveRows(B)).map((r) => r.page)).toEqual(['home']);
    });
  });

  // ------------------------------------------------------------------ search
  describe('search', () => {
    const names = async (handle: string, query: string) => ((await (await suggest(handle, query)).json()) as { suggestions: { name: string }[] }).suggestions.map((s) => s.name);

    it('matches name, SKU and category among visible products only', async () => {
      expect(await names(handleA, 'rose')).toEqual(['Rose Oil']);
      expect(await names(handleA, 'ROSE-1')).toEqual(['Rose Oil']);
      expect(await names(handleA, 'oils')).toEqual(['Rose Oil']);
      expect(await names(handleA, 'rose oils')).toEqual(['Rose Oil']);
      expect(await names(handleA, 'rose soap')).toEqual([]);
      // Draft, scheduled for later, past its hide date and another workspace's product never appear.
      for (const hidden of ['draft', 'future', 'gone', 'foreign', 'DRAFT-1', 'GONE-1']) expect(await names(handleA, hidden)).toEqual([]);
      expect(await names(handleB, 'rose')).toEqual(['Rose Foreign']);
    });

    it('treats wildcards and short input as plain text', async () => {
      expect(await names(handleA, '%%')).toEqual([]);
      expect(await names(handleA, '__')).toEqual([]);
      expect(await names(handleA, 'r')).toEqual([]);
      expect(await names(handleA, "'; DROP TABLE shop_products; --")).toEqual([]);
      expect((await q<{ n: string }>('SELECT count(*) AS n FROM shop_products WHERE account_id=$1', [A]))[0].n).toBe('5');
    });

    it('returns full product cards for the results page, and nothing for a locked or unknown shop', async () => {
      const page = await searchShop(handleA, 'soap');
      expect(page?.query).toBe('soap');
      expect(page?.products.map((p) => [p.name, p.variants[0].priceMinor])).toEqual([['Soap Bar', 40000]]);
      expect(await searchShop(handleA, '')).toMatchObject({ query: '', products: [], total: 0, next: null });
      await q("UPDATE shop_storefronts SET access_mode='coming_soon' WHERE account_id=$1", [A]);
      expect(await searchShop(handleA, 'soap')).toBeNull();
      expect(await searchSuggestions(handleA, 'soap')).toBeNull();
      expect((await suggest(handleA, 'soap')).status).toBe(404);
      expect(await searchShop('no-such-shop', 'soap')).toBeNull();
    });
  });

  // ------------------------------------------------------------------ redirects
  describe('redirects', () => {
    const add = (from: string, to: string, code: 301 | 302 = 301, who: Staff = asAdmin, handle = handleA) => addRedirect(who, parseRedirectInput({ from, to, code }, handle));

    it('adds, lists and removes rules for admins; agents read but cannot change; another workspace sees nothing', async () => {
      const rule = await add('/old-oil', `/p/${ids.rose}`);
      expect(rule).toMatchObject({ from: '/old-oil', to: `/p/${ids.rose}`, code: 301 });
      expect((await listRedirects(asAgent)).map((r) => r.from)).toEqual(['/old-oil']);
      expect(await listRedirects(bAdmin)).toEqual([]);
      await expect(add('/x', '/all', 301, asAgent)).rejects.toThrow();
      expect(await removeRedirect({ ...bAdmin }, rule.id)).toBe(false);
      expect(await removeRedirect({ ...asAgent }, rule.id)).toBe(false);
      expect((await listRedirects(asAdmin)).length).toBe(1);
      expect(await removeRedirect(asAdmin, rule.id)).toBe(true);
      expect(await listRedirects(asAdmin)).toEqual([]);
    });

    it('refuses duplicates, loops and off-shop paths', async () => {
      await add('/a', '/b');
      await add('/b', '/c', 302);
      const code = async (work: Promise<unknown>) => { try { await work; return null; } catch (e) { return e instanceof StoreError ? e.code : 'other'; } };
      expect(await code(add('/a', '/z'))).toBe('redirect_duplicate');
      expect(await code(add('/c', '/a'))).toBe('redirect_loop');
      expect(await code(add('/q', '/q'))).toBe('redirect_same');
      expect(await code(Promise.resolve().then(() => add('https://evil.example/x', '/all')))).toBe('redirect_invalid_from');
      expect(await code(Promise.resolve().then(() => add('/q', '//evil.example')))).toBe('redirect_invalid_to');
      expect((await listRedirects(asAdmin)).length).toBe(2);
      // Straight at the table (past the API): the database refuses a host or a protocol-relative address too.
      for (const [from, to] of [['/ok', 'https://evil.example'], ['/ok', '//evil.example'], ['https://evil.example', '/ok'], ['/a/../b', '/ok'], ['/ok?x=1', '/ok2']]) {
        await expect(db.query('INSERT INTO shop_redirects(account_id,from_path,to_path) VALUES($1,$2,$3)', [A, from, to])).rejects.toThrow(/check/i);
      }
    });

    it('serves the routes: admins write, agents read, bad paths are 400, a loop is 409, deletes need an id', async () => {
      as('agent');
      expect((await json(call(redirectsGet, '/api/commerce/redirects'))).status).toBe(200);
      expect((await json(call(redirectsPost, '/api/commerce/redirects', { method: 'POST', body: JSON.stringify({ from: '/a', to: '/b' }) }))).status).toBe(403);
      as('admin');
      const post = (body: unknown) => json(call(redirectsPost, '/api/commerce/redirects', { method: 'POST', body: JSON.stringify(body) }));
      const ok = await post({ from: '/s/' + handleA + '/old', to: '/all', code: 302 });
      expect(ok.status).toBe(200);
      expect((await post({ from: '/old', to: '/all' })).status).toBe(409);
      expect((await post({ from: 'https://evil.example', to: '/all' })).status).toBe(400);
      expect((await post({ from: '/n', to: '/all', code: 307 })).status).toBe(400);
      const id = ((ok.body as { redirect: { id: string } }).redirect).id;
      const del = (target: string) => redirectDelete(new Request(`${ORIGIN}/api/commerce/redirects/${target}`, { method: 'DELETE' }), { params: Promise.resolve({ id: target }) });
      as('agent');
      expect((await del(id)).status).toBe(403);
      session(B, owner, 'owner');
      expect((await del(id)).status).toBe(404);
      expect((await del('not-a-uuid')).status).toBe(404);
      as('admin');
      expect((await del(id)).status).toBe(200);
    });

    it('stops at 200 rules, in the code and in the database', async () => {
      await q(`INSERT INTO shop_redirects(account_id,from_path,to_path) SELECT $1, '/old' || g, '/new' || g FROM generate_series(1, $2) g`, [A, REDIRECT_LIMIT]);
      await expect(add('/one-more', '/all')).rejects.toMatchObject({ code: 'redirect_limit' });
      await expect(db.query("INSERT INTO shop_redirects(account_id,from_path,to_path) VALUES($1,'/one-more','/all')", [A])).rejects.toThrow(/redirect_limit/);
      expect((await q<{ n: string }>('SELECT count(*) AS n FROM shop_redirects WHERE account_id=$1', [A]))[0].n).toBe(String(REDIRECT_LIMIT));
    });

    it('resolves an old path to the end of its chain inside the same shop only', async () => {
      await add('/old-oil', '/mid', 302);
      await add('/mid', `/p/${ids.rose}`);
      await add('/home-old', '/');
      expect(await resolveShopRedirect(handleA, '/old-oil')).toEqual({ location: `/s/${handleA}/p/${ids.rose}`, permanent: false });
      expect(await resolveShopRedirect(handleA, '/mid')).toEqual({ location: `/s/${handleA}/p/${ids.rose}`, permanent: true });
      expect(await resolveShopRedirect(handleA, '/home-old')).toEqual({ location: `/s/${handleA}`, permanent: true });
      expect(await resolveShopRedirect(handleA, '/unknown')).toBeNull();
      expect(await resolveShopRedirect(handleA, 'https://evil.example')).toBeNull();
      // Another shop's rules are not mine, and a locked or unknown shop gives nothing away.
      expect(await resolveShopRedirect(handleB, '/old-oil')).toBeNull();
      expect(await resolveShopRedirect('no-such-shop', '/old-oil')).toBeNull();
      await q("UPDATE shop_storefronts SET access_mode='coming_soon' WHERE account_id=$1", [A]);
      expect(await resolveShopRedirect(handleA, '/old-oil')).toBeNull();
    });
  });
});
