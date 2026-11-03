import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { encrypt } from '@/lib/whatsapp/encryption';
import type { MetaCatalogProduct } from '@/lib/whatsapp/meta-api';
import { CatalogError, connectCatalog, deleteCatalog, listCatalogs, listProducts, requestCatalogSync } from './catalog';
import { syncCatalog, type CatalogPageFetcher } from './catalog-sync';
import { CommerceSendError, sendCommerceMessage } from './catalog-send';
import { UncertainDispatchError } from '@/lib/jobs/dispatch';

const meta = vi.hoisted(() => ({
  catalogs: vi.fn(async () => [{ id: '0', name: 'x' }]),
  settings: vi.fn(async () => {}),
  product: vi.fn(async () => ({ messageId: 'wamid.product' })),
  list: vi.fn(async () => ({ messageId: 'wamid.list' })),
  catalog: vi.fn(async () => ({ messageId: 'wamid.catalog' })),
}));
vi.mock('@/lib/whatsapp/meta-api', async (original) => ({
  ...(await original<typeof import('@/lib/whatsapp/meta-api')>()),
  getWabaCatalogs: meta.catalogs,
  setCommerceSettings: meta.settings,
  sendProductMessage: meta.product,
  sendProductListMessage: meta.list,
  sendCatalogMessage: meta.catalog,
}));

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const adminA = randomUUID(), agentA = randomUUID(), viewerA = randomUUID(), ownerB = randomUUID();
const asAdminA: TenantContext = { accountId: accountA, userId: adminA, role: 'admin' };
const asAgentA: TenantContext = { accountId: accountA, userId: agentA, role: 'agent' };
const asViewerA: TenantContext = { accountId: accountA, userId: viewerA, role: 'viewer' };
const asB: TenantContext = { accountId: accountB, userId: ownerB, role: 'owner' };
const seed = String(Date.now()).slice(-9);
const catalogMetaId = `8${seed}`;
let owner: pg.Client;
let numberA = '', numberA2 = '', conversationA = '', conversationA2 = '', staleConversation = '', catalogRow = '';

const product = (sku: string, extra: Partial<MetaCatalogProduct> = {}): MetaCatalogProduct =>
  ({ id: `5${seed}${sku.length}`, retailer_id: sku, name: `Item ${sku}`, price: '₹1,299.00', currency: 'INR', availability: 'in stock', ...extra });
const pages = (...list: MetaCatalogProduct[][]): CatalogPageFetcher => async ({ after }) => {
  const index = after ? Number(after) : 0;
  return { products: list[index] ?? [], after: index + 1 < list.length ? String(index + 1) : null };
};
const jobs = async (prefix: string) => (await owner.query('SELECT type,tenant_id,run_at,dedupe_key FROM jobs WHERE dedupe_key LIKE $1 ORDER BY run_at', [`${prefix}%`])).rows;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('WhatsApp catalogues on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Catalog test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[adminA, agentA, viewerA, ownerB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Catalog A',$2),($3,'Catalog B',$4)", [accountA, adminA, accountB, ownerB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'agent'),($1,$4,'viewer'),($5,$6,'owner')", [accountA, adminA, agentA, viewerA, accountB, ownerB]);
    const insertNumber = async (phone: string, isDefault: boolean) => (await owner.query(
      "INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,waba_id,access_token,status,is_default) VALUES($1,$2,$3,$4,$5,'connected',$6) RETURNING id",
      [accountA, adminA, phone, `82${seed}`, encrypt('test-only-token'), isDefault])).rows[0].id as string;
    numberA = await insertNumber(`81${seed}`, true);
    numberA2 = await insertNumber(`83${seed}`, false);
    const contact = (await owner.query("INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$3,'Asha') RETURNING id", [accountA, adminA, `9198${seed}`])).rows[0].id;
    // The 24-hour window is the customer's latest message in the conversation.
    const conversation = async (contactId: string, number: string, hoursAgo: number) => {
      const id = (await owner.query("INSERT INTO conversations(account_id,user_id,contact_id,whatsapp_config_id) VALUES($1,$2,$3,$4) RETURNING id",
        [accountA, adminA, contactId, number])).rows[0].id as string;
      await owner.query(`INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,message_id,status,created_at)
        VALUES($1,$2,'customer','text','hi',$3,'delivered',now()-make_interval(hours=>$4))`, [accountA, id, `wamid.in.${randomUUID()}`, hoursAgo]);
      return id;
    };
    conversationA = await conversation(contact, numberA, 0);
    conversationA2 = await conversation(contact, numberA2, 0);
    // A second contact whose window closed yesterday.
    const contact2 = (await owner.query("INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$3,'Ravi') RETURNING id", [accountA, adminA, `9197${seed}`])).rows[0].id;
    staleConversation = await conversation(contact2, numberA, 25);
  });
  beforeEach(() => {
    meta.catalogs.mockResolvedValue([{ id: catalogMetaId, name: 'Main shop' }]);
    for (const fn of [meta.settings, meta.product, meta.list, meta.catalog]) fn.mockClear();
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[adminA, agentA, viewerA, ownerB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('only admins can link a catalogue, and only one of the WABA', async () => {
    await expect(connectCatalog(asAgentA, { whatsappConfigId: numberA, catalogId: catalogMetaId, isCartEnabled: true, isCatalogVisible: true }))
      .rejects.toThrow();
    // Refused before Meta is touched.
    expect(meta.settings).not.toHaveBeenCalled();
    await expect(connectCatalog(asAdminA, { whatsappConfigId: numberA, catalogId: '999', isCartEnabled: true, isCatalogVisible: true }))
      .rejects.toMatchObject({ code: 'catalog_not_in_waba' });
    expect((await owner.query('SELECT count(*)::int AS n FROM whatsapp_catalogs WHERE account_id=$1', [accountA])).rows[0].n).toBe(0);
  });

  it('links a catalogue, applies the settings on Meta and queues the first sync in the same transaction', async () => {
    const linked = await connectCatalog(asAdminA, { whatsappConfigId: numberA, catalogId: catalogMetaId, isCartEnabled: false, isCatalogVisible: true });
    catalogRow = linked.id;
    expect(linked).toMatchObject({ catalog_id: catalogMetaId, name: 'Main shop', whatsapp_config_id: numberA, is_cart_enabled: false, product_count: 0 });
    expect(meta.settings).toHaveBeenCalledWith(expect.objectContaining({ phoneNumberId: `81${seed}`, isCartEnabled: false, isCatalogVisible: true, accessToken: 'test-only-token' }));
    expect(await jobs(`catalog-sync:${catalogRow}:m:`)).toEqual([expect.objectContaining({ type: 'commerce.catalog_sync', tenant_id: accountA })]);
    // The browser never sees a token.
    expect(JSON.stringify(linked)).not.toContain('test-only-token');
    // Members read it; other workspaces do not.
    expect((await withTenant(asViewerA, (tx) => listCatalogs(tx, accountA))).map((c) => c.id)).toEqual([catalogRow]);
    expect(await withTenant(asB, (tx) => listCatalogs(tx, accountB))).toEqual([]);
    // A number holds one catalogue.
    meta.catalogs.mockResolvedValueOnce([{ id: catalogMetaId, name: 'Main shop' }, { id: '777', name: 'Second' }]);
    await expect(connectCatalog(asAdminA, { whatsappConfigId: numberA, catalogId: '777', isCartEnabled: true, isCatalogVisible: true }))
      .rejects.toMatchObject({ code: 'number_has_catalog' });
  });

  it('syncs every page, queues the next six-hour run and hides products Meta dropped only after a full pass', async () => {
    const first = await syncCatalog({ accountId: accountA, catalogRowId: catalogRow,
      fetchPage: pages([product('A'), product('B', { price: '1.234,50 €' })], [product('C', { visibility: 'staging' })]) });
    expect(first).toEqual({ status: 'synced', upserted: 3, hidden: 0 });
    const rows = await withTenant(asViewerA, (tx) => listProducts(tx, accountA, { includeHidden: true }));
    expect(rows.total).toBe(3);
    expect(rows.products.find((p) => p.retailer_id === 'A')).toMatchObject({ price_minor: 129900, currency: 'INR', availability: 'in stock', is_hidden: false });
    expect(rows.products.find((p) => p.retailer_id === 'B')?.price_minor).toBeNull();
    expect(rows.products.find((p) => p.retailer_id === 'C')?.is_hidden).toBe(true);
    const periodic = await jobs(`catalog-sync:${catalogRow}:p:`);
    expect(periodic).toHaveLength(1);
    expect(new Date(periodic[0].run_at).getTime()).toBeGreaterThan(Date.now());

    // A failed pass hides nothing and records a fixed category.
    const failed = await syncCatalog({ accountId: accountA, catalogRowId: catalogRow, fetchPage: async ({ after }) => {
      if (after) throw new Error('timeout with secret detail');
      return { products: [product('A')], after: 'next' };
    } });
    expect(failed).toMatchObject({ status: 'error', error: 'unavailable' });
    const afterFailure = (await owner.query('SELECT sync_error FROM whatsapp_catalogs WHERE id=$1', [catalogRow])).rows[0];
    expect(afterFailure.sync_error).toBe('unavailable');
    expect((await withTenant(asViewerA, (tx) => listProducts(tx, accountA))).products.map((p) => p.retailer_id).sort()).toEqual(['A', 'B']);

    // A complete pass without B hides it and clears the error.
    await new Promise((r) => setTimeout(r, 5));
    const second = await syncCatalog({ accountId: accountA, catalogRowId: catalogRow, fetchPage: pages([product('A', { name: 'Renamed' })]) });
    expect(second).toEqual({ status: 'synced', upserted: 1, hidden: 1 });
    const visible = await withTenant(asViewerA, (tx) => listProducts(tx, accountA));
    expect(visible.products.map((p) => [p.retailer_id, p.name])).toEqual([['A', 'Renamed']]);
    expect((await owner.query('SELECT sync_error,last_synced_at FROM whatsapp_catalogs WHERE id=$1', [catalogRow])).rows[0])
      .toMatchObject({ sync_error: null, last_synced_at: expect.any(Date) });
  });

  it('filters products by search, availability and the conversation number, within the tenant', async () => {
    await syncCatalog({ accountId: accountA, catalogRowId: catalogRow,
      fetchPage: pages([product('A'), product('SHOE-50%', { name: 'Red shoe', availability: 'out of stock' })]) });
    const q = (query: Parameters<typeof listProducts>[2]) => withTenant(asViewerA, (tx) => listProducts(tx, accountA, query));
    expect((await q({ q: 'shoe' })).products.map((p) => p.retailer_id)).toEqual(['SHOE-50%']);
    expect((await q({ q: '50%' })).products.map((p) => p.retailer_id)).toEqual(['SHOE-50%']);
    expect((await q({ q: '%' })).total).toBe(1);
    expect((await q({ availability: 'out_of_stock' })).total).toBe(1);
    expect((await q({ availability: 'in_stock' })).products.map((p) => p.retailer_id)).toEqual(['A']);
    expect((await q({ conversationId: conversationA })).total).toBe(2);
    expect((await q({ conversationId: conversationA2 })).total).toBe(0);
    expect(await withTenant(asB, (tx) => listProducts(tx, accountB))).toEqual({ products: [], total: 0 });
    // Viewers and agents cannot change the mirror directly.
    await expect(withTenant(asAgentA, (tx) => tx.$executeRaw`UPDATE products SET name='x' WHERE account_id=${accountA}::uuid`)).resolves.toBe(0);
    await expect(requestCatalogSync(asViewerA, catalogRow)).rejects.toThrow();
  });

  it('sends a product list from the conversation number through one outbound intent, and records it once', async () => {
    const ids = (await withTenant(asAgentA, (tx) => listProducts(tx, accountA))).products.map((p) => p.id);
    const args = {
      accountId: accountA, userId: agentA, role: 'agent' as const, sender: 'agent' as const, conversationId: conversationA,
      intentKey: `commerce:inbox:${conversationA}:${randomUUID()}`,
      message: { kind: 'product_list' as const, header: 'New in', body: 'Pick one', sections: [{ title: '', products: ids.map((id) => ({ id })) }] },
    };
    const sent = await sendCommerceMessage(args);
    expect(sent.whatsappMessageId).toBe('wamid.list');
    expect(meta.list).toHaveBeenCalledTimes(1);
    expect(meta.list).toHaveBeenCalledWith(expect.objectContaining({ phoneNumberId: `81${seed}`, catalogId: catalogMetaId,
      sections: [{ title: '', productRetailerIds: ['A', 'SHOE-50%'] }] }));
    // A replay of the same request returns the stored result and never calls Meta again.
    expect((await sendCommerceMessage(args)).whatsappMessageId).toBe('wamid.list');
    expect(meta.list).toHaveBeenCalledTimes(1);
    const messages = (await owner.query("SELECT content_type,content_text,sender_type,sender_id FROM messages WHERE conversation_id=$1 AND message_id='wamid.list'", [conversationA])).rows;
    // The sending member is stamped for agent analytics.
    expect(messages).toEqual([{ content_type: 'interactive', sender_type: 'agent', sender_id: agentA, content_text: 'New in\nPick one\n[Item A, Red shoe]' }]);
    expect((await owner.query("SELECT status FROM outbound_intents WHERE idempotency_key=$1", [`${accountA}:${args.intentKey}`])).rows[0].status).toBe('accepted');
  });

  it('refuses before sending: closed window, number without catalogue, hidden product, unknown outcome', async () => {
    const base = { accountId: accountA, userId: agentA, role: 'agent' as const, sender: 'agent' as const };
    const hidden = (await owner.query("SELECT id FROM products WHERE account_id=$1 AND retailer_id='C'", [accountA])).rows[0].id;
    await expect(sendCommerceMessage({ ...base, conversationId: staleConversation, intentKey: randomUUID(),
      message: { kind: 'catalog', body: 'Shop' } })).rejects.toMatchObject({ code: 'window_closed' });
    await expect(sendCommerceMessage({ ...base, conversationId: conversationA2, intentKey: randomUUID(),
      message: { kind: 'catalog', body: 'Shop' } })).rejects.toMatchObject({ code: 'no_catalog' });
    await expect(sendCommerceMessage({ ...base, conversationId: conversationA, intentKey: randomUUID(),
      message: { kind: 'product', product: { id: hidden } } })).rejects.toBeInstanceOf(CommerceSendError);
    expect(meta.catalog).not.toHaveBeenCalled();
    expect(meta.product).not.toHaveBeenCalled();

    // A timeout leaves the intent unknown; the same key is never sent again.
    const key = `commerce:inbox:${conversationA}:${randomUUID()}`;
    meta.catalog.mockRejectedValueOnce(Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' }));
    const once = { ...base, conversationId: conversationA, intentKey: key, message: { kind: 'catalog' as const, body: 'Shop' } };
    await expect(sendCommerceMessage(once)).rejects.toBeInstanceOf(UncertainDispatchError);
    await expect(sendCommerceMessage(once)).rejects.toBeInstanceOf(UncertainDispatchError);
    expect(meta.catalog).toHaveBeenCalledTimes(1);
  });

  it('a disconnected number refuses sends and syncs, and unlinking ends the chain', async () => {
    await owner.query("UPDATE whatsapp_config SET status='disconnected',access_token='' WHERE id=$1", [numberA]);
    await expect(sendCommerceMessage({ accountId: accountA, userId: agentA, role: 'agent', sender: 'agent', conversationId: conversationA,
      intentKey: randomUUID(), message: { kind: 'catalog', body: 'Shop' } })).rejects.toMatchObject({ code: 'number_unavailable' });
    expect(await syncCatalog({ accountId: accountA, catalogRowId: catalogRow, fetchPage: pages([]) }))
      .toMatchObject({ status: 'error', error: 'number_unavailable' });
    await owner.query("UPDATE whatsapp_config SET status='connected',access_token=$2 WHERE id=$1", [numberA, encrypt('test-only-token')]);

    expect(await withTenant(asAgentA, (tx) => deleteCatalog(tx, accountA, catalogRow))).toBe(false);
    expect(await withTenant(asAdminA, (tx) => deleteCatalog(tx, accountA, catalogRow))).toBe(true);
    expect((await owner.query('SELECT count(*)::int AS n FROM products WHERE catalog_row_id=$1', [catalogRow])).rows[0].n).toBe(0);
    expect(await syncCatalog({ accountId: accountA, catalogRowId: catalogRow, fetchPage: pages([]) })).toEqual({ status: 'not_found' });
    await expect(requestCatalogSync(asAdminA, catalogRow)).rejects.toBeInstanceOf(CatalogError);
  });
  it('two concurrent connects of different catalogues to one number leave exactly one linked', async () => {
    const [first, second] = [`71${seed}`, `72${seed}`];
    // reset drops an unconsumed mockResolvedValueOnce left by an earlier refusal.
    meta.catalogs.mockReset().mockResolvedValue([{ id: first, name: 'First' }, { id: second, name: 'Second' }]);
    const results = await Promise.allSettled([first, second].map((catalogId) =>
      connectCatalog(asAdminA, { whatsappConfigId: numberA2, catalogId, isCartEnabled: true, isCatalogVisible: true })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(refused?.reason).toBeInstanceOf(CatalogError);
    expect(refused?.reason).toMatchObject({ code: 'number_has_catalog' });
    expect((await owner.query('SELECT count(*)::int AS n FROM whatsapp_catalogs WHERE account_id=$1 AND whatsapp_config_id=$2',
      [accountA, numberA2])).rows[0].n).toBe(1);
    // The database itself refuses a second catalogue on the number, whatever the caller checked.
    await expect(owner.query('INSERT INTO whatsapp_catalogs(account_id,whatsapp_config_id,catalog_id) VALUES($1,$2,$3)',
      [accountA, numberA2, `73${seed}`])).rejects.toMatchObject({ code: '23505' });
    // Unlinked catalogues are not counted, and re-linking the kept one to its own number still works.
    await owner.query('INSERT INTO whatsapp_catalogs(account_id,whatsapp_config_id,catalog_id) VALUES($1,NULL,$2),($1,NULL,$3)',
      [accountA, `74${seed}`, `75${seed}`]);
    const kept = results.find((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof connectCatalog>>> => r.status === 'fulfilled')!.value;
    await expect(connectCatalog(asAdminA, { whatsappConfigId: numberA2, catalogId: kept.catalog_id, isCartEnabled: false, isCatalogVisible: true }))
      .resolves.toMatchObject({ id: kept.id, is_cart_enabled: false });
  });
});
