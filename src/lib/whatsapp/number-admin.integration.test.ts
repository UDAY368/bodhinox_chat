import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { createAdminClient } from '@/lib/data/admin';
import { conversationNumberDisconnected, loadAccountMetaCredentials } from '@/lib/flows/meta-send';
import { encrypt } from '@/lib/whatsapp/encryption';
import { createBroadcast } from './broadcast-core';
import { planBroadcastResume } from './broadcast-resume';
import { disconnectAndReport, disconnectNumber, renameNumber, toNumberDto } from './number-admin';
import { getNumberConfig, listNumbers, setDefaultNumber } from './numbers';
import { sendMessageToConversation } from './send-message';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
// The send paths use the constrained worker data client.
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID(), accountC = randomUUID();
const adminA = randomUUID(), agentA = randomUUID(), ownerB = randomUUID(), adminC = randomUUID();
const asAdminA: TenantContext = { accountId: accountA, userId: adminA, role: 'admin' };
const asAgentA: TenantContext = { accountId: accountA, userId: agentA, role: 'agent' };
const asB: TenantContext = { accountId: accountB, userId: ownerB, role: 'owner' };
const seed = String(Date.now()).slice(-9);
let owner: pg.Client;

async function addNumber(accountId: string, userId: string, phoneNumberId: string, createdAt: string): Promise<string> {
  return (await owner.query(
    `INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,waba_id,access_token,verify_token,status,created_at)
     VALUES($1,$2,$3,$4,$5,$6,'connected',$7) RETURNING id`,
    [accountId, userId, phoneNumberId, `9${seed}`, encrypt('test-only-token'), encrypt('test-only-verify'), createdAt],
  )).rows[0].id;
}

async function addFlow(accountId: string, userId: string, status: string, configId: string | null): Promise<string> {
  return (await owner.query(
    `INSERT INTO flows(account_id,user_id,name,status,trigger_type,whatsapp_config_id) VALUES($1,$2,'Numbers test',$3,'manual',$4) RETURNING id`,
    [accountId, userId, status, configId],
  )).rows[0].id;
}

async function addCampaign(accountId: string, userId: string, status: string, configId: string | null, kind = 'standard'): Promise<string> {
  return (await owner.query(
    `INSERT INTO broadcasts(account_id,user_id,name,template_name,status,kind,whatsapp_config_id,scheduled_at)
     VALUES($1,$2,'Numbers test campaign','hello_world',$3,$4,$5,now() + interval '1 day') RETURNING id`,
    [accountId, userId, status, kind, configId],
  )).rows[0].id;
}
const campaignRow = async (id: string) =>
  (await owner.query('SELECT status, whatsapp_config_id FROM broadcasts WHERE id=$1', [id])).rows[0];

const flowStatus = async (id: string) => (await owner.query('SELECT status FROM flows WHERE id=$1', [id])).rows[0].status;
const flowRow = async (id: string) => (await owner.query('SELECT status, whatsapp_config_id FROM flows WHERE id=$1', [id])).rows[0];
const numberRow = async (id: string) =>
  (await owner.query('SELECT status, access_token, is_default FROM whatsapp_config WHERE id=$1', [id])).rows[0];

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('WhatsApp number admin on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string; role: string }[]>`SELECT current_database() AS name, current_user AS role`;
    if (!/test/i.test(app[0].name) || app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Number admin test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[adminA, agentA, ownerB, adminC]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Number admin A',$2),($3,'Number admin B',$4),($5,'Number admin C',$6)", [accountA, adminA, accountB, ownerB, accountC, adminC]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'agent'),($4,$5,'owner'),($6,$7,'admin')", [accountA, adminA, agentA, accountB, ownerB, accountC, adminC]);
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[accountA, accountB, accountC]]);
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB, accountC]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[adminA, agentA, ownerB, adminC]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('renames for admins only, and only inside the workspace', async () => {
    const first = await addNumber(accountA, adminA, `61${seed}`, '2026-01-01T00:00:00Z');
    const b = await addNumber(accountB, ownerB, `63${seed}`, '2026-01-01T00:00:00Z');
    expect(await withTenant(asAdminA, (tx) => renameNumber(tx, accountA, first, '  Support line  '))).toBe(true);
    // RLS: an agent's update matches nothing; another tenant cannot see the row.
    expect(await withTenant(asAgentA, (tx) => renameNumber(tx, accountA, first, 'Agent label'))).toBe(false);
    expect(await withTenant(asB, (tx) => renameNumber(tx, accountA, first, 'Hijack'))).toBe(false);
    expect(await withTenant(asB, (tx) => renameNumber(tx, accountB, first, 'Hijack'))).toBe(false);
    expect(await withTenant(asAdminA, (tx) => renameNumber(tx, accountA, b, 'Cross'))).toBe(false);
    const listed = await withTenant(asAgentA, (tx) => listNumbers(tx, accountA));
    expect(listed.map((n) => n.display_name)).toEqual(['Support line']);
    // The browser shape carries no token or key material.
    const dto = toNumberDto(listed[0]);
    expect(Object.keys(dto).some((k) => /token|key|secret/.test(k))).toBe(false);
    expect(await withTenant(asAdminA, (tx) => renameNumber(tx, accountA, first, '   '))).toBe(true);
    expect((await owner.query('SELECT display_name FROM whatsapp_config WHERE id=$1', [first])).rows[0].display_name).toBeNull();
  });

  it('disconnects one number in place: default moves, live flows drafted, campaigns held not cancelled', async () => {
    await owner.query('DELETE FROM whatsapp_config WHERE account_id=$1', [accountA]);
    const oldest = await addNumber(accountA, adminA, `64${seed}`, '2026-02-01T00:00:00Z');
    const middle = await addNumber(accountA, adminA, `65${seed}`, '2026-03-01T00:00:00Z');
    const newest = await addNumber(accountA, adminA, `66${seed}`, '2026-04-01T00:00:00Z');
    // Two statements: the one-default unique index is checked per row, so a single swap can fail on row order.
    await owner.query('UPDATE whatsapp_config SET is_default=false WHERE account_id=$1 AND id<>$2', [accountA, middle]);
    await owner.query('UPDATE whatsapp_config SET is_default=true WHERE id=$1', [middle]);
    const contact = (await owner.query("INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$3,'Number admin') RETURNING id", [accountA, adminA, `5${seed}`])).rows[0].id;
    const conversation = (await owner.query('INSERT INTO conversations(account_id,user_id,contact_id,whatsapp_config_id) VALUES($1,$2,$3,$4) RETURNING id', [accountA, adminA, contact, middle])).rows[0].id;
    const liveOnMiddle = await addFlow(accountA, adminA, 'active', middle);
    const draftOnMiddle = await addFlow(accountA, adminA, 'draft', middle);
    const liveOnAll = await addFlow(accountA, adminA, 'active', null);
    const liveOnNewest = await addFlow(accountA, adminA, 'active', newest);
    const scheduledOnMiddle = await addCampaign(accountA, adminA, 'scheduled', middle);
    const apiOnMiddle = await addCampaign(accountA, adminA, 'sent', middle, 'api');
    const sentOnMiddle = await addCampaign(accountA, adminA, 'sent', middle);
    const scheduledOnNewest = await addCampaign(accountA, adminA, 'scheduled', newest);

    // An agent and another workspace cannot disconnect it.
    expect(await withTenant(asAgentA, (tx) => disconnectNumber(tx, accountA, middle))).toBeNull();
    expect(await withTenant(asB, (tx) => disconnectNumber(tx, accountA, middle))).toBeNull();
    expect(await withTenant(asAdminA, (tx) => disconnectNumber(tx, accountA, 'not-a-uuid'))).toBeNull();
    expect(await numberRow(middle)).toMatchObject({ status: 'connected', is_default: true });

    const result = await withTenant(asAdminA, (tx) => disconnectNumber(tx, accountA, middle, adminA));
    expect(result).toMatchObject({ newDefaultId: oldest, pausedFlows: 1 });
    expect(result?.heldCampaigns.map((c) => c.id).sort()).toEqual([scheduledOnMiddle, apiOnMiddle].sort());
    // The row stays, with its token gone; nothing points anywhere else.
    expect(await numberRow(middle)).toEqual({ status: 'disconnected', access_token: '', is_default: false });
    expect(await campaignRow(scheduledOnMiddle)).toEqual({ status: 'scheduled', whatsapp_config_id: middle });
    expect(await campaignRow(apiOnMiddle)).toEqual({ status: 'sent', whatsapp_config_id: middle });
    expect(await campaignRow(sentOnMiddle)).toEqual({ status: 'sent', whatsapp_config_id: middle });
    expect(await campaignRow(scheduledOnNewest)).toEqual({ status: 'scheduled', whatsapp_config_id: newest });
    // Why is recorded, attributed to the admin.
    const audit = (await owner.query(
      "SELECT action, user_id, resource_id, metadata FROM audit_logs WHERE account_id=$1 AND action IN ('broadcast.held','broadcast.cancelled','whatsapp_number.disconnected') ORDER BY action, resource_id",
      [accountA],
    )).rows;
    expect(audit.some((r) => r.action === 'broadcast.cancelled')).toBe(false);
    expect(audit.filter((r) => r.action === 'broadcast.held').map((r) => r.resource_id).sort()).toEqual([scheduledOnMiddle, apiOnMiddle].sort());
    expect(audit.every((r) => r.user_id === adminA)).toBe(true);
    expect(audit.find((r) => r.action === 'broadcast.held')?.metadata).toMatchObject({ reason: 'whatsapp_number_disconnected', whatsapp_config_id: middle });
    expect(audit.find((r) => r.action === 'whatsapp_number.disconnected')).toMatchObject({
      resource_id: middle, metadata: { new_default_id: oldest, paused_flows: 1, held_campaigns: 2 },
    });
    expect(await flowRow(liveOnMiddle)).toEqual({ status: 'draft', whatsapp_config_id: middle });
    expect(await flowRow(draftOnMiddle)).toEqual({ status: 'draft', whatsapp_config_id: middle });
    expect(await flowStatus(liveOnAll)).toBe('active');
    expect(await flowStatus(liveOnNewest)).toBe('active');
    // History stays on its own number.
    expect((await owner.query('SELECT whatsapp_config_id FROM conversations WHERE id=$1', [conversation])).rows[0].whatsapp_config_id).toBe(middle);
    expect((await withTenant(asAgentA, (tx) => getNumberConfig(tx, accountA))).id).toBe(oldest);
    const listed = await withTenant(asAgentA, (tx) => listNumbers(tx, accountA));
    expect(listed.map((n) => [n.id, n.status, n.removed])).toEqual([
      [oldest, 'connected', false], [middle, 'disconnected', true], [newest, 'connected', false],
    ]);
    // A disconnected number cannot become the default.
    await expect(withTenant(asAdminA, (tx) => setDefaultNumber(tx, accountA, middle))).rejects.toMatchObject({ reason: 'disconnected' });

    // Removing a non-default number leaves the default alone and holds its campaign.
    expect(await withTenant(asAdminA, (tx) => disconnectNumber(tx, accountA, newest))).toMatchObject({ newDefaultId: null, pausedFlows: 1 });
    expect((await campaignRow(scheduledOnNewest)).status).toBe('scheduled');
    // Removing the last connected number leaves the workspace with no default and no fallback.
    expect(await withTenant(asAdminA, (tx) => disconnectNumber(tx, accountA, oldest))).toEqual({ newDefaultId: null, pausedFlows: 0, heldCampaigns: [] });
    expect((await withTenant(asAdminA, (tx) => listNumbers(tx, accountA))).every((n) => n.removed && !n.is_default)).toBe(true);
    await expect(withTenant(asAgentA, (tx) => getNumberConfig(tx, accountA))).rejects.toMatchObject({ reason: 'none' });
    // Disconnecting again is harmless.
    expect(await withTenant(asAdminA, (tx) => disconnectNumber(tx, accountA, oldest))).toEqual({ newDefaultId: null, pausedFlows: 0, heldCampaigns: [] });
    // Workspace B is untouched throughout.
    expect((await owner.query('SELECT is_default, status FROM whatsapp_config WHERE account_id=$1', [accountB])).rows).toEqual([{ is_default: true, status: 'connected' }]);
  });

  it('disconnects two numbers sharing a contact in turn, with a legacy unnumbered thread, and refuses every send', async () => {
    const asAdminC: TenantContext = { accountId: accountC, userId: adminC, role: 'admin' };
    const db = createAdminClient({ accountId: accountC, role: 'owner' });
    // A legacy thread from before the workspace had a number keeps no number.
    const contact = (await owner.query("INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$3,'Shared contact') RETURNING id", [accountC, adminC, `+1415555${seed.slice(-4)}`])).rows[0].id;
    const legacy = (await owner.query('INSERT INTO conversations(account_id,user_id,contact_id) VALUES($1,$2,$3) RETURNING id, whatsapp_config_id', [accountC, adminC, contact])).rows[0];
    expect(legacy.whatsapp_config_id).toBeNull();
    const x = await addNumber(accountC, adminC, `71${seed}`, '2026-01-01T00:00:00Z');
    const y = await addNumber(accountC, adminC, `72${seed}`, '2026-02-01T00:00:00Z');
    expect((await numberRow(x)).is_default).toBe(true);
    const convX = (await owner.query('INSERT INTO conversations(account_id,user_id,contact_id,whatsapp_config_id) VALUES($1,$2,$3,$4) RETURNING id', [accountC, adminC, contact, x])).rows[0].id;
    const convY = (await owner.query('INSERT INTO conversations(account_id,user_id,contact_id,whatsapp_config_id) VALUES($1,$2,$3,$4) RETURNING id', [accountC, adminC, contact, y])).rows[0].id;
    // A finished campaign on Y with a failed recipient, and one still scheduled on Y.
    const sentOnY = await addCampaign(accountC, adminC, 'sent', y);
    await owner.query("INSERT INTO broadcast_recipients(account_id,broadcast_id,contact_id,status) VALUES($1,$2,$3,'failed')", [accountC, sentOnY, contact]);
    const scheduledOnY = await addCampaign(accountC, adminC, 'scheduled', y);
    const intentsBefore = (await owner.query('SELECT count(*)::int AS n FROM outbound_intents WHERE account_id=$1', [accountC])).rows[0].n;

    // Y first, then X: before soft disconnect the second one hit the unique index (23505).
    expect(await withTenant(asAdminC, (tx) => disconnectNumber(tx, accountC, y, adminC))).toMatchObject({ newDefaultId: null });
    expect(await withTenant(asAdminC, (tx) => disconnectNumber(tx, accountC, x, adminC))).toMatchObject({ newDefaultId: null });
    const threads = (await owner.query('SELECT id, whatsapp_config_id FROM conversations WHERE account_id=$1 ORDER BY id', [accountC])).rows;
    expect(Object.fromEntries(threads.map((r) => [r.id, r.whatsapp_config_id]))).toEqual({ [legacy.id]: null, [convX]: x, [convY]: y });
    expect((await campaignRow(scheduledOnY)).status).toBe('scheduled');

    // Agent replies, flow/automation steps, AI replies, new campaigns and resumes are all refused.
    for (const conversationId of [convX, convY]) {
      await expect(sendMessageToConversation(db, accountC, { conversationId, messageType: 'text', contentText: 'hello' }))
        .rejects.toMatchObject({ code: 'whatsapp_number_disconnected', status: 409 });
      await expect(loadAccountMetaCredentials(db, accountC, conversationId)).rejects.toThrow(/disconnected/i);
      expect(await conversationNumberDisconnected(db, accountC, conversationId)).toBe(true);
    }
    // The legacy thread falls back to the default, and there is none: refused, never another number.
    const legacySend = await sendMessageToConversation(db, accountC, { conversationId: legacy.id, messageType: 'text', contentText: 'hello' })
      .then(() => null, (error: { code?: string }) => error.code);
    expect(['whatsapp_not_configured', 'whatsapp_number_unavailable']).toContain(legacySend);
    await expect(planBroadcastResume(db, accountC, sentOnY, 'failed')).rejects.toMatchObject({ code: 'whatsapp_number_disconnected' });
    await expect(createBroadcast(db, accountC, adminC, { templateName: 'promo', whatsappConfigId: y, recipients: [{ to: '+14155550199' }] }))
      .rejects.toMatchObject({ code: 'whatsapp_number_disconnected' });
    expect((await owner.query('SELECT count(*)::int AS n FROM outbound_intents WHERE account_id=$1', [accountC])).rows[0].n).toBe(intentsBefore);
    expect((await owner.query("SELECT status FROM broadcast_recipients WHERE broadcast_id=$1", [sentOnY])).rows).toEqual([{ status: 'failed' }]);

    // Reconnecting X (what the connect POST and Embedded Signup write) revives the same row as the default.
    await withTenant(asAdminC, (tx) => tx.whatsapp_config.updateMany({
      where: { account_id: accountC, id: x },
      data: { access_token: encrypt('test-only-token-2'), status: 'connected', connected_at: new Date() },
    }));
    expect(await numberRow(x)).toMatchObject({ status: 'connected', is_default: true });
    expect((await withTenant(asAdminC, (tx) => getNumberConfig(tx, accountC))).id).toBe(x);
    expect(await loadAccountMetaCredentials(db, accountC, convX)).toMatchObject({ configId: x, accessToken: 'test-only-token-2' });
    expect(await conversationNumberDisconnected(db, accountC, convX)).toBe(false);
    // Y stays disconnected: its thread and campaigns are not moved to X.
    await expect(loadAccountMetaCredentials(db, accountC, convY)).rejects.toThrow(/disconnected/i);
    await expect(planBroadcastResume(db, accountC, sentOnY, 'failed')).rejects.toMatchObject({ code: 'whatsapp_number_disconnected' });

    // A brand-new number connected while no default exists becomes the default.
    await withTenant(asAdminC, (tx) => disconnectNumber(tx, accountC, x, adminC));
    const z = await addNumber(accountC, adminC, `73${seed}`, '2026-03-01T00:00:00Z');
    expect((await numberRow(z)).is_default).toBe(true);
    expect((await numberRow(x)).is_default).toBe(false);
  });

  it('report says what changed for the reset path', async () => {
    const asAdminC: TenantContext = { accountId: accountC, userId: adminC, role: 'admin' };
    const z = (await owner.query('SELECT id FROM whatsapp_config WHERE account_id=$1 AND is_default', [accountC])).rows[0].id;
    const report = await withTenant(asAdminC, (tx) => disconnectAndReport(tx, accountC, z, adminC));
    expect(report).toMatchObject({ newDefault: null, noDefaultLeft: true, result: { heldCampaigns: [] } });
  });
});
