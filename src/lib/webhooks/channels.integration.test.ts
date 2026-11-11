// Stage 2 (2B) on a real PostgreSQL: outbound webhooks per channel and the
// Instagram inbox switches.
// - An endpoint without Instagram (every existing endpoint: channels default
//   {whatsapp}) receives no Instagram event; an Instagram conversation's
//   events reach only endpoints that opted in, in their own workspace.
// - Endpoint channel writes go through the app role under RLS (admins only,
//   own workspace) and the table's check.
// - The Instagram away switch defaults off, needs the away text, survives a
//   save that omits it and turns off with the text; agents cannot write it.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { disconnectDatabases } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { createAdminClient } from '@/lib/data/admin';
import { encrypt } from '@/lib/whatsapp/encryption';
import { cleanupTenants, closeFixture, createTenantPair, fixtureDatabaseUrls, fixtureOwnerPool, type TenantPair } from '@/test/tenancy/fixtures';
import type { DispatchWebhookOptions } from './deliver';
import type { WebhookEvent } from './events';

const databases = fixtureDatabaseUrls();

describe.skipIf(!databases)('[2B] webhook channels and Instagram inbox switches', () => {
  let pair: TenantPair;
  let igConversation = '';
  const endpoints: Record<string, string> = {};

  beforeAll(async () => {
    pair = await createTenantPair({ label: 'whch' });
    const pool = fixtureOwnerPool();
    const { a, b } = pair;
    const account = (await pool.query(
      `INSERT INTO instagram_accounts(account_id,ig_user_id,username,access_token_enc,scopes,connected_by_user_id)
       VALUES($1,$2,'shop',$3,ARRAY['instagram_business_basic','instagram_business_manage_messages'],$4) RETURNING id`,
      [a.accountId, `178${Date.now()}`.slice(0, 17), encrypt('test-only-ig-token'), a.users.owner.userId])).rows[0].id;
    const contact = (await pool.query("INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,'','IG customer') RETURNING id",
      [a.accountId, a.users.owner.userId])).rows[0].id;
    igConversation = (await pool.query(
      "INSERT INTO conversations(account_id,user_id,contact_id,channel,instagram_account_id) VALUES($1,$2,$3,'instagram',$4) RETURNING id",
      [a.accountId, a.users.owner.userId, contact, account])).rows[0].id;
    const add = async (accountId: string, userId: string, name: string, channels: string[]) => {
      endpoints[name] = (await pool.query(
        `INSERT INTO webhook_endpoints(account_id,created_by,url,secret,events,channels) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
        [accountId, userId, `https://hooks.example.com/${name}`, encrypt(`whsec_${name}`), ['message.received', 'conversation.created', 'order.paid'], channels],
      )).rows[0].id;
    };
    // The fixture's endpoint is a pre-Stage 2 endpoint: created without channels.
    endpoints.legacy = a.webhookEndpointId;
    await add(a.accountId, a.users.owner.userId, 'igOnly', ['instagram']);
    await add(a.accountId, a.users.owner.userId, 'both', ['whatsapp', 'instagram']);
    await add(b.accountId, b.users.owner.userId, 'otherTenant', ['whatsapp', 'instagram']);
  }, 60000);

  afterAll(async () => {
    if (pair) {
      await fixtureOwnerPool().query('DELETE FROM jobs WHERE tenant_id = ANY($1::uuid[])', [[pair.a.accountId, pair.b.accountId]]);
      await cleanupTenants([pair.a.accountId, pair.b.accountId]);
    }
    await closeFixture();
    await disconnectDatabases();
  }, 60000);

  beforeEach(async () => {
    await fixtureOwnerPool().query("DELETE FROM jobs WHERE type='webhook.delivery' AND tenant_id = ANY($1::uuid[])", [[pair.a.accountId, pair.b.accountId]]);
  });

  const queued = async () => (await fixtureOwnerPool().query(
    "SELECT tenant_id::text AS tenant, payload FROM jobs WHERE type='webhook.delivery' AND tenant_id = ANY($1::uuid[])",
    [[pair.a.accountId, pair.b.accountId]])).rows as { tenant: string; payload: { endpointId: string; payload: string } }[];
  const receivers = async () => (await queued()).map((row) => Object.entries(endpoints).find(([, id]) => id === row.payload.endpointId)?.[0]).sort();
  const dispatch = async (event: WebhookEvent, data: unknown, options?: DispatchWebhookOptions) => {
    const { dispatchWebhookEvent } = await import('./deliver');
    return dispatchWebhookEvent(createAdminClient({ accountId: pair.a.accountId, role: 'owner' }), pair.a.accountId, event, data, options);
  };

  it('stores every existing endpoint as WhatsApp-only', async () => {
    const row = (await fixtureOwnerPool().query('SELECT channels FROM webhook_endpoints WHERE id=$1', [endpoints.legacy])).rows[0];
    expect(row.channels).toEqual(['whatsapp']);
  });

  it('never queues an Instagram event for an endpoint without Instagram, nor for another workspace', async () => {
    await dispatch('message.received', { conversation_id: igConversation, channel: 'instagram', instagram_message_id: 'mid.1' }, { channel: 'instagram' });
    expect(await receivers()).toEqual(['both', 'igOnly']);
    const envelope = JSON.parse((await queued())[0].payload.payload);
    expect(envelope).toMatchObject({ event: 'message.received', channel: 'instagram', account_id: pair.a.accountId });
    expect((await queued()).every((row) => row.tenant === pair.a.accountId)).toBe(true);
  });

  it('reads the channel from the stored conversation when the caller does not name it', async () => {
    await dispatch('conversation.created', { conversation_id: igConversation });
    expect(await receivers()).toEqual(['both', 'igOnly']);
  });

  it('keeps WhatsApp events on the endpoints that receive WhatsApp, as before', async () => {
    await dispatch('message.received', { conversation_id: pair.a.conversationId, whatsapp_message_id: 'wamid.1' });
    expect(await receivers()).toEqual(['both', 'legacy']);
  });

  it('sends business events to every subscribed endpoint of the workspace', async () => {
    await dispatch('order.paid', { order_id: pair.a.orderId });
    // The legacy fixture endpoint is not subscribed to order.paid.
    expect(await receivers()).toEqual(['both', 'igOnly']);
  });

  it('lets an admin opt an endpoint into Instagram through the app role, and nobody else', async () => {
    const { createWebhook, updateWebhook } = await import('./manage');
    const { a, b } = pair;
    const adminDb = createAdminClient(a.users.admin.context);
    const created = await createWebhook(adminDb, a.accountId, a.users.admin.userId,
      { url: 'https://hooks.example.com/created', events: ['message.received'], channels: ['instagram'] });
    expect(created.channels).toEqual(['instagram']);
    expect((await updateWebhook(adminDb, a.accountId, endpoints.legacy, { channels: ['whatsapp', 'instagram'] }))?.channels)
      .toEqual(['whatsapp', 'instagram']);
    // Another workspace's admin cannot touch it (RLS: no row).
    expect(await updateWebhook(createAdminClient(b.users.admin.context), b.accountId, endpoints.legacy, { channels: ['whatsapp'] })).toBeNull();
    // An agent cannot change an endpoint's channels (refused or no row, never written).
    const agentWrite = await withTenant(a.users.agent.context, (tx) =>
      tx.$executeRaw`UPDATE webhook_endpoints SET channels='{instagram}' WHERE id=${endpoints.legacy}::uuid`).catch(() => 0);
    expect(agentWrite).toBe(0);
    expect((await fixtureOwnerPool().query('SELECT channels FROM webhook_endpoints WHERE id=$1', [endpoints.legacy])).rows[0].channels)
      .toEqual(['whatsapp', 'instagram']);
    // The table refuses an unknown channel and an empty list, whatever the caller.
    await expect(fixtureOwnerPool().query("UPDATE webhook_endpoints SET channels='{sms}' WHERE id=$1", [endpoints.legacy])).rejects.toThrow();
    await expect(fixtureOwnerPool().query("UPDATE webhook_endpoints SET channels='{}' WHERE id=$1", [endpoints.legacy])).rejects.toThrow();
    await fixtureOwnerPool().query("UPDATE webhook_endpoints SET channels='{whatsapp}' WHERE id=$1", [endpoints.legacy]);
  });

  it('keeps the Instagram away switch off by default, tied to the away text, and admin-only', async () => {
    const { loadInboxSettings, saveInboxSettings } = await import('@/lib/inbox/inbox-settings');
    const { a, b } = pair;
    const base = { timezone: 'UTC', working_hours: {}, away_message_enabled: false, auto_resolve_after_hours: null, sla_first_response_minutes: null };
    expect((await loadInboxSettings(a.users.viewer.context)).instagram_away_message_enabled).toBe(false);
    expect(await saveInboxSettings(a.users.admin.context, { ...base, away_message: 'Closed now', instagram_away_message_enabled: true }))
      .toMatchObject({ away_message_enabled: false, instagram_away_message_enabled: true });
    // A save that omits it (an older client) keeps it.
    expect((await saveInboxSettings(a.users.admin.context, { ...base, away_message: 'Closed now' })).instagram_away_message_enabled).toBe(true);
    // Clearing the text turns it off with it (the table's check agrees).
    expect((await saveInboxSettings(a.users.admin.context, { ...base, away_message: null })).instagram_away_message_enabled).toBe(false);
    await expect(saveInboxSettings(a.users.agent.context, { ...base, away_message: 'x', instagram_away_message_enabled: true })).rejects.toThrow();
    expect((await loadInboxSettings(b.users.owner.context)).instagram_away_message_enabled).toBe(false);
  });

  it('keeps the Instagram AI switch off by default and readable through the AI config loader', async () => {
    const { a } = pair;
    const { loadAiConfig } = await import('@/lib/ai/config');
    await fixtureOwnerPool().query('UPDATE ai_configs SET is_active=true WHERE account_id=$1', [a.accountId]);
    const db = createAdminClient({ accountId: a.accountId, role: 'owner' });
    expect((await loadAiConfig(db, a.accountId))?.instagramAutoReplyEnabled).toBe(false);
    await withTenant(a.users.admin.context, (tx) =>
      tx.$executeRaw`UPDATE ai_configs SET instagram_auto_reply_enabled=true WHERE account_id=${a.accountId}::uuid`);
    expect((await loadAiConfig(db, a.accountId))?.instagramAutoReplyEnabled).toBe(true);
    // An agent cannot switch it (refused or no row, never written).
    const agentWrite = await withTenant(a.users.agent.context, (tx) =>
      tx.$executeRaw`UPDATE ai_configs SET instagram_auto_reply_enabled=false WHERE account_id=${a.accountId}::uuid`).catch(() => 0);
    expect(agentWrite).toBe(0);
    expect((await loadAiConfig(db, a.accountId))?.instagramAutoReplyEnabled).toBe(true);
  });
});
