import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Meta is stubbed; only the call counts matter here.
const meta = vi.hoisted(() => ({ text: 0, template: 0 }));
vi.mock('@/lib/whatsapp/meta-api', async (original) => ({
  ...(await original<typeof import('@/lib/whatsapp/meta-api')>()),
  sendTextMessage: vi.fn(async () => { meta.text += 1; return { messageId: `wamid.window.${crypto.randomUUID()}` }; }),
  sendTemplateMessage: vi.fn(async () => { meta.template += 1; return { messageId: `wamid.window.${crypto.randomUUID()}` }; }),
}));

import { createAdminClient } from '@/lib/data/admin';
import { disconnectDatabases, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { encrypt } from '@/lib/whatsapp/encryption';
import { sendMessageToConversation } from './send-message';

// The free-form send core behind /api/whatsapp/send and /api/v1/messages, against the real
// messages table. Local Docker database only (scripts/test-db-local.cjs); no .env file is loaded.
const ownerUrl = process.env.TEST_DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountId = randomUUID(), otherAccount = randomUUID(), userId = randomUUID(), otherUser = randomUUID();
let owner: pg.Client;
let phone = 0;
const db = () => createAdminClient({ accountId, role: 'owner' });

async function conversation(account = accountId, user = userId) {
  const contact = (await owner.query('INSERT INTO contacts(account_id,user_id,phone) VALUES($1,$2,$3) RETURNING id',
    [account, user, `1415556${String(phone++).padStart(4, '0')}`])).rows[0].id;
  return (await owner.query('INSERT INTO conversations(account_id,user_id,contact_id) VALUES($1,$2,$3) RETURNING id::text',
    [account, user, contact])).rows[0].id as string;
}
const customerMessage = (account: string, conversationId: string, at: Date) => withTenant({ accountId: account, role: 'owner' }, (tx) => tx.$executeRaw`
  INSERT INTO messages(conversation_id,sender_type,content_text,created_at) VALUES(${conversationId}::uuid,'customer','hello',${at})`, getWorkerPrisma());
const text = (conversationId: string) => sendMessageToConversation(db(), accountId, { conversationId, messageType: 'text', contentText: 'Thanks!' });
const botPaused = async (id: string) => (await owner.query('SELECT bot_paused FROM conversations WHERE id=$1', [id])).rows[0].bot_paused;

describe.skipIf(!ownerUrl || !workerUrl)('[WA-03] free-form sends need the 24-hour window on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getWorkerPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_worker') throw new Error('Requires constrained test worker credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Window test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[userId, otherUser]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Window A',$2),($3,'Window B',$4)", [accountId, userId, otherAccount, otherUser]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($3,$4,'owner')", [accountId, userId, otherAccount, otherUser]);
    await owner.query(`INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,access_token,status) VALUES($1,$2,$3,$4,'connected')`,
      [accountId, userId, `test-${accountId}`, encrypt('test-only-token')]);
  });
  beforeEach(() => { meta.text = 0; meta.template = 0; });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id = ANY($1::uuid[])', [[accountId, otherAccount]]);
      await owner.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[accountId, otherAccount]]);
      await owner.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[userId, otherUser]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('refuses text with 409 window_closed when the customer never wrote, without pausing the bot or calling Meta', async () => {
    const id = await conversation();
    await expect(text(id)).rejects.toMatchObject({ code: 'window_closed', status: 409 });
    expect(meta.text).toBe(0);
    expect(await botPaused(id)).toBe(false);
    expect((await owner.query("SELECT count(*)::int AS n FROM messages WHERE conversation_id=$1 AND sender_type<>'customer'", [id])).rows[0].n).toBe(0);
  });

  it('refuses text 25 hours after the last customer message and sends it 23 hours after', async () => {
    const late = await conversation();
    await customerMessage(accountId, late, new Date(Date.now() - 25 * 3_600_000));
    await expect(text(late)).rejects.toMatchObject({ code: 'window_closed' });
    const open = await conversation();
    await customerMessage(accountId, open, new Date(Date.now() - 23 * 3_600_000));
    await expect(text(open)).resolves.toMatchObject({ messageId: expect.any(String) });
    expect(meta.text).toBe(1);
  });

  it('a business message does not open the window', async () => {
    const id = await conversation();
    await customerMessage(accountId, id, new Date(Date.now() - 30 * 3_600_000));
    await withTenant({ accountId, role: 'owner' }, (tx) => tx.$executeRaw`INSERT INTO messages(conversation_id,sender_type,content_text)
      VALUES(${id}::uuid,'bot','reminder')`, getWorkerPrisma());
    await expect(text(id)).rejects.toMatchObject({ code: 'window_closed' });
  });

  it('still sends an approved template outside the window', async () => {
    const id = await conversation();
    await sendMessageToConversation(db(), accountId, { conversationId: id, messageType: 'template', templateName: 'promo' });
    expect(meta.template).toBe(1);
  });
});
