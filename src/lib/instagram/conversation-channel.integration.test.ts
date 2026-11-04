// Phase 11 T1 on a real PostgreSQL: the conversation channel model (trigger,
// sender CHECK, per-channel unique keys, tenancy of the new tables) and the
// WhatsApp regression guard for a contact that has both a WhatsApp and an
// Instagram conversation (what a staff link produces).
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { createAdminClient } from '@/lib/data/admin';
import { encrypt } from '@/lib/whatsapp/encryption';
import { processWebhook } from '@/lib/whatsapp/process-webhook';
import { sendMessageToConversation } from '@/lib/whatsapp/send-message';
import { loadConversationSenderConfig } from '@/lib/whatsapp/sender-config';
import { pickContactConversationId } from '@/lib/whatsapp/contact-conversation';
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';
import { loadInstagramTarget } from '@/lib/channels/sender';
import { sendCommerceMessage } from '@/lib/commerce/catalog-send';
import { sendStorefrontText } from '@/lib/commerce/storefront';
import { sendForm } from '@/lib/whatsapp/forms/send';
import { handleHoldReplyJob } from '@/lib/appointments/notify-customer';

const webhook = vi.hoisted(() => ({ dispatch: vi.fn(async () => {}) }));
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: webhook.dispatch }));

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID(), accountC = randomUUID();
const ownerA = randomUUID(), ownerB = randomUUID(), ownerC = randomUUID();
const asA: TenantContext = { accountId: accountA, userId: ownerA, role: 'owner' };
const seed = String(Date.now()).slice(-9);
const phoneNumberIdA = `74${seed}`;
let owner: pg.Client;
let configA = '', igA1 = '', igA2 = '', igB = '', igC1 = '', igC2 = '';

async function addInstagramAccount(accountId: string, userId: string, igUserId: string): Promise<string> {
  return (await owner.query(
    `INSERT INTO instagram_accounts(account_id,ig_user_id,username,access_token_enc,scopes,connected_by_user_id)
     VALUES($1,$2,'shop',$3,ARRAY['instagram_business_basic','instagram_business_manage_messages'],$4) RETURNING id`,
    [accountId, igUserId, encrypt('test-only-ig-token'), userId],
  )).rows[0].id;
}
async function addContact(accountId: string, userId: string, phone: string, name = 'Channel test'): Promise<string> {
  return (await owner.query('INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$3,$4) RETURNING id',
    [accountId, userId, phone, name])).rows[0].id;
}
async function addIgConversation(accountId: string, userId: string, contactId: string, instagramAccountId: string): Promise<string> {
  return (await owner.query(
    `INSERT INTO conversations(account_id,user_id,contact_id,channel,instagram_account_id) VALUES($1,$2,$3,'instagram',$4) RETURNING id`,
    [accountId, userId, contactId, instagramAccountId])).rows[0].id;
}
function inbound(from: string, metaId: string, text: string) {
  return {
    entry: [{
      id: 'entry',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '1555', phone_number_id: phoneNumberIdA },
          contacts: [{ profile: { name: 'Linked customer' }, wa_id: from }],
          messages: [{ id: metaId, from, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
        },
      }],
    }],
  };
}
const conversationsOf = async (contactId: string) => (await owner.query(
  'SELECT id,channel,whatsapp_config_id,instagram_account_id FROM conversations WHERE contact_id=$1 ORDER BY channel,created_at',
  [contactId])).rows as { id: string; channel: string; whatsapp_config_id: string | null; instagram_account_id: string | null }[];
const pgCode = (p: Promise<unknown>) => p.then(() => null, (e: { code?: string }) => e.code ?? 'error');

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Conversation channel on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string; role: string }[]>`SELECT current_database() AS name, current_user AS role`;
    if (!/test/i.test(app[0].name) || app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Channel test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[ownerA, ownerB, ownerC]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Channel A',$2),($3,'Channel B',$4),($5,'Channel C',$6)", [accountA, ownerA, accountB, ownerB, accountC, ownerC]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($3,$4,'owner'),($5,$6,'owner')", [accountA, ownerA, accountB, ownerB, accountC, ownerC]);
    configA = (await owner.query(
      `INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,waba_id,access_token,status) VALUES($1,$2,$3,$4,$5,'connected') RETURNING id`,
      [accountA, ownerA, phoneNumberIdA, `84${seed}`, encrypt('test-only-token')])).rows[0].id;
    igA1 = await addInstagramAccount(accountA, ownerA, `91${seed}`);
    igA2 = await addInstagramAccount(accountA, ownerA, `92${seed}`);
    igB = await addInstagramAccount(accountB, ownerB, `93${seed}`);
    igC1 = await addInstagramAccount(accountC, ownerC, `94${seed}`);
    igC2 = await addInstagramAccount(accountC, ownerC, `95${seed}`);
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[accountA, accountB, accountC]]);
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB, accountC]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[ownerA, ownerB, ownerC]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  describe('schema', () => {
    it('defaults existing and new rows to WhatsApp; the insert trigger never numbers an Instagram row', async () => {
      const contact = await addContact(accountA, ownerA, `+1415${seed.slice(-7)}`);
      const wa = (await owner.query('INSERT INTO conversations(account_id,user_id,contact_id) VALUES($1,$2,$3) RETURNING channel,whatsapp_config_id',
        [accountA, ownerA, contact])).rows[0];
      expect(wa).toEqual({ channel: 'whatsapp', whatsapp_config_id: configA });
      const ig = await addIgConversation(accountA, ownerA, contact, igA1);
      expect((await owner.query('SELECT whatsapp_config_id FROM conversations WHERE id=$1', [ig])).rows[0].whatsapp_config_id).toBeNull();
      expect((await owner.query("SELECT channel_scope FROM flows LIMIT 0")).fields.map((f) => f.name)).toEqual(['channel_scope']);
    });

    it('enforces the channel/sender CHECK', async () => {
      const contact = await addContact(accountA, ownerA, `+1416${seed.slice(-7)}`);
      expect(await pgCode(owner.query(`INSERT INTO conversations(account_id,user_id,contact_id,channel,instagram_account_id,whatsapp_config_id)
        VALUES($1,$2,$3,'instagram',$4,$5)`, [accountA, ownerA, contact, igA1, configA]))).toBe('23514');
      expect(await pgCode(owner.query(`INSERT INTO conversations(account_id,user_id,contact_id,channel) VALUES($1,$2,$3,'instagram')`,
        [accountA, ownerA, contact]))).toBe('23514');
      expect(await pgCode(owner.query(`INSERT INTO conversations(account_id,user_id,contact_id,instagram_account_id) VALUES($1,$2,$3,$4)`,
        [accountA, ownerA, contact, igA1]))).toBe('23514');
      expect(await pgCode(owner.query(`INSERT INTO conversations(account_id,user_id,contact_id,channel,instagram_account_id) VALUES($1,$2,$3,'sms',$4)`,
        [accountA, ownerA, contact, igA1]))).toBe('23514');
    });

    it('keeps the WhatsApp key (NULLS NOT DISTINCT) and adds a per-account Instagram key', async () => {
      // Workspace C has no number: its WhatsApp conversations stay unnumbered.
      const contact = await addContact(accountC, ownerC, `+1417${seed.slice(-7)}`);
      await owner.query('INSERT INTO conversations(account_id,user_id,contact_id) VALUES($1,$2,$3)', [accountC, ownerC, contact]);
      await addIgConversation(accountC, ownerC, contact, igC1);
      await addIgConversation(accountC, ownerC, contact, igC2);
      expect((await conversationsOf(contact)).map((c) => [c.channel, c.whatsapp_config_id, c.instagram_account_id]))
        .toEqual([['instagram', null, igC1], ['instagram', null, igC2], ['whatsapp', null, null]]);
      expect(await pgCode(owner.query('INSERT INTO conversations(account_id,user_id,contact_id) VALUES($1,$2,$3)', [accountC, ownerC, contact]))).toBe('23505');
      expect(await pgCode(addIgConversation(accountC, ownerC, contact, igC1))).toBe('23505');
      // Numbered WhatsApp duplicates are still refused.
      const numbered = await addContact(accountA, ownerA, `+1418${seed.slice(-7)}`);
      await owner.query('INSERT INTO conversations(account_id,user_id,contact_id,whatsapp_config_id) VALUES($1,$2,$3,$4)', [accountA, ownerA, numbered, configA]);
      expect(await pgCode(owner.query('INSERT INTO conversations(account_id,user_id,contact_id,whatsapp_config_id) VALUES($1,$2,$3,$4)',
        [accountA, ownerA, numbered, configA]))).toBe('23505');
      const indexes = (await owner.query("SELECT indexname FROM pg_indexes WHERE tablename='conversations' AND indexname LIKE 'idx_conversations_%contact%'")).rows
        .map((r) => r.indexname).sort();
      expect(indexes).toEqual(['idx_conversations_ig_contact_account', 'idx_conversations_wa_contact_number']);
    });

    it('refuses cross-tenant references through the composite keys', async () => {
      const contact = await addContact(accountA, ownerA, `+1419${seed.slice(-7)}`);
      expect(await pgCode(addIgConversation(accountA, ownerA, contact, igB))).toBe('23503');
      expect(await pgCode(owner.query(`INSERT INTO contact_channel_identities(account_id,contact_id,instagram_account_id,external_id)
        VALUES($1,$2,$3,'123')`, [accountA, contact, igB]))).toBe('23503');
      expect(await pgCode(owner.query(`INSERT INTO instagram_comment_rules(account_id,instagram_account_id,reply_text) VALUES($1,$2,'hi')`,
        [accountA, igB]))).toBe('23503');
    });

    it('hides tokens from the app role, isolates tenants and keeps the resolvers worker-only', async () => {
      await expect(withTenant(asA, (tx) => tx.$queryRaw`SELECT access_token_enc FROM instagram_accounts`)).rejects.toThrow(/permission denied/i);
      const visible = await withTenant(asA, (tx) => tx.instagram_accounts.findMany({ select: { id: true } }));
      expect(visible.map((r) => r.id).sort()).toEqual([igA1, igA2].sort());
      await expect(getPrisma().$queryRaw`SELECT * FROM crm_resolve_instagram_account(${`93${seed}`})`).rejects.toThrow(/permission denied/i);
      const resolved = await getWorkerPrisma().$queryRaw<{ account_id: string; instagram_account_id: string }[]>`
        SELECT account_id::text, instagram_account_id::text FROM crm_resolve_instagram_account(${`93${seed}`})`;
      expect(resolved).toEqual([{ account_id: accountB, instagram_account_id: igB }]);
      expect(await getWorkerPrisma().$queryRaw`SELECT * FROM crm_resolve_instagram_account(${'not-numeric'})`).toEqual([]);
      // One live owner per Instagram account.
      expect(await pgCode(addInstagramAccount(accountC, ownerC, `93${seed}`))).toBe('23505');
    });
  });

  describe('WhatsApp regression guard for a contact with an Instagram conversation', () => {
    const phone = `1420${seed.slice(-7)}`;
    let contact = '', waConversation = '', igConversation = '';

    beforeAll(async () => {
      // The customer writes on WhatsApp, then (after a staff link) also has an Instagram conversation.
      await processWebhook(inbound(phone, `wamid.ch.${randomUUID()}`, 'hello'));
      contact = (await owner.query('SELECT id FROM contacts WHERE account_id=$1 AND phone_normalized=$2', [accountA, phone])).rows[0].id;
      waConversation = (await conversationsOf(contact))[0].id;
      igConversation = await addIgConversation(accountA, ownerA, contact, igA1);
      await owner.query("INSERT INTO contact_channel_identities(account_id,contact_id,instagram_account_id,external_id) VALUES($1,$2,$3,$4)",
        [accountA, contact, igA1, `96${seed}`]);
      await owner.query(`INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,message_id)
        VALUES($1,$2,'customer','text','hi on instagram',$3)`, [accountA, igConversation, `mid.${randomUUID()}`]);
      // The Instagram conversation is the most recent one.
      await owner.query("UPDATE conversations SET last_message_at=now() + interval '1 hour' WHERE id=$1", [igConversation]);
    });

    it('lands a new WhatsApp message in the WhatsApp conversation, never the Instagram one', async () => {
      await processWebhook(inbound(phone, `wamid.ch.${randomUUID()}`, 'again'));
      const rows = await conversationsOf(contact);
      expect(rows.map((r) => [r.id, r.channel, r.whatsapp_config_id])).toEqual([
        [igConversation, 'instagram', null], [waConversation, 'whatsapp', configA]]);
      expect((await owner.query("SELECT count(*)::int AS n FROM messages WHERE conversation_id=$1 AND sender_type='customer'", [waConversation])).rows[0].n).toBe(2);
    });

    it('creates a WhatsApp conversation instead of adopting an Instagram-only contact\'s Instagram row', async () => {
      const igOnlyPhone = `1421${seed.slice(-7)}`;
      const igOnly = await addContact(accountA, ownerA, `+${igOnlyPhone}`, 'Instagram first');
      const igRow = await addIgConversation(accountA, ownerA, igOnly, igA2);
      await processWebhook(inbound(igOnlyPhone, `wamid.ch.${randomUUID()}`, 'now on WhatsApp'));
      const rows = await conversationsOf(igOnly);
      expect(rows.map((r) => [r.channel, r.whatsapp_config_id, r.instagram_account_id])).toEqual([
        ['instagram', null, igA2], ['whatsapp', configA, null]]);
      expect(rows[0].id).toBe(igRow);
    });

    it('picks the WhatsApp conversation for contact-level and public API sends', async () => {
      const db = createAdminClient({ accountId: accountA, role: 'owner' });
      expect(await pickContactConversationId(db, accountA, contact)).toBe(waConversation);
      const resolved = await resolveConversationByPhone(db, accountA, `+${phone}`);
      expect(resolved.conversationId).toBe(waConversation);
    });

    it('refuses every WhatsApp send on the Instagram conversation without calling Meta, and still sends on WhatsApp', async () => {
      const fetchMock = vi.fn(async (url: string | URL | Request) => {
        if (String(url).includes(`/${phoneNumberIdA}/messages`))
          return new Response(JSON.stringify({ messages: [{ id: `wamid.out.${randomUUID()}` }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        throw new Error(`unexpected fetch ${String(url)}`);
      });
      vi.stubGlobal('fetch', fetchMock);
      const db = createAdminClient({ accountId: accountA, role: 'owner' });
      const intentsBefore = (await owner.query('SELECT count(*)::int AS n FROM outbound_intents WHERE account_id=$1', [accountA])).rows[0].n;

      await expect(sendMessageToConversation(db, accountA, { conversationId: igConversation, messageType: 'text', contentText: 'hello' }))
        .rejects.toMatchObject({ code: 'channel_not_supported', status: 409 });
      await expect(loadConversationSenderConfig(db, accountA, igConversation)).rejects.toMatchObject({ name: 'NoNumberError', reason: 'other_channel' });
      expect(fetchMock).not.toHaveBeenCalled();
      expect((await owner.query('SELECT count(*)::int AS n FROM outbound_intents WHERE account_id=$1', [accountA])).rows[0].n).toBe(intentsBefore);

      // The same contact's WhatsApp conversation still sends from its number.
      await sendMessageToConversation(db, accountA, { conversationId: waConversation, messageType: 'text', contentText: 'reply on WhatsApp' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toContain(`/${phoneNumberIdA}/messages`);
      expect((await owner.query("SELECT count(*)::int AS n FROM messages WHERE conversation_id=$1 AND sender_type='agent'", [igConversation])).rows[0].n).toBe(0);
    });

    it('refuses catalogue, form, storefront and booking-code replies on the Instagram conversation before any intent', async () => {
      const fetchMock = vi.fn(async () => { throw new Error('Meta must not be called'); });
      vi.stubGlobal('fetch', fetchMock);
      const intentsBefore = (await owner.query('SELECT count(*)::int AS n FROM outbound_intents WHERE account_id=$1', [accountA])).rows[0].n;
      const base = { accountId: accountA, sender: 'bot' as const, role: 'owner' as const, conversationId: igConversation };
      await expect(sendCommerceMessage({ ...base, message: { kind: 'catalog', body: 'Our catalogue' }, intentKey: `t:${randomUUID()}` }))
        .rejects.toMatchObject({ code: 'number_unavailable' });
      await expect(sendForm({ ...base, formId: randomUUID(), cta: 'Open', body: 'Fill this in', intentKey: `t:${randomUUID()}` }))
        .rejects.toMatchObject({ code: 'not_configured' });
      await expect(sendStorefrontText({ accountId: accountA, contactId: contact, conversationId: igConversation, text: 'Shop: https://x.test',
        intentKey: `t:${randomUUID()}`, sender: { kind: 'bot', service: true } })).rejects.toMatchObject({ code: 'number_unavailable' });
      // Without a conversation id the storefront picks the contact's WhatsApp conversation, never the Instagram one.
      const igMessage = (await owner.query("SELECT id FROM messages WHERE conversation_id=$1 AND sender_type='customer' LIMIT 1", [igConversation])).rows[0].id;
      expect(await handleHoldReplyJob(accountA, { kind: 'hold_reply', contactId: contact, messageId: igMessage, reason: 'code_unknown' } as never))
        .toBe('skipped');
      expect(fetchMock).not.toHaveBeenCalled();
      expect((await owner.query('SELECT count(*)::int AS n FROM outbound_intents WHERE account_id=$1', [accountA])).rows[0].n).toBe(intentsBefore);
    });

    it('loads the Instagram send target from the row and refuses a WhatsApp conversation', async () => {
      const target = await withTenant(asA, (tx) => loadInstagramTarget(tx, accountA, igConversation), getWorkerPrisma());
      expect(target).toMatchObject({ conversationId: igConversation, contactId: contact, instagramAccountId: igA1, igUserId: `91${seed}`, igsid: `96${seed}` });
      expect(target.lastCustomerAt).toBeInstanceOf(Date);
      await expect(withTenant(asA, (tx) => loadInstagramTarget(tx, accountA, waConversation), getWorkerPrisma()))
        .rejects.toMatchObject({ code: 'channel_not_supported' });
      await owner.query("UPDATE instagram_accounts SET status='token_invalid' WHERE id=$1", [igA1]);
      await expect(withTenant(asA, (tx) => loadInstagramTarget(tx, accountA, igConversation), getWorkerPrisma()))
        .rejects.toMatchObject({ code: 'instagram_token_invalid' });
      await owner.query("UPDATE instagram_accounts SET status='active' WHERE id=$1", [igA1]);
    });
  });
});
