// Phase 11 T5 on a real PostgreSQL: staff identity linking (CRM-02), the
// Instagram text branches of the storefront and payment-link senders, and the
// "has Instagram identity" audience condition. Every send is mocked at fetch;
// nothing reaches Meta.
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { createAdminClient } from '@/lib/data/admin';
import { encrypt } from '@/lib/whatsapp/encryption';
import { processWebhook } from '@/lib/whatsapp/process-webhook';
import { loadConversationSenderConfig } from '@/lib/whatsapp/sender-config';
import { pickContactConversationId } from '@/lib/whatsapp/contact-conversation';
import { sendStorefrontText } from '@/lib/commerce/storefront';
import { sendPaymentLinkMessage } from '@/lib/payments/links';
import { compileAudienceFilter, parseAudienceFilter } from '@/lib/audience/filter';
import { linkIdentity, listContactIdentities, unlinkIdentity, type IdentityLinkActor } from './identity-link';
import { processInboundActions } from '@/lib/whatsapp/inbound-actions';

const webhook = vi.hoisted(() => ({ dispatch: vi.fn(async () => {}) }));
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: webhook.dispatch }));

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const ownerA = randomUUID(), agentA = randomUUID(), ownerB = randomUUID();
const asOwner: IdentityLinkActor = { accountId: accountA, userId: ownerA, role: 'owner' };
const asAgent: IdentityLinkActor = { accountId: accountA, userId: agentA, role: 'agent' };
const seed = String(Date.now()).slice(-9);
const phoneNumberIdA = `75${seed}`;
let owner: pg.Client;
let igA1 = '', igA2 = '', igB = '';

async function addInstagramAccount(accountId: string, userId: string, igUserId: string): Promise<string> {
  return (await owner.query(
    `INSERT INTO instagram_accounts(account_id,ig_user_id,username,access_token_enc,scopes,connected_by_user_id)
     VALUES($1,$2,'shop',$3,ARRAY['instagram_business_basic','instagram_business_manage_messages'],$4) RETURNING id`,
    [accountId, igUserId, encrypt('test-only-ig-token'), userId],
  )).rows[0].id;
}
async function addContact(accountId: string, userId: string, phone: string, name: string): Promise<string> {
  return (await owner.query('INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$3,$4) RETURNING id',
    [accountId, userId, phone, name])).rows[0].id;
}
/** An Instagram-only contact as ingest creates it: phone-less, one identity, one Instagram conversation with a customer message. */
async function addInstagramCustomer(accountId: string, userId: string, instagramAccountId: string, igsid: string, name: string,
  lastCustomerAgo = '5 minutes') {
  const contact = await addContact(accountId, userId, '', name);
  const identity = (await owner.query(`INSERT INTO contact_channel_identities(account_id,contact_id,instagram_account_id,external_id,username,display_name)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, [accountId, contact, instagramAccountId, igsid, `u${igsid}`, name])).rows[0].id;
  const conversation = (await owner.query(`INSERT INTO conversations(account_id,user_id,contact_id,channel,instagram_account_id)
    VALUES($1,$2,$3,'instagram',$4) RETURNING id`, [accountId, userId, contact, instagramAccountId])).rows[0].id;
  await owner.query(`INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,message_id,created_at)
    VALUES($1,$2,'customer','text','hi',$3,now() - $4::interval)`, [accountId, conversation, `mid.${randomUUID()}`, lastCustomerAgo]);
  return { contact, identity, conversation };
}
function inbound(from: string, text: string) {
  return {
    entry: [{
      id: 'entry',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '1555', phone_number_id: phoneNumberIdA },
          contacts: [{ profile: { name: 'WhatsApp customer' }, wa_id: from }],
          messages: [{ id: `wamid.il.${randomUUID()}`, from, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
        },
      }],
    }],
  };
}
const contactOf = async (table: 'conversations' | 'contact_channel_identities', id: string) =>
  (await owner.query(`SELECT contact_id FROM ${table} WHERE id=$1`, [id])).rows[0]?.contact_id as string | undefined;
const errorCode = (p: Promise<unknown>) => p.then(() => null, (e: { code?: string }) => e.code ?? 'error');
const enableInstagram = () => {
  vi.stubEnv('INSTAGRAM_ENABLED', 'true');
  vi.stubEnv('INSTAGRAM_APP_ID', '1234567890');
  vi.stubEnv('INSTAGRAM_APP_SECRET', 'test-only-secret');
  vi.stubEnv('INSTAGRAM_WEBHOOK_VERIFY_TOKEN', 'test-only-verify');
  vi.stubEnv('INSTAGRAM_REDIRECT_URI', 'https://app.example.test/api/instagram/callback');
};
function instagramFetch() {
  return vi.fn(async (url: string | URL | Request) => {
    if (String(url).startsWith('https://graph.instagram.com/'))
      return new Response(JSON.stringify({ recipient_id: '1', message_id: `mid.out.${randomUUID()}` }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    throw new Error('unexpected fetch');
  });
}

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Identity linking and Instagram shared services on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string; role: string }[]>`SELECT current_database() AS name, current_user AS role`;
    if (!/test/i.test(app[0].name) || app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Identity test', 'test-only-hash' FROM unnest($1::uuid[]) x",
      [[ownerA, agentA, ownerB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Identity A',$2),($3,'Identity B',$4)", [accountA, ownerA, accountB, ownerB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'agent'),($4,$5,'owner')",
      [accountA, ownerA, agentA, accountB, ownerB]);
    await owner.query(`INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,waba_id,access_token,status) VALUES($1,$2,$3,$4,$5,'connected')`,
      [accountA, ownerA, phoneNumberIdA, `85${seed}`, encrypt('test-only-token')]);
    igA1 = await addInstagramAccount(accountA, ownerA, `81${seed}`);
    igA2 = await addInstagramAccount(accountA, ownerA, `82${seed}`);
    igB = await addInstagramAccount(accountB, ownerB, `83${seed}`);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[ownerA, agentA, ownerB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  describe('staff link and unlink', () => {
    const waPhone = `1430${seed.slice(-7)}`;
    let waContact = '', waConversation = '';
    let ig: Awaited<ReturnType<typeof addInstagramCustomer>>;

    beforeAll(async () => {
      await processWebhook(inbound(waPhone, 'hello on WhatsApp'));
      waContact = (await owner.query('SELECT id FROM contacts WHERE account_id=$1 AND phone_normalized=$2', [accountA, waPhone])).rows[0].id;
      waConversation = (await owner.query("SELECT id FROM conversations WHERE contact_id=$1 AND channel='whatsapp'", [waContact])).rows[0].id;
      // Same display name as the WhatsApp contact: still a separate contact until staff decide.
      ig = await addInstagramCustomer(accountA, ownerA, igA1, `71${seed}`, 'WhatsApp customer');
    });

    it('moves the identity and its conversation, records the decision and an id-only audit row', async () => {
      const before = await listContactIdentities(asOwner, ig.contact);
      expect(before).toEqual([expect.objectContaining({ id: ig.identity, channel: 'instagram', instagramAccountId: igA1, canUnlink: false })]);

      const { linkId } = await linkIdentity(asOwner, { contactId: ig.contact, identityId: ig.identity, targetContactId: waContact, note: ' same person ' });
      expect(await contactOf('contact_channel_identities', ig.identity)).toBe(waContact);
      expect(await contactOf('conversations', ig.conversation)).toBe(waContact);
      // Both histories are kept: the WhatsApp conversation and the Instagram one with its message.
      expect((await owner.query('SELECT count(*)::int AS n FROM messages WHERE conversation_id=$1', [ig.conversation])).rows[0].n).toBe(1);
      expect(await contactOf('conversations', waConversation)).toBe(waContact);

      const link = (await owner.query('SELECT * FROM contact_identity_links WHERE id=$1', [linkId])).rows[0];
      expect(link).toMatchObject({ account_id: accountA, identity_id: ig.identity, from_contact_id: ig.contact, to_contact_id: waContact,
        kind: 'link', basis: 'staff_decision', note: 'same person', decided_by_user_id: ownerA });
      const audit = (await owner.query("SELECT user_id,resource_id,metadata FROM audit_logs WHERE account_id=$1 AND action='contact.identity_link'",
        [accountA])).rows;
      expect(audit).toEqual([{ user_id: ownerA, resource_id: ig.identity,
        metadata: { link_id: linkId, from_contact_id: ig.contact, to_contact_id: waContact } }]);
      expect(JSON.stringify(audit)).not.toContain('same person');
      expect(await listContactIdentities(asOwner, waContact)).toEqual([expect.objectContaining({ id: ig.identity, canUnlink: true })]);
      expect(await listContactIdentities(asOwner, ig.contact)).toEqual([]);
    });

    it('keeps WhatsApp on WhatsApp for the linked contact', async () => {
      await processWebhook(inbound(waPhone, 'again on WhatsApp'));
      expect((await owner.query("SELECT count(*)::int AS n FROM messages WHERE conversation_id=$1 AND sender_type='customer'", [waConversation])).rows[0].n).toBe(2);
      expect((await owner.query("SELECT count(*)::int AS n FROM messages WHERE conversation_id=$1 AND sender_type='customer'", [ig.conversation])).rows[0].n).toBe(1);
      const db = createAdminClient({ accountId: accountA, role: 'owner' });
      expect(await pickContactConversationId(db, accountA, waContact)).toBe(waConversation);
      await expect(loadConversationSenderConfig(db, accountA, ig.conversation)).rejects.toMatchObject({ name: 'NoNumberError', reason: 'other_channel' });
    });

    it('unlinks back to the original contact with its own record', async () => {
      const result = await unlinkIdentity(asOwner, { contactId: waContact, identityId: ig.identity });
      expect(result.contactId).toBe(ig.contact);
      expect(await contactOf('contact_channel_identities', ig.identity)).toBe(ig.contact);
      expect(await contactOf('conversations', ig.conversation)).toBe(ig.contact);
      expect((await owner.query('SELECT kind,from_contact_id,to_contact_id FROM contact_identity_links WHERE id=$1', [result.linkId])).rows[0])
        .toEqual({ kind: 'unlink', from_contact_id: waContact, to_contact_id: ig.contact });
      expect((await owner.query("SELECT count(*)::int AS n FROM audit_logs WHERE account_id=$1 AND action='contact.identity_unlink'", [accountA])).rows[0].n).toBe(1);
      // A first-seen identity (latest decision is not a link onto this contact) cannot be unlinked.
      expect(await errorCode(unlinkIdentity(asOwner, { contactId: ig.contact, identityId: ig.identity }))).toBe('invalid_request');
    });

    it('refuses a target that already has a conversation or identity on the same Instagram account', async () => {
      const other = await addInstagramCustomer(accountA, ownerA, igA1, `72${seed}`, 'Other');
      expect(await errorCode(linkIdentity(asOwner, { contactId: ig.contact, identityId: ig.identity, targetContactId: other.contact })))
        .toBe('identity_conflict');
      // A different Instagram account on the target is fine for the key, so only the same-account case conflicts.
      const onA2 = await addInstagramCustomer(accountA, ownerA, igA2, `73${seed}`, 'Second account');
      const { linkId } = await linkIdentity(asOwner, { contactId: onA2.contact, identityId: onA2.identity, targetContactId: other.contact });
      expect(linkId).toBeTruthy();
      expect(await contactOf('contact_channel_identities', ig.identity)).toBe(ig.contact);
    });

    it('refuses while a flow run is active in the identity\'s conversation', async () => {
      const busy = await addInstagramCustomer(accountA, ownerA, igA2, `74${seed}`, 'Busy');
      const target = await addContact(accountA, ownerA, `+1431${seed.slice(-7)}`, 'Target');
      const flow = (await owner.query(`INSERT INTO flows(account_id,user_id,name,trigger_type) VALUES($1,$2,'Busy flow','keyword') RETURNING id`,
        [accountA, ownerA])).rows[0].id;
      await owner.query(`INSERT INTO flow_runs(account_id,flow_id,user_id,contact_id,conversation_id,status) VALUES($1,$2,$3,$4,$5,'active')`,
        [accountA, flow, ownerA, busy.contact, busy.conversation]);
      expect(await errorCode(linkIdentity(asOwner, { contactId: busy.contact, identityId: busy.identity, targetContactId: target }))).toBe('identity_busy');
      expect(await contactOf('conversations', busy.conversation)).toBe(busy.contact);
      expect((await owner.query('SELECT count(*)::int AS n FROM contact_identity_links WHERE identity_id=$1', [busy.identity])).rows[0].n).toBe(0);
    });

    it('refuses while an inbound.actions job for the conversation is still queued with the old contact', async () => {
      const queued = await addInstagramCustomer(accountA, ownerA, igA2, `77${seed}`, 'Queued');
      const target = await addContact(accountA, ownerA, `+1437${seed.slice(-7)}`, 'Queued target');
      const job = (await owner.query(`INSERT INTO jobs(type,tenant_id,payload,dedupe_key) VALUES('inbound.actions',$1,$2::jsonb,$3) RETURNING id`,
        [accountA, JSON.stringify({ kind: 'message', contactId: queued.contact, conversationId: queued.conversation }), `inbound:test:${randomUUID()}`])).rows[0].id;
      expect(await errorCode(linkIdentity(asOwner, { contactId: queued.contact, identityId: queued.identity, targetContactId: target }))).toBe('identity_busy');
      expect(await contactOf('conversations', queued.conversation)).toBe(queued.contact);
      // Once the job has run, the link goes through.
      await owner.query("UPDATE jobs SET status='done' WHERE id=$1", [job]);
      await linkIdentity(asOwner, { contactId: queued.contact, identityId: queued.identity, targetContactId: target });
      expect(await contactOf('conversations', queued.conversation)).toBe(target);
    });

    it('a job retried after the link acts for the contact that owns the conversation now, never the queued one', async () => {
      const stale = await addInstagramCustomer(accountA, ownerA, igA2, `69${seed}`, 'Stale');
      const target = await addContact(accountA, ownerA, `+1449${seed.slice(-7)}`, 'Stale target');
      const message = (await owner.query('SELECT id,message_id FROM messages WHERE conversation_id=$1', [stale.conversation])).rows[0];
      await linkIdentity(asOwner, { contactId: stale.contact, identityId: stale.identity, targetContactId: target });
      // The payload was built before the link: it still names the source contact.
      await processInboundActions({ kind: 'message', accountId: accountA, userId: ownerA, contactId: stale.contact,
        conversationId: stale.conversation, messageId: message.id, metaMessageId: message.message_id, interactiveReplyId: null,
        contentType: 'text', contentText: 'STOP', wasContactCreated: false, wasConversationCreated: false, isFirstInboundMessage: false });
      // An Instagram STOP is Instagram-only (Stage 5): instagram_opted_out_at, not the contact-wide opted_out_at.
      const optedOut = async (id: string) => (await owner.query('SELECT instagram_opted_out_at FROM contacts WHERE id=$1', [id])).rows[0].instagram_opted_out_at;
      expect(await optedOut(target)).not.toBeNull();
      expect(await optedOut(stale.contact)).toBeNull();
      expect((await owner.query('SELECT count(*)::int AS n FROM flow_runs WHERE conversation_id=$1 AND contact_id=$2',
        [stale.conversation, stale.contact])).rows[0].n).toBe(0);
    });

    it('waits for the sender lock ingest holds, so ingest never resolves a thread from an identity being moved', async () => {
      const moving = await addInstagramCustomer(accountA, ownerA, igA2, `78${seed}`, 'Moving');
      const target = await addContact(accountA, ownerA, `+1438${seed.slice(-7)}`, 'Moving target');
      const ingest = new pg.Client({ connectionString: ownerUrl });
      await ingest.connect();
      try {
        // What resolveThread takes first for this sender.
        await ingest.query('BEGIN');
        await ingest.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`igsid:${igA2}:78${seed}`]);
        let settled = false;
        const link = linkIdentity(asOwner, { contactId: moving.contact, identityId: moving.identity, targetContactId: target })
          .finally(() => { settled = true; });
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(settled).toBe(false);
        expect(await contactOf('contact_channel_identities', moving.identity)).toBe(moving.contact);
        await ingest.query('COMMIT');
        await link;
        expect(await contactOf('contact_channel_identities', moving.identity)).toBe(target);
      } finally {
        await ingest.query('ROLLBACK').catch(() => {});
        await ingest.end();
      }
    });

    it('unlinks to an unnamed contact, never naming it after the username', async () => {
      const handleOnly = await addInstagramCustomer(accountA, ownerA, igA2, `79${seed}`, 'Handle only');
      await owner.query('UPDATE contact_channel_identities SET display_name=NULL WHERE id=$1', [handleOnly.identity]);
      const target = await addContact(accountA, ownerA, `+1439${seed.slice(-7)}`, 'Handle target');
      await linkIdentity(asOwner, { contactId: handleOnly.contact, identityId: handleOnly.identity, targetContactId: target });
      await owner.query('DELETE FROM contacts WHERE id=$1', [handleOnly.contact]);
      const result = await unlinkIdentity(asOwner, { contactId: target, identityId: handleOnly.identity });
      expect((await owner.query('SELECT phone,name FROM contacts WHERE id=$1', [result.contactId])).rows[0]).toEqual({ phone: '', name: null });
    });

    it('refuses agents, other workspaces\' ids and a link onto the same contact', async () => {
      const target = await addContact(accountA, ownerA, `+1432${seed.slice(-7)}`, 'Agent target');
      expect(await errorCode(linkIdentity(asAgent, { contactId: ig.contact, identityId: ig.identity, targetContactId: target }))).toBe('forbidden');
      expect(await errorCode(unlinkIdentity(asAgent, { contactId: ig.contact, identityId: ig.identity }))).toBe('forbidden');
      // RLS holds even if the role check were skipped: an agent's update moves nothing.
      const agentCtx: TenantContext = { accountId: accountA, userId: agentA, role: 'agent' };
      const moved = await withTenant(agentCtx, (tx) => tx.$executeRaw`UPDATE contact_channel_identities SET contact_id=${target}::uuid WHERE id=${ig.identity}::uuid`);
      expect(moved).toBe(0);
      await expect(withTenant(agentCtx, (tx) => tx.$executeRaw`INSERT INTO contact_identity_links(account_id,identity_id,from_contact_id,to_contact_id,kind,decided_by_user_id)
        VALUES(${accountA}::uuid,${ig.identity}::uuid,${ig.contact}::uuid,${target}::uuid,'link',${agentA}::uuid)`)).rejects.toThrow();

      const foreign = await addInstagramCustomer(accountB, ownerB, igB, `75${seed}`, 'Workspace B');
      expect(await errorCode(linkIdentity(asOwner, { contactId: ig.contact, identityId: ig.identity, targetContactId: foreign.contact }))).toBe('not_found');
      expect(await errorCode(linkIdentity(asOwner, { contactId: foreign.contact, identityId: foreign.identity, targetContactId: target }))).toBe('not_found');
      expect(await errorCode(linkIdentity(asOwner, { contactId: ig.contact, identityId: foreign.identity, targetContactId: target }))).toBe('not_found');
      expect(await errorCode(linkIdentity(asOwner, { contactId: ig.contact, identityId: ig.identity, targetContactId: ig.contact }))).toBe('invalid_request');
      expect(await errorCode(linkIdentity(asOwner, { contactId: ig.contact, identityId: ig.identity, targetContactId: target, note: 'x'.repeat(201) })))
        .toBe('invalid_request');
      expect(await contactOf('contact_channel_identities', foreign.identity)).toBe(foreign.contact);
      expect(await contactOf('contact_channel_identities', ig.identity)).toBe(ig.contact);
    });

    it('unlinks to a new phone-less contact when the original contact was deleted', async () => {
      const lone = await addInstagramCustomer(accountA, ownerA, igA2, `76${seed}`, 'Deleted later');
      const target = await addContact(accountA, ownerA, `+1433${seed.slice(-7)}`, 'Keeper');
      await linkIdentity(asOwner, { contactId: lone.contact, identityId: lone.identity, targetContactId: target });
      await owner.query('DELETE FROM contacts WHERE id=$1', [lone.contact]);
      const result = await unlinkIdentity(asOwner, { contactId: target, identityId: lone.identity });
      expect(result.contactId).not.toBe(lone.contact);
      expect((await owner.query('SELECT phone,name,account_id FROM contacts WHERE id=$1', [result.contactId])).rows[0])
        .toEqual({ phone: '', name: 'Deleted later', account_id: accountA });
      expect(await contactOf('conversations', lone.conversation)).toBe(result.contactId);
    });
  });

  describe('Instagram text branches of shared services', () => {
    it('sends a storefront link on an Instagram conversation inside the window, through graph.instagram.com only', async () => {
      enableInstagram();
      const fetchMock = instagramFetch();
      vi.stubGlobal('fetch', fetchMock);
      const c = await addInstagramCustomer(accountA, ownerA, igA1, `61${seed}`, 'Shopper');
      const result = await sendStorefrontText({ accountId: accountA, contactId: c.contact, conversationId: c.conversation,
        text: 'Shop: https://shop.example.test/s/abc', intentKey: `t5:${randomUUID()}`, sender: { kind: 'bot', service: true } });
      expect(result.conversationId).toBe(c.conversation);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toContain(`/81${seed}/messages`);
      expect(JSON.parse(String(init.body))).toMatchObject({ recipient: { id: `61${seed}` }, message: { text: 'Shop: https://shop.example.test/s/abc' } });
      expect(JSON.stringify(init.body)).not.toContain('HUMAN_AGENT');
      const row = (await owner.query("SELECT sender_type,message_id,status FROM messages WHERE conversation_id=$1 AND sender_type<>'customer'", [c.conversation])).rows;
      expect(row).toEqual([{ sender_type: 'bot', message_id: result.whatsappMessageId, status: 'sent' }]);
    });

    it('refuses a closed window, a disabled channel and a contact-only pick before any intent or call', async () => {
      const fetchMock = vi.fn(async () => { throw new Error('Meta must not be called'); });
      vi.stubGlobal('fetch', fetchMock);
      const intents = async () => (await owner.query('SELECT count(*)::int AS n FROM outbound_intents WHERE account_id=$1', [accountA])).rows[0].n;
      const before = await intents();
      const stale = await addInstagramCustomer(accountA, ownerA, igA2, `62${seed}`, 'Stale', '2 days');
      const send = (contactId: string, conversationId: string | null) => sendStorefrontText({ accountId: accountA, contactId, conversationId,
        text: 'Shop', intentKey: `t5:${randomUUID()}`, sender: { kind: 'bot', service: true } } as never);
      // Off: the Instagram branch never calls out.
      expect(await errorCode(send(stale.contact, stale.conversation))).toBe('number_unavailable');
      enableInstagram();
      expect(await errorCode(send(stale.contact, stale.conversation))).toBe('outside_window');
      // Without a conversation id only WhatsApp conversations are picked; an Instagram-only contact has none.
      expect(await errorCode(send(stale.contact, null))).toBe('contact_not_found');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await intents()).toBe(before);
    });

    it('sends a payment link on an Instagram conversation as an agent message', async () => {
      enableInstagram();
      const fetchMock = instagramFetch();
      vi.stubGlobal('fetch', fetchMock);
      const c = await addInstagramCustomer(accountA, ownerA, igA1, `63${seed}`, 'Payer');
      const reference = `bx_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const linkId = (await owner.query(`INSERT INTO payment_links(account_id,provider,reference_id,amount_minor,currency,description,contact_id,
        conversation_id,status,short_url,provider_link_id) VALUES($1,'razorpay',$2,1000,'INR','Test',$3,$4,'created','https://rzp.io/i/t5',$5) RETURNING id`,
        [accountA, reference, c.contact, c.conversation, `plink_${seed}`])).rows[0].id;
      const result = await sendPaymentLinkMessage({ accountId: accountA, userId: ownerA, role: 'owner', linkId, message: 'Pay here',
        intentKey: `t5:${randomUUID()}` });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toContain(`/81${seed}/messages`);
      const row = (await owner.query('SELECT sender_type,content_text,message_id FROM messages WHERE id=$1', [result.messageId])).rows[0];
      expect(row).toMatchObject({ sender_type: 'agent', message_id: result.whatsappMessageId });
      // The link rides as the card's URL button (Stage 3), so the stored text is the caption and Meta got the URL.
      expect(row.content_text).toContain('Pay here');
      expect(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)).toContain('https://rzp.io/i/t5');

      // Outside the window the link is refused before any intent.
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Meta must not be called'); }));
      await owner.query("UPDATE messages SET created_at=now() - interval '3 days' WHERE conversation_id=$1 AND sender_type='customer'", [c.conversation]);
      expect(await errorCode(sendPaymentLinkMessage({ accountId: accountA, userId: ownerA, role: 'owner', linkId, message: 'Pay here',
        intentKey: `t5:${randomUUID()}` }))).toBe('window_closed');
    });
  });

  it('filters an audience by Instagram identity inside the workspace', async () => {
    const igOnly = await addInstagramCustomer(accountA, ownerA, igA2, `51${seed}`, 'Audience IG');
    const phoneOnly = await addContact(accountA, ownerA, `+1434${seed.slice(-7)}`, 'Audience phone');
    const ids = async (op: 'has_identity' | 'has_no_identity') => {
      const where = compileAudienceFilter(accountA, parseAudienceFilter({ conditions: [{ field: 'instagram', op }] }));
      const rows = await withTenant({ accountId: accountA, userId: ownerA, role: 'owner' },
        (tx) => tx.$queryRaw<{ id: string }[]>`SELECT c.id::text AS id FROM contacts c WHERE ${where}`);
      return rows.map((r) => r.id);
    };
    expect(await ids('has_identity')).toContain(igOnly.contact);
    expect(await ids('has_identity')).not.toContain(phoneOnly);
    expect(await ids('has_no_identity')).toContain(phoneOnly);
    expect(await ids('has_no_identity')).not.toContain(igOnly.contact);
  });
});
