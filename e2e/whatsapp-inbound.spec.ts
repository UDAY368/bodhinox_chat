import { randomBytes, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { login } from './fixtures';
import {
  drainWhatsAppReceipts, eventually, metaSignature, removeWorkspaces, seedWorkspace, whatsappDelivery, withDb, type Workspace,
} from './journeys';

// Inbound WhatsApp through the real webhook route: a signed delivery is stored
// and queued before the 200, the queued job is run by the in-spec drain (there
// is no worker in end-to-end runs), and the message appears in the inbox.
// Outbound sends are not exercised here (no provider mock; covered by contract
// tests): replies would call graph.facebook.com.
const run = randomBytes(4).toString('hex');
const phoneNumberId = `5550${String(Date.now()).slice(-9)}${parseInt(run, 16) % 1000}`;
const waId = `9198${String(Date.now()).slice(-8)}`;
const profileName = `E2E WhatsApp ${run}`;
let workspace: Workspace;

const inbound = (text: string, id = `wamid.E2E-IN-${randomUUID()}`) => whatsappDelivery(phoneNumberId, {
  contacts: [{ profile: { name: profileName }, wa_id: waId }],
  messages: [{ from: waId, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
});
const status = (messageId: string, value: 'delivered' | 'read', at: number) => whatsappDelivery(phoneNumberId, {
  statuses: [{ id: messageId, status: value, timestamp: String(at), recipient_id: waId }],
});

test.describe('[INB-01] [WA-01] inbound WhatsApp journey', () => {
  test.beforeAll(async () => {
    workspace = await seedWorkspace('whatsapp');
    // Imported only now: the module reads ENCRYPTION_KEY when it loads, and testDatabase loaded the test env above.
    const { encrypt } = await import('../src/lib/whatsapp/encryption');
    await withDb((db) => db.query(`INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,access_token,status)
      VALUES($1,$2,$3,$4,'connected')`, [workspace.accountId, workspace.owner.id, phoneNumberId, encrypt('e2e-only-token')]));
  });
  test.afterAll(async () => {
    await withDb((db) => db.query("DELETE FROM webhook_receipts WHERE provider='meta' AND payload::text LIKE $1", [`%${phoneNumberId}%`]));
    await removeWorkspaces([workspace.accountId], [workspace.owner.id]);
  });

  test('an unsigned or wrongly signed delivery is refused and stores nothing', async ({ request }) => {
    const raw = inbound('should never be stored');
    for (const headers of [{}, { 'x-hub-signature-256': metaSignature(raw, 'not-the-app-secret') }] as Record<string, string>[]) {
      const response = await request.post('/api/whatsapp/webhook', { data: raw, headers: { 'content-type': 'application/json', ...headers } });
      expect(response.status()).toBe(401);
    }
    const stored = await withDb(async (db) => (await db.query("SELECT count(*)::int AS n FROM webhook_receipts WHERE payload::text LIKE '%should never be stored%'")).rows[0].n);
    expect(stored).toBe(0);
  });

  test('a signed text is stored once, appears in the inbox, and status ticks only move forward', async ({ page, request }) => {
    const text = `Hi, is the clinic open today? ${run}`;
    const raw = inbound(text);
    const post = (body: string) => request.post('/api/whatsapp/webhook', {
      data: body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': metaSignature(body) },
    });
    const first = await post(raw);
    expect(first.status()).toBe(200);
    const { receipt_id: receiptId } = await first.json() as { receipt_id: string };
    // Meta redelivers the same body: same receipt, same job.
    const again = await post(raw);
    expect((await again.json() as { receipt_id: string }).receipt_id).toBe(receiptId);
    // Queued before the acknowledgment.
    const queued = await withDb(async (db) => (await db.query("SELECT status FROM jobs WHERE dedupe_key=$1 AND type='whatsapp.webhook'", [`webhook:${receiptId}`])).rows);
    expect(queued).toEqual([{ status: 'pending' }]);

    drainWhatsAppReceipts([receiptId]);
    const stored = await eventually(() => withDb(async (db) => (await db.query(
      `SELECT m.conversation_id::text AS conversation_id, c.name FROM messages m JOIN conversations v ON v.id=m.conversation_id JOIN contacts c ON c.id=v.contact_id
       WHERE m.account_id=$1 AND m.sender_type='customer' AND m.content_text=$2`, [workspace.accountId, text])).rows));
    expect(stored).toHaveLength(1);
    expect(stored[0].name).toBe(profileName);
    expect(await withDb(async (db) => (await db.query('SELECT status FROM webhook_receipts WHERE id=$1', [receiptId])).rows[0].status)).toBe('processed');

    await login(page, workspace.owner);
    await page.goto(`/inbox?c=${stored[0].conversation_id}`);
    await expect(page.getByText(text).first()).toBeVisible();

    // An outbound message (as if a reply had been accepted by Meta) gets its ticks from signed status webhooks.
    const outbound = `wamid.E2E-OUT-${run}`;
    await withDb((db) => db.query("INSERT INTO messages(account_id,conversation_id,sender_type,content_text,message_id,status) VALUES($1,$2,'bot','On it',$3,'sent')",
      [workspace.accountId, stored[0].conversation_id, outbound]));
    const now = Math.floor(Date.now() / 1000);
    const receipts: string[] = [];
    // Read arrives before delivered (Meta does not guarantee order): the tick must not go back.
    for (const body of [status(outbound, 'read', now + 2), status(outbound, 'delivered', now + 1)]) {
      const response = await post(body);
      expect(response.status()).toBe(200);
      receipts.push((await response.json() as { receipt_id: string }).receipt_id);
    }
    drainWhatsAppReceipts(receipts);
    const tick = await withDb(async (db) => (await db.query('SELECT status FROM messages WHERE account_id=$1 AND message_id=$2', [workspace.accountId, outbound])).rows[0].status);
    expect(tick).toBe('read');
  });
});
