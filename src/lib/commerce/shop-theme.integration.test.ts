import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Storage is not under test: a library object streams a few bytes.
vi.mock('@/lib/storage/server', async (original) => ({
  ...(await original<typeof import('@/lib/storage/server')>()),
  getMedia: vi.fn(async () => ({ object: { Body: { transformToWebStream: () => new Blob(['img']).stream() } }, contentType: 'image/png' })),
}));

import { disconnectDatabases, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { loadShopHome, loadShopPage } from '@/lib/commerce/public-shop';
import { parseShopSiteInput, saveShopSite } from '@/lib/commerce/shop-site';
import { getThemeEditor, parseDraftInput, parseThemeAction, runThemeAction, saveThemeDraft, THEME_VERSIONS_KEPT } from '@/lib/commerce/shop-theme';
import { GET as media } from '@/app/api/public/store/[handle]/media/[mediaId]/route';

// The theme editor (store plan Phase 2) on PostgreSQL: a saved draft never
// changes the live shop, publishing does and keeps a version, versions come
// back into the draft, draft versions guard against lost edits, writes are
// for admins only (RLS), and a section image becomes public only once it is
// published.
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
process.env.APP_URL ??= 'https://app.example.test';

const account = randomUUID(), other = randomUUID(), owner = randomUUID(), sectionImage = randomUUID(), contact = randomUUID();
const handle = `p2-${account.slice(0, 8)}`, otherHandle = `p2-${other.slice(0, 8)}`;
const admin = { accountId: account, userId: owner, role: 'admin' as const };
let db: pg.Client;

const doc = (overrides: Record<string, unknown> = {}) => ({
  template: 'beauty',
  theme: { colors: { primary: '#aa3355' } },
  sections: [
    { id: 'hero01', type: 'banner', settings: { heading: 'Glow season' } },
    { id: 'pic001', type: 'image_text', settings: { image: `media:${sectionImage}`, heading: 'Made by hand', text: 'Small batches.' } },
    { id: 'faq001', type: 'faq', items: [{ question: 'Do you ship?', answer: 'Yes, across India.' }] },
  ],
  menu: [{ label: 'Oils', link: '/all' }],
  footer: { text: 'Kumar family since 1990', contact: { phone: '+91 98000 00000', email: 'hello@example.com' } },
  pages: { about: { title: 'Our story', body: 'We started in Kerala.' } },
  policies: { refund: 'Opened bottles cannot be returned.' },
  ...overrides,
});
const mediaGet = (h: string, id: string) => media(new Request('https://app.example.test/x'), { params: Promise.resolve({ handle: h, mediaId: id }) });

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('shop theme editor on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const q = (sql: string, values: unknown[]) => db.query(sql, values);
    await q("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1::uuid,$2,'P2 owner','test-only-hash')", [owner, `${owner}@example.invalid`]);
    await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'P2 Beauty',$3),($2,'P2 other',$3)", [account, other, owner]);
    await q("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic'),($2,'basic')", [account, other]);
    await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$3,'owner'),($2,$3,'owner')", [account, other, owner]);
    await q("INSERT INTO profiles(user_id,full_name,email,account_id,account_role) VALUES($1,'P2 owner',$2,$3,'owner') ON CONFLICT DO NOTHING", [owner, `${owner}@example.invalid`, account]);
    await q(`INSERT INTO commerce_settings(account_id,currency,default_tax_rate_bps,checkout_enabled,cod_enabled,cod_fee_minor,return_window_days,legal_name,address)
      VALUES($1,'INR',1800,true,true,4900,10,'Kumar Beauty LLP','12 MG Road, Kochi'),($2,'INR',1800,true,false,0,7,NULL,NULL)`, [account, other]);
    await q("INSERT INTO shipping_rates(account_id,name,country,fee_minor,min_subtotal_minor) VALUES($1,'India','IN',0,99900)", [account]);
    await q(`INSERT INTO media_objects(id,account_id,uploaded_by,object_key,bucket,content_type,byte_size,original_name,in_library)
      VALUES($1,$2,$3,'p2/section.png','chat-media','image/png',10,'section.png',true)`, [sectionImage, account, owner]);
    await q("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'Private buyer','919811111111')", [contact, account, owner]);
    await q(`INSERT INTO shop_storefronts(account_id,handle,published,template) VALUES($1,$2,true,'wellness'),($3,$4,true,'fashion')`,
      [account, handle, other, otherHandle]);
  });

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[account, other]]);
      await db.query('DELETE FROM auth_users WHERE id=$1', [owner]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('keeps the live shop unchanged while the draft is saved, then publishes it with a version', async () => {
    const start = await getThemeEditor(admin);
    expect(start).toMatchObject({ ready: true, hasDraft: false, draftVersion: 0, versions: [] });
    expect(start.draft.sections.map((s) => s.type)).toEqual(['banner', 'categories', 'product_grid']);

    const saved = await saveThemeDraft(admin, parseDraftInput({ expectedDraftVersion: 0, document: doc() }));
    expect(saved).toMatchObject({ hasDraft: true, draftVersion: 1 });
    expect(saved.mediaUrls[sectionImage]).toContain('p2%2Fsection.png');
    // The public home still shows the Phase 1 layout and template.
    const before = await loadShopHome(handle);
    expect(before?.shop.theme.template).toBe('wellness');
    expect(before?.content.sections.map((s) => s.type)).toEqual(['banner', 'categories', 'product_grid']);
    expect((await mediaGet(handle, sectionImage)).status).toBe(404);

    const published = await runThemeAction(admin, parseThemeAction({ action: 'publish', expectedDraftVersion: 1 }));
    expect(published).toMatchObject({ hasDraft: false, draftVersion: 2, versions: [{ number: 1, publishedBy: 'P2 owner' }] });
    const after = await loadShopHome(handle);
    expect(after?.shop.theme).toMatchObject({ template: 'beauty', colors: { primary: '#aa3355' } });
    expect(after?.content.sections.map((s) => s.id)).toEqual(['hero01', 'pic001', 'faq001']);
    expect(after?.shop.menu).toEqual([{ label: 'Oils', link: '/all' }]);
    expect(after?.shop.pages).toEqual({ about: true, contact: true, faq: false });
    // The section image is public now, and only for this shop.
    expect((await mediaGet(handle, sectionImage)).status).toBe(200);
    expect((await mediaGet(otherHandle, sectionImage)).status).toBe(404);
    const audit = (await db.query("SELECT metadata FROM audit_logs WHERE account_id=$1 AND action='commerce.shop_theme_published'", [account])).rows;
    expect(audit).toEqual([{ metadata: { number: 1, sections: 3 } }]);
    // Publishing with nothing new is refused.
    await expect(runThemeAction(admin, parseThemeAction({ action: 'publish', expectedDraftVersion: 2 }))).rejects.toMatchObject({ code: 'no_draft' });
  });

  it('refuses a stale draft, an agent and the worker', async () => {
    const view = await getThemeEditor(admin);
    await expect(saveThemeDraft(admin, parseDraftInput({ expectedDraftVersion: view.draftVersion - 1, document: doc() })))
      .rejects.toMatchObject({ code: 'conflict' });
    const agent = { ...admin, role: 'agent' as const };
    expect((await getThemeEditor(agent)).versions).toHaveLength(1);
    await expect(saveThemeDraft(agent, parseDraftInput({ expectedDraftVersion: view.draftVersion, document: doc() }))).rejects.toThrow();
    await expect(runThemeAction(agent, parseThemeAction({ action: 'discard', expectedDraftVersion: view.draftVersion }))).rejects.toThrow();
    await expect(withTenant({ accountId: account, role: 'owner' }, (tx) =>
      tx.$executeRaw`UPDATE shop_storefronts SET draft='{}'::jsonb WHERE account_id=${account}::uuid`, getWorkerPrisma())).rejects.toThrow();
    await expect(withTenant({ accountId: account, role: 'owner' }, (tx) =>
      tx.$queryRaw`SELECT count(*) FROM shop_theme_versions`, getWorkerPrisma())).rejects.toThrow();
    // Another workspace sees none of this workspace's versions.
    expect((await getThemeEditor({ accountId: other, userId: owner, role: 'admin' })).versions).toEqual([]);
  });

  it('brings a version back into the draft and throws a draft away', async () => {
    let view = await getThemeEditor(admin);
    view = await saveThemeDraft(admin, parseDraftInput({ expectedDraftVersion: view.draftVersion, document: doc({ template: 'food', sections: [] }) }));
    view = await runThemeAction(admin, parseThemeAction({ action: 'publish', expectedDraftVersion: view.draftVersion }));
    expect(view.versions.map((v) => v.number)).toEqual([2, 1]);
    expect((await loadShopHome(handle))?.content.sections).toEqual([]);

    view = await runThemeAction(admin, parseThemeAction({ action: 'restore', number: 1, expectedDraftVersion: view.draftVersion }));
    expect(view).toMatchObject({ hasDraft: true, draft: { template: 'beauty' } });
    expect(view.draft.sections.map((s) => s.id)).toEqual(['hero01', 'pic001', 'faq001']);
    // The live shop waits for publish.
    expect((await loadShopHome(handle))?.shop.theme.template).toBe('food');
    view = await runThemeAction(admin, parseThemeAction({ action: 'discard', expectedDraftVersion: view.draftVersion }));
    expect(view).toMatchObject({ hasDraft: false, draft: { template: 'food', sections: [] } });
    await expect(runThemeAction(admin, parseThemeAction({ action: 'restore', number: 99, expectedDraftVersion: view.draftVersion })))
      .rejects.toMatchObject({ code: 'not_found' });
    expect(THEME_VERSIONS_KEPT).toBe(20);
  });

  it('validates the stored draft again before publishing it', async () => {
    const bad = doc({ sections: [{ id: 'evil01', type: 'text', settings: { heading: 'x' } }, { id: 'evil02', type: 'banner', settings: { buttonLink: 'javascript:alert(1)' } }] });
    await db.query('UPDATE shop_storefronts SET draft=$2::jsonb WHERE account_id=$1', [account, JSON.stringify(bad)]);
    const view = await getThemeEditor(admin);
    await expect(runThemeAction(admin, parseThemeAction({ action: 'publish', expectedDraftVersion: view.draftVersion })))
      .rejects.toMatchObject({ code: 'invalid', detail: { field: 'sections.1.settings.buttonLink' } });
    expect(() => parseDraftInput({ expectedDraftVersion: 0, document: bad })).toThrow();
    await runThemeAction(admin, parseThemeAction({ action: 'discard', expectedDraftVersion: view.draftVersion }));
  });

  it('writes the policy pages from store settings only', async () => {
    const page = await loadShopPage(handle);
    expect(page?.facts).toEqual({
      legalName: 'Kumar Beauty LLP', address: '12 MG Road, Kochi', currency: 'INR', returnWindowDays: 10,
      cod: { enabled: true, feeMinor: 4900 }, shippingRates: [{ name: 'India', country: 'IN', feeMinor: 0, minSubtotalMinor: 99900 }],
    });
    const text = JSON.stringify(page);
    for (const secret of ['Private buyer', '919811111111', contact]) expect(text).not.toContain(secret);
  });

  it('keeps the template when Online store settings are saved without one', async () => {
    const before = await withTenant(admin, (tx) => tx.$queryRaw<{ version: number; template: string }[]>`
      SELECT version, template FROM shop_storefronts WHERE account_id=${account}::uuid`);
    await saveShopSite(admin, parseShopSiteInput({ expectedVersion: before[0].version, handle, published: true,
      whatsappConfigId: null, whatsappPhone: null, otpTemplateId: null }));
    expect((await loadShopHome(handle))?.shop.theme.template).toBe(before[0].template);
  });
});
