import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { notifyAssignedMessage } from './emit';
import { getNotificationPreferences, saveNotificationPreferences } from './preferences';
import { sendNotificationDigest, type DigestMessage } from './digest';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const adminA = randomUUID(), agentA = randomUUID(), agent2A = randomUUID(), viewerA = randomUUID(), ownerB = randomUUID();
const asAgent: TenantContext = { accountId: accountA, userId: agentA, role: 'agent' };
const asViewer: TenantContext = { accountId: accountA, userId: viewerA, role: 'viewer' };
const asB: TenantContext = { accountId: accountB, userId: ownerB, role: 'owner' };
const asWorkerA: TenantContext = { accountId: accountA, role: 'owner' };
const seed = String(Date.now()).slice(-9);
const SECRET_TEXT = 'customer secret: card 4111';
let owner: pg.Client;
let contactA = '';
let convAgent = '';
let convAgent2 = '';

async function contact(suffix: string): Promise<string> {
  return (await owner.query("INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$3,'Asha') RETURNING id",
    [accountA, adminA, `9197${seed}${suffix}`])).rows[0].id;
}
async function conversationFor(contactId: string, assignee: string | null): Promise<string> {
  return (await owner.query('INSERT INTO conversations(account_id,user_id,contact_id,assigned_agent_id) VALUES($1,$2,$3,$4) RETURNING id',
    [accountA, adminA, contactId, assignee])).rows[0].id;
}
const worker = <T>(op: Parameters<typeof withTenant<T>>[1]) => withTenant(asWorkerA, op, getWorkerPrisma());
const alert = (conversationId: string) =>
  worker((tx) => notifyAssignedMessage(tx, { accountId: accountA, conversationId, contactId: contactA, messageId: randomUUID() }));

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('notification emit, preferences and digest on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    const users = [adminA, agentA, agent2A, viewerA, ownerB];
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Notify test', 'test-only-hash' FROM unnest($1::uuid[]) x", [users]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Notify A',$2),($3,'Notify B',$4)", [accountA, adminA, accountB, ownerB]);
    await owner.query(`INSERT INTO account_memberships(account_id,user_id,role) VALUES
      ($1,$2,'admin'),($1,$3,'agent'),($1,$4,'agent'),($1,$5,'viewer'),($6,$7,'owner')`,
      [accountA, adminA, agentA, agent2A, viewerA, accountB, ownerB]);
    await owner.query(`INSERT INTO profiles(user_id,full_name,email,account_id,account_role) VALUES
      ($1,'Agent','agent-${seed}@example.invalid',$2,'agent'),($3,'Agent 2','agent2-${seed}@example.invalid',$2,'agent')`,
      [agentA, accountA, agent2A]);
    contactA = await contact('1');
    convAgent = await conversationFor(contactA, agentA);
    convAgent2 = await conversationFor(await contact('2'), agent2A);
  });

  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[adminA, agentA, agent2A, viewerA, ownerB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('lets each member, viewers included, manage only their own preferences', async () => {
    expect((await getNotificationPreferences(asViewer)).every((p) => p.in_app && !p.email)).toBe(true);
    const saved = await saveNotificationPreferences(asAgent, [{ event: 'assigned_message', in_app: false, email: true }]);
    expect(saved.find((p) => p.event === 'assigned_message')).toEqual({ event: 'assigned_message', in_app: false, email: true, push: false });
    await saveNotificationPreferences(asViewer, [{ event: 'mention', in_app: true, email: true }]);
    // The agent's choice is not the viewer's.
    expect((await getNotificationPreferences(asViewer)).find((p) => p.event === 'assigned_message')).toMatchObject({ in_app: true, email: false });
    await expect(withTenant(asAgent, (tx) => tx.$executeRaw`INSERT INTO notification_preferences(account_id,user_id,event,in_app,email)
      VALUES(${accountA}::uuid,${viewerA}::uuid,'sla_breach',false,false)`)).rejects.toThrow();
    expect(await withTenant(asAgent, (tx) => tx.$executeRaw`UPDATE notification_preferences SET email=false WHERE user_id=${viewerA}::uuid`)).toBe(0);
    // Another workspace sees none of them.
    expect(await withTenant(asB, (tx) => tx.$queryRaw`SELECT 1 FROM notification_preferences`)).toHaveLength(0);
  });

  it('alerts the assignee by their preference and debounces per conversation', async () => {
    // agent: in-app off, email on (set above); agent2: defaults (in-app only).
    expect(await alert(convAgent)).toEqual({ inApp: [], emailQueued: [agentA] });
    expect(await alert(convAgent)).toEqual({ inApp: [], emailQueued: [] });
    expect(await alert(convAgent2)).toEqual({ inApp: [agent2A], emailQueued: [] });
    expect(await alert(convAgent2)).toEqual({ inApp: [], emailQueued: [] });
    // Once the window has passed, the next message alerts again.
    await owner.query("UPDATE notifications SET created_at=now()-interval '6 minutes' WHERE account_id=$1 AND conversation_id=$2", [accountA, convAgent2]);
    expect(await alert(convAgent2)).toEqual({ inApp: [agent2A], emailQueued: [] });
    const rows = (await owner.query("SELECT type, link, body FROM notifications WHERE account_id=$1 AND user_id=$2 AND type='assigned_message'", [accountA, agent2A])).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ type: 'assigned_message', link: `/inbox?c=${convAgent2}`, body: null });
  });

  it('skips unassigned conversations', async () => {
    const unassigned = await conversationFor(await contact('3'), null);
    expect(await alert(unassigned)).toEqual({ inApp: [], emailQueued: [] });
  });

  it('emails one digest of titles and links per member, once, never bodies', async () => {
    Object.assign(process.env, { SMTP_URL: 'smtp://localhost:2525', AUTH_EMAIL_FROM: 'no-reply@example.invalid', APP_URL: 'https://app.example.invalid' });
    // A second entry with a body that must never be emailed, and one already read in the app.
    await owner.query(`INSERT INTO notification_email_queue(account_id,user_id,event,title,body,link) VALUES($1,$2,'mention','Priya mentioned you',$3,'/inbox?c=x')`,
      [accountA, agentA, SECRET_TEXT]);
    await saveNotificationPreferences(asAgent, [{ event: 'mention', in_app: true, email: true }]);
    const readId = randomUUID();
    await owner.query(`INSERT INTO notifications(id,account_id,user_id,type,title,read_at) VALUES($1,$2,$3,'mention','Read already',now())`, [readId, accountA, agentA]);
    await owner.query(`INSERT INTO notification_email_queue(account_id,user_id,event,notification_id,title) VALUES($1,$2,'mention',$3,'Read already')`, [accountA, agentA, readId]);

    const sent: DigestMessage[] = [];
    const result = await sendNotificationDigest(accountA, { send: async (message) => { sent.push(message); } });
    expect(result).toMatchObject({ status: 'done', claimed: 3, sent: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(`agent-${seed}@example.invalid`);
    expect(sent[0].subject).toBe('2 new notifications in Bodhinox');
    expect(sent[0].text).toContain('New message in a conversation assigned to you');
    expect(sent[0].text).toContain(`https://app.example.invalid/inbox?c=${convAgent}`);
    expect(sent[0].text).toContain('Priya mentioned you');
    expect(sent[0].text).not.toContain(SECRET_TEXT);
    expect(sent[0].text).not.toContain('Read already');
    const pending = await owner.query('SELECT count(*)::int AS n FROM notification_email_queue WHERE account_id=$1 AND sent_at IS NULL', [accountA]);
    expect(pending.rows[0].n).toBe(0);
    // Nothing left: a retry or the next window sends nothing again.
    expect(await sendNotificationDigest(accountA, { send: async (message) => { sent.push(message); } })).toMatchObject({ claimed: 0 });
    expect(sent).toHaveLength(1);
    // The app role cannot read the digest queue at all.
    await expect(withTenant(asAgent, (tx) => tx.$queryRaw`SELECT 1 FROM notification_email_queue`)).rejects.toThrow();
  });
});
