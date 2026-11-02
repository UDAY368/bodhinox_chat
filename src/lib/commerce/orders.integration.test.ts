import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { encrypt } from '@/lib/whatsapp/encryption';
import { ingestInboundMessage, type IngestInboundInput } from '@/lib/whatsapp/ingest';
import { UncertainDispatchError } from '@/lib/jobs/dispatch';
import { parseInboundOrder, type OrderMessagePayload } from './order-format';
import { getOrder, getOrderSettings, listOrders, saveOrderSettings, updateOrder, DEFAULT_ORDER_SETTINGS } from './orders';
import { sendOrderConfirmation } from './order-confirmation';

const meta = vi.hoisted(() => ({
  text: vi.fn<(args: unknown) => Promise<{ whatsapp_message_id: string }>>(async () => ({ whatsapp_message_id: 'wamid.confirm' })),
  template: vi.fn<(args: unknown) => Promise<{ whatsapp_message_id: string }>>(async () => ({ whatsapp_message_id: 'wamid.confirm-template' })),
}));
vi.mock('@/lib/automations/meta-send', () => ({ engineSendText: meta.text, engineSendTemplate: meta.template }));
const webhooks = vi.hoisted(() => ({ dispatch: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}) }));
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: webhooks.dispatch }));

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
let owner: pg.Client;
let configA = '';
let contactA = '';
let conversationA = '';

const cart = parseInboundOrder({
  catalog_id: `9${seed}`, text: 'Please gift wrap',
  product_items: [
    { product_retailer_id: 'SHIRT-1', quantity: 2, item_price: 499.5, currency: 'INR' },
    { product_retailer_id: 'CAP-9', quantity: '1', item_price: '100', currency: 'INR' },
  ],
})!;

const inbound = (metaMessageId: string): IngestInboundInput => ({
  accountId: accountA, userId: adminA, contactId: contactA, conversationId: conversationA, metaMessageId,
  contentType: 'interactive', contentText: '[Order]', mediaUrl: null, mediaType: null, interactiveReplyId: null,
  replyToMessageId: null, createdAt: new Date(), wasContactCreated: false, wasConversationCreated: false,
  whatsappConfigId: configA, order: cart,
});

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('orders on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Orders test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[adminA, agentA, viewerA, ownerB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Orders A',$2),($3,'Orders B',$4)", [accountA, adminA, accountB, ownerB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'agent'),($1,$4,'viewer'),($5,$6,'owner')", [accountA, adminA, agentA, viewerA, accountB, ownerB]);
    configA = (await owner.query(
      "INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,waba_id,access_token,status) VALUES($1,$2,$3,$4,$5,'connected') RETURNING id",
      [accountA, adminA, `71${seed}`, `72${seed}`, encrypt('test-only-token')],
    )).rows[0].id;
    contactA = (await owner.query("INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$3,'Asha') RETURNING id", [accountA, adminA, `9197${seed}`])).rows[0].id;
    conversationA = (await owner.query("INSERT INTO conversations(account_id,user_id,contact_id,whatsapp_config_id) VALUES($1,$2,$3,$4) RETURNING id", [accountA, adminA, contactA, configA])).rows[0].id;
    const catalog = (await owner.query("INSERT INTO whatsapp_catalogs(account_id,whatsapp_config_id,catalog_id,name) VALUES($1,$2,$3,'Shop') RETURNING id", [accountA, configA, `9${seed}`])).rows[0].id;
    await owner.query("INSERT INTO products(account_id,catalog_row_id,retailer_id,name,price_minor,currency) VALUES($1,$2,'SHIRT-1','Blue shirt',49950,'INR')", [accountA, catalog]);
    // The same retailer id in another workspace must never lend its name.
    const catalogB = (await owner.query("INSERT INTO whatsapp_catalogs(account_id,catalog_id,name) VALUES($1,$2,'Other') RETURNING id", [accountB, `9${seed}`])).rows[0].id;
    await owner.query("INSERT INTO products(account_id,catalog_row_id,retailer_id,name) VALUES($1,$2,'CAP-9','Other tenant cap')", [accountB, catalogB]);
  });
  beforeEach(() => {
    meta.text.mockClear();
    meta.template.mockClear();
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

  let orderId = '';

  it('stores a cart once with its message, even when the webhook is redelivered', async () => {
    const wamid = `wamid.order.${seed}`;
    webhooks.dispatch.mockClear();
    const first = await ingestInboundMessage(inbound(wamid));
    const again = await ingestInboundMessage(inbound(wamid));
    expect(first.inserted).toBe(true);
    expect(again).toMatchObject({ messageId: first.messageId, inserted: false });

    const orders = (await owner.query('SELECT * FROM orders WHERE account_id=$1 AND message_id=$2', [accountA, wamid])).rows;
    expect(orders).toHaveLength(1);
    orderId = orders[0].id;
    expect(orders[0]).toMatchObject({ source: 'whatsapp', status: 'new', currency: 'INR', subtotal_minor: '109900', total_minor: '109900',
      contact_id: contactA, conversation_id: conversationA, whatsapp_config_id: configA, customer_note: 'Please gift wrap' });
    const items = (await owner.query('SELECT retailer_id,name,quantity,unit_price_minor FROM order_items WHERE order_id=$1 ORDER BY retailer_id DESC', [orderId])).rows;
    expect(items).toEqual([
      { retailer_id: 'SHIRT-1', name: 'Blue shirt', quantity: 2, unit_price_minor: '49950' },
      { retailer_id: 'CAP-9', name: null, quantity: 1, unit_price_minor: '10000' },
    ]);

    const message = (await owner.query('SELECT content_type,content_text,interactive_payload FROM messages WHERE id=$1', [first.messageId])).rows[0];
    expect(message.content_type).toBe('interactive');
    expect(message.content_text).toBe('[Order] 2 × Blue shirt, 1 × CAP-9 — ₹1,099.00');
    expect((message.interactive_payload.order as OrderMessagePayload).order_id).toBe(orderId);
    expect((await owner.query('SELECT count(*)::int AS n FROM jobs WHERE dedupe_key=$1', [`inbound:${first.messageId}`])).rows[0].n).toBe(1);

    // order.created goes out once, after the commit, for the delivery that created the order; the redelivery adds none.
    const created = webhooks.dispatch.mock.calls.filter((call) => call[2] === 'order.created');
    expect(created).toHaveLength(1);
    expect(created[0][1]).toBe(accountA);
    expect(created[0][3]).toMatchObject({ order_id: orderId, source: 'whatsapp_cart', status: 'new', total_minor: 109900,
      currency: 'INR', item_count: 3, contact_id: contactA, conversation_id: conversationA });
    // No customer content (note, item names) in the payload.
    expect(JSON.stringify(created[0][3])).not.toMatch(/gift wrap|Blue shirt/);
  });

  it('shows orders to agents only, within the workspace', async () => {
    const page = await listOrders(asAgentA);
    expect(page.orders.map((o) => o.id)).toEqual([orderId]);
    expect(page.orders[0]).toMatchObject({ item_count: 3, subtotal_minor: 109900, contact: { id: contactA, name: 'Asha' } });
    expect((await listOrders(asAgentA, { q: 'ash' })).orders).toHaveLength(1);
    expect((await listOrders(asAgentA, { status: 'paid' })).orders).toHaveLength(0);
    expect((await listOrders(asViewerA)).orders).toHaveLength(0);
    expect((await listOrders(asB)).orders).toHaveLength(0);
    await expect(getOrder(asB, orderId)).rejects.toMatchObject({ status: 404 });
    const detail = await getOrder(asAgentA, orderId);
    expect(detail.items.map((i) => i.unit_price_minor).sort()).toEqual([10000, 49950]);
  });

  it('lets agents move status along allowed transitions and keep a note, but never change amounts', async () => {
    const confirmed = await updateOrder(asAgentA, orderId, { status: 'confirmed', note: 'Ships Monday' });
    expect(confirmed).toMatchObject({ status: 'confirmed', note: 'Ships Monday' });
    await expect(updateOrder(asAgentA, orderId, { status: 'new' })).rejects.toMatchObject({ status: 409, code: 'bad_transition' });
    await expect(updateOrder(asViewerA, orderId, { status: 'paid' })).rejects.toMatchObject({ status: 404 });
    await expect(updateOrder(asB, orderId, { status: 'paid' })).rejects.toMatchObject({ status: 404 });
    await expect(withTenant(asAgentA, (tx) => tx.$executeRaw`UPDATE orders SET subtotal_minor=1 WHERE id=${orderId}::uuid`))
      .rejects.toThrow(/permission denied/i);
    await expect(withTenant(asAgentA, (tx) => tx.$executeRaw`INSERT INTO orders(source,currency,subtotal_minor) VALUES('manual','INR',1)`))
      .rejects.toThrow(/permission denied|row-level security/i);
    expect((await owner.query('SELECT status,subtotal_minor FROM orders WHERE id=$1', [orderId])).rows[0]).toEqual({ status: 'confirmed', subtotal_minor: '109900' });
  });

  it('lets admins change the confirmation setting, agents read it, and nobody else', async () => {
    expect(await getOrderSettings(asAgentA)).toEqual(DEFAULT_ORDER_SETTINGS);
    await expect(saveOrderSettings(asAgentA, { ...DEFAULT_ORDER_SETTINGS, confirmation_mode: 'text', confirmation_text: 'x' }))
      .rejects.toThrow(/row-level security/i);
    const saved = await saveOrderSettings(asAdminA, { ...DEFAULT_ORDER_SETTINGS, confirmation_mode: 'text', confirmation_text: 'Thanks {{customer_name}}! {{order_items}} — {{order_total}}' });
    expect(saved.confirmation_mode).toBe('text');
    expect(await getOrderSettings(asViewerA)).toEqual(DEFAULT_ORDER_SETTINGS);
    expect(await getOrderSettings(asB)).toEqual(DEFAULT_ORDER_SETTINGS);
  });

  it('sends the confirmation once per order through an outbound intent', async () => {
    const message = (await owner.query('SELECT interactive_payload FROM messages WHERE message_id=$1', [`wamid.order.${seed}`])).rows[0];
    const order = message.interactive_payload.order as OrderMessagePayload;
    const input = { accountId: accountA, userId: adminA, conversationId: conversationA, contactId: contactA, order };
    expect(await sendOrderConfirmation(input)).toBe('sent');
    expect(meta.text).toHaveBeenCalledTimes(1);
    expect(meta.text.mock.calls[0][0]).toMatchObject({ conversationId: conversationA, text: 'Thanks Asha! 2 × Blue shirt, 1 × CAP-9 — ₹1,099.00' });
    expect(await sendOrderConfirmation(input)).toBe('sent');
    expect(meta.text).toHaveBeenCalledTimes(1);
    const intent = (await owner.query('SELECT status FROM outbound_intents WHERE account_id=$1 AND idempotency_key=$2', [accountA, `${accountA}:order_confirm:${order.order_id}`])).rows;
    expect(intent).toEqual([{ status: 'accepted' }]);
  });

  it('never resends after an ambiguous outcome', async () => {
    const other = { ...cart, items: cart.items.slice(0, 1) };
    const result = await ingestInboundMessage({ ...inbound(`wamid.order2.${seed}`), order: other });
    const order = (await owner.query('SELECT interactive_payload FROM messages WHERE id=$1', [result.messageId])).rows[0].interactive_payload.order;
    meta.text.mockRejectedValueOnce(new Error('socket hang up'));
    const input = { accountId: accountA, userId: adminA, conversationId: conversationA, contactId: contactA, order };
    await expect(sendOrderConfirmation(input)).rejects.toBeInstanceOf(UncertainDispatchError);
    await expect(sendOrderConfirmation(input)).rejects.toBeInstanceOf(UncertainDispatchError);
    expect(meta.text).toHaveBeenCalledTimes(1);
  });

  it('skips the confirmation when the bot is paused, the number is disconnected or the setting is off', async () => {
    const result = await ingestInboundMessage({ ...inbound(`wamid.order3.${seed}`) });
    const order = (await owner.query('SELECT interactive_payload FROM messages WHERE id=$1', [result.messageId])).rows[0].interactive_payload.order;
    const input = { accountId: accountA, userId: adminA, conversationId: conversationA, contactId: contactA, order };
    await owner.query('UPDATE conversations SET bot_paused=true WHERE id=$1', [conversationA]);
    expect(await sendOrderConfirmation(input)).toBe('bot_paused');
    await owner.query('UPDATE conversations SET bot_paused=false WHERE id=$1', [conversationA]);
    const token = (await owner.query('SELECT access_token FROM whatsapp_config WHERE id=$1', [configA])).rows[0].access_token;
    await owner.query("UPDATE whatsapp_config SET status='disconnected',access_token='' WHERE id=$1", [configA]);
    expect(await sendOrderConfirmation(input)).toBe('number_unavailable');
    await owner.query("UPDATE whatsapp_config SET status='connected',access_token=$2 WHERE id=$1", [configA, token]);
    await saveOrderSettings(asAdminA, DEFAULT_ORDER_SETTINGS);
    expect(await sendOrderConfirmation(input)).toBe('off');
    expect(meta.text).not.toHaveBeenCalled();
  });
  it('pages through orders created in the same millisecond without skipping or repeating any', async () => {
    // Microsecond-distinct stamps inside one millisecond, a tie on created_at, and one older row.
    const stamps = ['2020-01-01T10:00:00.123999Z', '2020-01-01T10:00:00.123456Z', '2020-01-01T10:00:00.123200Z',
      '2020-01-01T10:00:00.123200Z', '2020-01-01T10:00:00.122000Z'];
    const inserted = (await owner.query(
      `INSERT INTO orders(account_id,source,currency,subtotal_minor,created_at)
       SELECT $1,'manual','INR',100,s::timestamptz FROM unnest($2::text[]) s RETURNING id::text AS id, created_at`,
      [accountB, stamps])).rows as { id: string; created_at: Date }[];
    const expected = (await owner.query('SELECT id::text AS id FROM orders WHERE account_id=$1 ORDER BY created_at DESC, id DESC', [accountB]))
      .rows.map((r: { id: string }) => r.id);
    expect(expected).toHaveLength(inserted.length);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await listOrders(asB, { limit: 1, ...(cursor ? { cursor } : {}) });
      seen.push(...page.orders.map((o) => o.id));
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }
    expect(seen).toEqual(expected);
    // A malformed or foreign cursor is a 400, never a SQL error.
    await expect(listOrders(asB, { cursor: "1_x'; --" })).rejects.toMatchObject({ status: 400 });
  });
});
