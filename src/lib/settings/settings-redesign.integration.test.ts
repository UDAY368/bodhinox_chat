// Settings redesign on PostgreSQL: workspace name and default language (admin-only,
// tenant-scoped, audited), each member's own language and quiet hours, browser push
// subscriptions (own rows only), the push queue (claimed once, quiet hours honoured)
// and the audit log search and CSV export (admins only, one workspace).
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { exportAuditLogCsv, listAuditLog } from '@/lib/audit/audit-log';
import { notifyAssignedMessage } from '@/lib/notifications/emit';
import { saveNotificationPreferences } from '@/lib/notifications/preferences';
import { sendNotificationPushes } from '@/lib/notifications/push-delivery';
import { deletePushSubscription, savePushSubscription } from '@/lib/notifications/push-subscriptions';
import { getMemberPreferences, saveMemberLanguage, writeQuietHours } from './member-preferences';
import { getWorkspaceSettings, saveWorkspaceSettings } from './workspace-settings';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const adminA = randomUUID(), agentA = randomUUID(), ownerB = randomUUID();
const asAdmin: TenantContext = { accountId: accountA, userId: adminA, role: 'admin' };
const asAgent: TenantContext = { accountId: accountA, userId: agentA, role: 'agent' };
const asB: TenantContext = { accountId: accountB, userId: ownerB, role: 'owner' };
const seed = String(Date.now()).slice(-9);
const FCM = `https://fcm.googleapis.com/fcm/send/${seed}`;
const keys = { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') };
let owner: pg.Client;

function vapid() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pub = publicKey.export({ format: 'jwk' });
  process.env.VAPID_PUBLIC_KEY = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x!, 'base64url'), Buffer.from(pub.y!, 'base64url')]).toString('base64url');
  process.env.VAPID_PRIVATE_KEY = privateKey.export({ format: 'jwk' }).d!;
  process.env.VAPID_SUBJECT = 'mailto:ops@example.invalid';
}

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('settings redesign on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Settings test', 'test-only-hash' FROM unnest($1::uuid[]) x",
      [[adminA, agentA, ownerB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Settings A',$2),($3,'Settings B',$4)", [accountA, adminA, accountB, ownerB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'agent'),($4,$5,'owner')",
      [accountA, adminA, agentA, accountB, ownerB]);
    vapid();
  });

  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[adminA, agentA, ownerB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('lets an admin rename the workspace and set its language, audited, and nobody else', async () => {
    const saved = await saveWorkspaceSettings(asAdmin, { name: 'Renamed A', default_language: 'es' });
    expect(saved).toEqual({ name: 'Renamed A', default_language: 'es' });
    expect(await getWorkspaceSettings(asAgent)).toEqual(saved);
    // RLS: an agent's UPDATE touches no row.
    await expect(saveWorkspaceSettings(asAgent, { name: 'Agent rename' })).rejects.toThrow();
    // Workspace B is untouched and unseen.
    expect((await getWorkspaceSettings(asB)).name).toBe('Settings B');
    const audit = await owner.query("SELECT metadata FROM audit_logs WHERE account_id=$1 AND action='settings.workspace'", [accountA]);
    expect(audit.rows).toHaveLength(1);
    expect(JSON.stringify(audit.rows[0].metadata)).not.toContain('Renamed A');
  });

  it('keeps each member’s language and quiet hours to themselves', async () => {
    await saveMemberLanguage(asAgent, 'ko');
    await withTenant(asAgent, (tx) => writeQuietHours(tx, accountA, agentA,
      { enabled: true, start: 0, end: 1439, time_zone: 'UTC', allow_mentions: false }));
    expect(await getMemberPreferences(asAgent)).toMatchObject({ language: 'ko', quiet_hours: { enabled: true, allow_mentions: false } });
    expect((await getMemberPreferences(asAdmin)).language).toBeNull();
    // A member cannot write another member's row, nor a row in another workspace.
    await expect(withTenant(asAgent, (tx) => writeQuietHours(tx, accountA, adminA,
      { enabled: true, start: 0, end: 60, time_zone: 'UTC', allow_mentions: true }))).rejects.toThrow();
    await expect(withTenant(asAgent, (tx) => writeQuietHours(tx, accountB, agentA,
      { enabled: true, start: 0, end: 60, time_zone: 'UTC', allow_mentions: true }))).rejects.toThrow();
  });

  it('stores push devices per member and never shows them to anyone else', async () => {
    await savePushSubscription(asAgent, { endpoint: FCM, ...keys });
    const seenByAdmin = await withTenant(asAdmin, (tx) => tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM push_subscriptions`);
    expect(seenByAdmin[0].n).toBe(0);
    const seenByB = await withTenant(asB, (tx) => tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM push_subscriptions`);
    expect(seenByB[0].n).toBe(0);
    expect(await deletePushSubscription(asAdmin, FCM)).toBe(false);
  });

  it('queues push beside the in-app row and holds it until quiet hours end', async () => {
    await saveNotificationPreferences(asAgent, [{ event: 'assigned_message', in_app: true, email: false, push: true }]);
    const contact = (await owner.query("INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$3,'Asha') RETURNING id",
      [accountA, adminA, `9198${seed}1`])).rows[0].id;
    const conversation = (await owner.query('INSERT INTO conversations(account_id,user_id,contact_id,assigned_agent_id) VALUES($1,$2,$3,$4) RETURNING id',
      [accountA, adminA, contact, agentA])).rows[0].id;
    await withTenant({ accountId: accountA, role: 'owner' }, (tx) => notifyAssignedMessage(tx,
      { accountId: accountA, conversationId: conversation, contactId: contact, messageId: randomUUID() }), getWorkerPrisma());
    const queued = await owner.query('SELECT count(*)::int AS n FROM notification_push_queue WHERE account_id=$1 AND sent_at IS NULL', [accountA]);
    expect(queued.rows[0].n).toBe(1);
    const calls: string[] = [];
    // The agent is inside quiet hours that end in two hours: nothing is sent, the entry waits unclaimed until they end.
    const minute = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
    await owner.query('UPDATE member_preferences SET quiet_enabled=true, quiet_start=$3, quiet_end=$4, quiet_time_zone=$5 WHERE account_id=$1 AND user_id=$2',
      [accountA, agentA, (minute + 1440 - 60) % 1440, (minute + 120) % 1440, 'UTC']);
    const quiet = await sendNotificationPushes(accountA, { fetch: async (url) => { calls.push(url); return { status: 201 }; } });
    expect(quiet).toMatchObject({ status: 'done', claimed: 0, sent: 0, held: 1 });
    expect(calls).toEqual([]);
    const held = (await owner.query('SELECT outcome, sent_at, not_before FROM notification_push_queue WHERE account_id=$1', [accountA])).rows[0];
    expect(held).toMatchObject({ outcome: null, sent_at: null });
    expect(held.not_before.getTime()).toBeGreaterThan(Date.now());
    // Not due yet: a retry reads nothing, and the scheduler does not list the workspace.
    expect(await sendNotificationPushes(accountA, { fetch: async () => ({ status: 201 }) })).toMatchObject({ claimed: 0, held: 0 });
    const due = await getWorkerPrisma().$queryRaw<{ account_id: string }[]>`SELECT * FROM crm_accounts_with_pending_notification_push()`;
    expect(due.map((r) => r.account_id)).not.toContain(accountA);
    // Once the quiet hours are over it is claimed (once) and settled.
    await owner.query('UPDATE member_preferences SET quiet_enabled=false WHERE account_id=$1', [accountA]);
    const released = await sendNotificationPushes(accountA, { now: new Date(held.not_before.getTime() + 60_000), fetch: async () => ({ status: 201 }) });
    expect(released).toMatchObject({ claimed: 1, held: 0 });
    expect((await owner.query('SELECT outcome FROM notification_push_queue WHERE account_id=$1', [accountA])).rows[0].outcome).not.toBeNull();
    expect(await sendNotificationPushes(accountA, { now: new Date(held.not_before.getTime() + 120_000), fetch: async () => ({ status: 201 }) }))
      .toMatchObject({ claimed: 0 });
    // The app role cannot read the push queue at all.
    await expect(withTenant(asAgent, (tx) => tx.$queryRaw`SELECT 1 FROM notification_push_queue`)).rejects.toThrow();
  });

  it('searches and exports only this workspace’s audit log, for admins', async () => {
    await owner.query(`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata) VALUES
      ($1,$2,'team.created','t1','{"members":2}'),($3,$4,'team.created','t2','{"members":9}')`, [accountA, adminA, accountB, ownerB]);
    const page = await listAuditLog(asAdmin, { q: 'team', category: 'team', limit: 50 });
    expect(page.entries.map((e) => e.resource_id)).toEqual(['t1']);
    const csv = await exportAuditLogCsv(asAdmin, { category: 'team' });
    expect(csv.rows).toBe(1);
    expect(csv.csv).toContain('"t1"');
    expect(csv.csv).not.toContain('"t2"');
    // RLS: an agent reads no audit rows.
    expect((await listAuditLog(asAgent, { limit: 50 })).entries).toEqual([]);
  });
});
