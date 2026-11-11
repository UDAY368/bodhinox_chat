// Instagram Phase 3 (Stage 4A) schema on PostgreSQL: conversation reminders and
// snooze, scheduled replies, the Instagram connection kind and the Share-to-Story
// trigger. Checks defaults, CHECK constraints, column grants for the app and
// worker roles, the role rules, the forward-only status guards (the worker
// included, so a reply is never sent twice), the worker-only due-account
// functions, and that RLS keeps each workspace to its own rows.
//
// Connection settings come only from the environment (TEST_DATABASE_URL,
// TEST_APP_DATABASE_URL, TEST_WORKER_DATABASE_URL), as test-db-local.cjs sets
// them; the suite is skipped without them and refuses a non-test database.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';

const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const adminUser = randomUUID(), agentUser = randomUUID(), agent2User = randomUUID(), viewerUser = randomUUID(), ownerUserB = randomUUID();
const adminA: TenantContext = { accountId: accountA, userId: adminUser, role: 'admin' };
const agentA: TenantContext = { accountId: accountA, userId: agentUser, role: 'agent' };
const agent2A: TenantContext = { accountId: accountA, userId: agent2User, role: 'agent' };
const viewerA: TenantContext = { accountId: accountA, userId: viewerUser, role: 'viewer' };
const ownerB: TenantContext = { accountId: accountB, userId: ownerUserB, role: 'owner' };
const workerA: TenantContext = { accountId: accountA, role: 'owner' };
const workerB: TenantContext = { accountId: accountB, role: 'owner' };
const asWorker = <T>(context: TenantContext, op: (tx: TenantTransaction) => Promise<T>) => withTenant(context, op, getWorkerPrisma());

const hours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();
const days = (n: number) => hours(n * 24);
const digits = () => `${Date.now()}${Math.floor(Math.random() * 1e6)}`.slice(0, 18);

let owner: pg.Client;
const ids = { convA: '', convA2: '', convB: '', igA: '', igB: '' };
/** A contact and a conversation for it, made as the table owner. */
const newConversation = async (account: string, user: string) => {
  const contact = (await owner.query<{ id: string }>("INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$3,'Phase 3') RETURNING id",
    [account, user, `+1555${digits()}`])).rows[0].id;
  return (await owner.query<{ id: string }>('INSERT INTO conversations(account_id,user_id,contact_id) VALUES($1,$2,$3) RETURNING id',
    [account, user, contact])).rows[0].id;
};

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Instagram Phase 3 schema on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string; role: string }[]>`SELECT current_database() AS name, current_user AS role`;
    if (!/test/i.test(app[0].name) || app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'IG phase 3 test', 'test-only-hash' FROM unnest($1::uuid[]) x",
      [[adminUser, agentUser, agent2User, viewerUser, ownerUserB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'IG phase 3 A',$2),($3,'IG phase 3 B',$4)", [accountA, adminUser, accountB, ownerUserB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'agent'),($1,$4,'agent'),($1,$5,'viewer'),($6,$7,'owner')",
      [accountA, adminUser, agentUser, agent2User, viewerUser, accountB, ownerUserB]);
    ids.convA = await newConversation(accountA, adminUser);
    ids.convA2 = await newConversation(accountA, adminUser);
    ids.convB = await newConversation(accountB, ownerUserB);
    const ig = (account: string, user: string) => owner.query<{ id: string }>(`INSERT INTO instagram_accounts(account_id,ig_user_id,username,access_token_enc,connected_by_user_id)
      VALUES($1,$2,'phase3','enc-test-only-token',$3) RETURNING id`, [account, digits(), user]).then((r) => r.rows[0].id);
    ids.igA = await ig(accountA, adminUser);
    ids.igB = await ig(accountB, ownerUserB);
    // convA2 is an Instagram conversation (scheduled replies take their channel from it).
    await owner.query("UPDATE conversations SET channel='instagram', instagram_account_id=$1 WHERE id=$2", [ids.igA, ids.convA2]);
  });

  afterAll(async () => {
    if (owner) {
      // The live Instagram accounts and their placeholder tokens must not reach later suites (token sweep, ingest).
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[adminUser, agentUser, agent2User, viewerUser, ownerUserB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  describe('conversation reminders', () => {
    // Columns the app role may not set (status, created_at, fired_at) are added only when a test names them.
    const insert = (context: TenantContext, over: { conv?: string; user?: string; at?: string; kind?: string; note?: string | null; status?: string; extra?: Record<string, string> } = {}) => {
      const cols: Record<string, unknown> = {
        account_id: context.accountId, conversation_id: over.conv ?? ids.convA, user_id: over.user ?? context.userId,
        kind: over.kind ?? 'reminder', remind_at: over.at ?? hours(2), note: over.note ?? null,
        ...(over.status ? { status: over.status } : {}), ...over.extra,
      };
      const names = Object.keys(cols);
      return withTenant(context, (tx) => tx.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO conversation_reminders(${names.join(',')}) VALUES(${names.map((n, i) => `$${i + 1}${n === 'remind_at' || n === 'created_at' ? '::timestamptz' : n.endsWith('_id') ? '::uuid' : ''}`).join(',')}) RETURNING id`,
        ...Object.values(cols))).then((rows) => rows[0].id);
    };
    const reminder = { agent: '', snooze: '', b: '' };

    it('lets an agent create a reminder as themselves, with defaults', async () => {
      reminder.agent = await insert(agentA, { note: 'Call back about the quote' });
      const row = (await owner.query('SELECT kind, status, fired_at FROM conversation_reminders WHERE id=$1', [reminder.agent])).rows[0];
      expect(row).toEqual({ kind: 'reminder', status: 'pending', fired_at: null });
      reminder.b = await insert(ownerB, { conv: ids.convB });
    });

    it('refuses viewers, another person’s name, a pre-set status, bad kinds, long notes and times over a year ahead', async () => {
      await expect(insert(viewerA)).rejects.toThrow(/row-level security|permission denied/);
      await expect(insert(agentA, { user: agent2User })).rejects.toThrow(/row-level security/);
      await expect(insert(agentA, { status: 'fired' })).rejects.toThrow(/permission denied/);
      // created_at anchors the year cap, so the app cannot set it to push the cap out.
      await expect(insert(agentA, { at: days(400), extra: { created_at: days(200) } })).rejects.toThrow(/permission denied/);
      await expect(insert(agentA, { kind: 'alarm' })).rejects.toThrow(/check/);
      await expect(insert(agentA, { note: 'x'.repeat(501) })).rejects.toThrow(/check/);
      await expect(insert(agentA, { at: days(367) })).rejects.toThrow(/check/);
      // Another workspace's conversation is refused by the composite foreign key.
      await expect(insert(agentA, { conv: ids.convB })).rejects.toThrow(/foreign key/);
    });

    it('lets members read their workspace’s reminders and nobody else’s', async () => {
      const seen = (context: TenantContext) => withTenant(context, (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id FROM conversation_reminders`)
        .then((rows) => rows.map((r) => r.id));
      expect(await seen(agentA)).toEqual([reminder.agent]);
      expect(await seen(viewerA)).toEqual([reminder.agent]);
      expect(await seen(ownerB)).toEqual([reminder.b]);
    });

    it('lets the owner of a reminder change its time, note and status only; others and other workspaces change nothing', async () => {
      expect(await withTenant(agentA, (tx) => tx.$executeRaw`UPDATE conversation_reminders SET remind_at=${hours(5)}::timestamptz,
        note='Later' WHERE id=${reminder.agent}::uuid`)).toBe(1);
      // Not their row: admins and other agents see it but change nothing; other workspaces do not see it.
      expect(await withTenant(adminA, (tx) => tx.$executeRaw`UPDATE conversation_reminders SET note='x' WHERE id=${reminder.agent}::uuid`)).toBe(0);
      expect(await withTenant(agent2A, (tx) => tx.$executeRaw`UPDATE conversation_reminders SET note='x' WHERE id=${reminder.agent}::uuid`)).toBe(0);
      expect(await withTenant(ownerB, (tx) => tx.$executeRaw`UPDATE conversation_reminders SET note='x' WHERE id=${reminder.agent}::uuid`)).toBe(0);
      // Only three columns, and never the fired state or another person's name.
      await expect(withTenant(agentA, (tx) => tx.$executeRaw`UPDATE conversation_reminders SET kind='snooze' WHERE id=${reminder.agent}::uuid`))
        .rejects.toThrow(/permission denied/);
      await expect(withTenant(agentA, (tx) => tx.$executeRaw`UPDATE conversation_reminders SET user_id=${agent2User}::uuid
        WHERE id=${reminder.agent}::uuid`)).rejects.toThrow(/permission denied/);
      await expect(withTenant(agentA, (tx) => tx.$executeRaw`UPDATE conversation_reminders SET status='fired' WHERE id=${reminder.agent}::uuid`))
        .rejects.toThrow(/row-level security|check constraint/);
      await expect(withTenant(agentA, (tx) => tx.$executeRaw`DELETE FROM conversation_reminders WHERE id=${reminder.agent}::uuid`))
        .rejects.toThrow(/permission denied/);
      expect((await owner.query('SELECT note FROM conversation_reminders WHERE id=$1', [reminder.agent])).rows[0].note).toBe('Later');
    });

    it('allows one pending snooze per conversation and person, and a new one after it ends', async () => {
      reminder.snooze = await insert(agentA, { conv: ids.convA2, kind: 'snooze' });
      await expect(insert(agentA, { conv: ids.convA2, kind: 'snooze' })).rejects.toThrow(/duplicate key|conversation_reminders_one_snooze/);
      // Another person may snooze the same conversation; a plain reminder is not limited.
      await insert(agent2A, { conv: ids.convA2, kind: 'snooze' });
      await insert(agentA, { conv: ids.convA2 });
      expect(await withTenant(agentA, (tx) => tx.$executeRaw`UPDATE conversation_reminders SET status='cancelled' WHERE id=${reminder.snooze}::uuid`)).toBe(1);
      await insert(agentA, { conv: ids.convA2, kind: 'snooze' });
    });

    it('moves status forward only, for the worker too, and fixes a decided reminder', async () => {
      // pending -> dismissed by the owner; then it cannot return to pending or change.
      expect(await withTenant(agentA, (tx) => tx.$executeRaw`UPDATE conversation_reminders SET status='dismissed' WHERE id=${reminder.agent}::uuid`)).toBe(1);
      await expect(withTenant(agentA, (tx) => tx.$executeRaw`UPDATE conversation_reminders SET status='pending' WHERE id=${reminder.agent}::uuid`))
        .rejects.toThrow(/conversation_reminder_status_transition/);
      await expect(withTenant(agentA, (tx) => tx.$executeRaw`UPDATE conversation_reminders SET remind_at=${hours(9)}::timestamptz
        WHERE id=${reminder.agent}::uuid`)).rejects.toThrow(/conversation_reminder_fixed/);
      await expect(asWorker(workerA, (tx) => tx.$executeRaw`UPDATE conversation_reminders SET status='fired', fired_at=now()
        WHERE id=${reminder.agent}::uuid`)).rejects.toThrow(/conversation_reminder_status_transition/);
    });

    it('lets the worker fire a due reminder once, and only the worker learns which workspaces have one due', async () => {
      const due = (await owner.query<{ id: string }>(`INSERT INTO conversation_reminders(account_id,conversation_id,user_id,remind_at)
        VALUES($1,$2,$3,now() - interval '1 minute') RETURNING id`, [accountA, ids.convA, agentUser])).rows[0].id;
      const accounts = await asWorker(workerA, (tx) => tx.$queryRaw<{ account_id: string }[]>`SELECT account_id FROM crm_due_conversation_reminder_accounts()`);
      expect(accounts.map((r) => r.account_id)).toContain(accountA);
      expect(accounts.map((r) => r.account_id)).not.toContain(accountB);
      await expect(withTenant(agentA, (tx) => tx.$queryRaw`SELECT account_id FROM crm_due_conversation_reminder_accounts()`)).rejects.toThrow(/permission denied/);
      // Another workspace's worker cannot fire it; this one can, once.
      expect(await asWorker(workerB, (tx) => tx.$executeRaw`UPDATE conversation_reminders SET status='fired', fired_at=now() WHERE id=${due}::uuid`)).toBe(0);
      expect(await asWorker(workerA, (tx) => tx.$executeRaw`UPDATE conversation_reminders SET status='fired', fired_at=now() WHERE id=${due}::uuid`)).toBe(1);
      // A fired reminder can still be dismissed by its owner.
      expect(await withTenant(agentA, (tx) => tx.$executeRaw`UPDATE conversation_reminders SET status='dismissed' WHERE id=${due}::uuid`)).toBe(1);
    });

    it('drops reminders with their conversation', async () => {
      const conv = await newConversation(accountA, adminUser);
      await owner.query('INSERT INTO conversation_reminders(account_id,conversation_id,user_id,remind_at) VALUES($1,$2,$3,now() + interval \'1 hour\')',
        [accountA, conv, agentUser]);
      await owner.query('DELETE FROM conversations WHERE id=$1', [conv]);
      expect((await owner.query('SELECT count(*)::int AS n FROM conversation_reminders WHERE conversation_id=$1', [conv])).rows[0].n).toBe(0);
    });
  });

  describe('scheduled replies', () => {
    const insert = (context: TenantContext, over: { conv?: string; channel?: string; at?: string; content?: string; status?: string; by?: string; extra?: Record<string, string> } = {}) => {
      const cols: Record<string, unknown> = {
        account_id: context.accountId, conversation_id: over.conv ?? ids.convA, channel: over.channel ?? 'whatsapp',
        created_by_user_id: over.by ?? context.userId, content: over.content ?? 'Following up on your order', send_at: over.at ?? hours(3),
        ...(over.status ? { status: over.status } : {}), ...over.extra,
      };
      const names = Object.keys(cols);
      return withTenant(context, (tx) => tx.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO scheduled_replies(${names.join(',')}) VALUES(${names.map((n, i) => `$${i + 1}${n === 'send_at' || n === 'created_at' ? '::timestamptz' : n.endsWith('_id') ? '::uuid' : ''}`).join(',')}) RETURNING id`,
        ...Object.values(cols))).then((rows) => rows[0].id);
    };
    const reply = { a: '', ig: '', b: '' };
    const status = async (id: string) => (await owner.query<{ status: string }>('SELECT status FROM scheduled_replies WHERE id=$1', [id])).rows[0].status;

    it('lets an agent queue a reply as themselves; the row exists before anything else happens', async () => {
      reply.a = await insert(agentA);
      reply.ig = await insert(agentA, { conv: ids.convA2, channel: 'instagram', at: days(6) });
      reply.b = await insert(ownerB, { conv: ids.convB });
      const row = (await owner.query('SELECT status, attempts, claimed_at, message_id FROM scheduled_replies WHERE id=$1', [reply.a])).rows[0];
      expect(row).toEqual({ status: 'pending', attempts: 0, claimed_at: null, message_id: null });
    });

    it('refuses viewers, another person’s name, a pre-set status, empty or long text and times beyond the channel limit', async () => {
      await expect(insert(viewerA)).rejects.toThrow(/row-level security|permission denied/);
      await expect(insert(agentA, { by: agent2User })).rejects.toThrow(/row-level security/);
      await expect(insert(agentA, { status: 'sent' })).rejects.toThrow(/permission denied/);
      // created_at anchors the 7 and 30 day caps, so the app cannot set it; nor the worker's columns.
      await expect(insert(agentA, { channel: 'instagram', conv: ids.convA2, at: days(20), extra: { created_at: days(15) } })).rejects.toThrow(/permission denied/);
      await expect(insert(agentA, { extra: { reason_code: 'window_closed' } })).rejects.toThrow(/permission denied/);
      await expect(insert(agentA, { content: '   ' })).rejects.toThrow(/check/);
      await expect(insert(agentA, { content: 'x'.repeat(4097) })).rejects.toThrow(/check/);
      await expect(insert(agentA, { channel: 'sms' })).rejects.toThrow(/check/);
      await expect(insert(agentA, { at: days(31) })).rejects.toThrow(/check/);
      // Instagram: the 7-day Human Agent ceiling.
      await expect(insert(agentA, { channel: 'instagram', conv: ids.convA2, at: days(8) })).rejects.toThrow(/check/);
      // The channel is the conversation's: neither side can claim the other's cap.
      await expect(insert(agentA, { channel: 'whatsapp', conv: ids.convA2, at: days(20) })).rejects.toThrow(/scheduled_reply_channel_mismatch/);
      await expect(insert(agentA, { channel: 'instagram', at: hours(3) })).rejects.toThrow(/scheduled_reply_channel_mismatch/);
      await expect(insert(agentA, { conv: ids.convB })).rejects.toThrow(/foreign key/);
    });

    it('lets members read their workspace’s scheduled replies and nobody else’s', async () => {
      const seen = (context: TenantContext) => withTenant(context, (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id FROM scheduled_replies`)
        .then((rows) => rows.map((r) => r.id).sort());
      expect(await seen(viewerA)).toEqual([reply.a, reply.ig].sort());
      expect(await seen(ownerB)).toEqual([reply.b]);
    });

    it('lets the creator or an admin change text and time or cancel while pending; no one else', async () => {
      expect(await withTenant(agentA, (tx) => tx.$executeRaw`UPDATE scheduled_replies SET content='Updated', send_at=${hours(4)}::timestamptz
        WHERE id=${reply.a}::uuid`)).toBe(1);
      expect(await withTenant(agent2A, (tx) => tx.$executeRaw`UPDATE scheduled_replies SET content='Mine now' WHERE id=${reply.a}::uuid`)).toBe(0);
      expect(await withTenant(viewerA, (tx) => tx.$executeRaw`UPDATE scheduled_replies SET content='x' WHERE id=${reply.a}::uuid`)).toBe(0);
      expect(await withTenant(ownerB, (tx) => tx.$executeRaw`UPDATE scheduled_replies SET content='x' WHERE id=${reply.a}::uuid`)).toBe(0);
      // Only three columns; the app never sends, claims or deletes.
      await expect(withTenant(agentA, (tx) => tx.$executeRaw`UPDATE scheduled_replies SET attempts=5 WHERE id=${reply.a}::uuid`)).rejects.toThrow(/permission denied/);
      await expect(withTenant(agentA, (tx) => tx.$executeRaw`UPDATE scheduled_replies SET channel='instagram' WHERE id=${reply.a}::uuid`)).rejects.toThrow(/permission denied/);
      await expect(withTenant(agentA, (tx) => tx.$executeRaw`UPDATE scheduled_replies SET status='sending' WHERE id=${reply.a}::uuid`)).rejects.toThrow(/row-level security|check constraint/);
      await expect(withTenant(agentA, (tx) => tx.$executeRaw`UPDATE scheduled_replies SET status='sent' WHERE id=${reply.a}::uuid`)).rejects.toThrow(/row-level security|check constraint/);
      await expect(withTenant(agentA, (tx) => tx.$executeRaw`DELETE FROM scheduled_replies WHERE id=${reply.a}::uuid`)).rejects.toThrow(/permission denied/);
      expect(await withTenant(adminA, (tx) => tx.$executeRaw`UPDATE scheduled_replies SET status='cancelled' WHERE id=${reply.ig}::uuid`)).toBe(1);
      // Once cancelled it is no longer pending, so nobody changes it again.
      expect(await withTenant(adminA, (tx) => tx.$executeRaw`UPDATE scheduled_replies SET content='again' WHERE id=${reply.ig}::uuid`)).toBe(0);
      expect(await status(reply.ig)).toBe('cancelled');
    });

    it('sends once: the worker claims, then records sent; nothing returns to pending or edits what was queued', async () => {
      // A direct pending -> sent is refused: a send goes through the claim.
      await expect(asWorker(workerA, (tx) => tx.$executeRaw`UPDATE scheduled_replies SET status='sent', message_id=${randomUUID()}::uuid,
        sent_at=now() WHERE id=${reply.a}::uuid`)).rejects.toThrow(/scheduled_reply_status_transition/);
      // Another workspace's worker cannot claim it.
      expect(await asWorker(workerB, (tx) => tx.$executeRaw`UPDATE scheduled_replies SET status='sending', claimed_at=now(), attempts=1
        WHERE id=${reply.a}::uuid`)).toBe(0);
      // A claim records its time.
      await expect(asWorker(workerA, (tx) => tx.$executeRaw`UPDATE scheduled_replies SET status='sending' WHERE id=${reply.a}::uuid`)).rejects.toThrow(/check/);
      expect(await asWorker(workerA, (tx) => tx.$executeRaw`UPDATE scheduled_replies SET status='sending', claimed_at=now(), attempts=attempts+1
        WHERE id=${reply.a}::uuid`)).toBe(1);
      // A re-claim after a crash keeps the status; the text and time are fixed; the status never goes back.
      expect(await asWorker(workerA, (tx) => tx.$executeRaw`UPDATE scheduled_replies SET claimed_at=now(), attempts=attempts+1 WHERE id=${reply.a}::uuid`)).toBe(1);
      await expect(asWorker(workerA, (tx) => tx.$executeRaw`UPDATE scheduled_replies SET content='changed' WHERE id=${reply.a}::uuid`)).rejects.toThrow(/scheduled_reply_fixed/);
      await expect(asWorker(workerA, (tx) => tx.$executeRaw`UPDATE scheduled_replies SET send_at=${hours(1)}::timestamptz WHERE id=${reply.a}::uuid`)).rejects.toThrow(/scheduled_reply_fixed/);
      await expect(asWorker(workerA, (tx) => tx.$executeRaw`UPDATE scheduled_replies SET status='pending' WHERE id=${reply.a}::uuid`)).rejects.toThrow(/scheduled_reply_status_transition/);
      // A sent row needs its message.
      await expect(asWorker(workerA, (tx) => tx.$executeRaw`UPDATE scheduled_replies SET status='sent' WHERE id=${reply.a}::uuid`)).rejects.toThrow(/check/);
      expect(await asWorker(workerA, (tx) => tx.$executeRaw`UPDATE scheduled_replies SET status='sent', message_id=${randomUUID()}::uuid, sent_at=now()
        WHERE id=${reply.a}::uuid`)).toBe(1);
      for (const back of ['pending', 'sending', 'failed', 'unknown'])
        await expect(asWorker(workerA, (tx) => tx.$executeRaw`UPDATE scheduled_replies SET status=${back} WHERE id=${reply.a}::uuid`), back).rejects.toThrow();
    });

    it('keeps an ambiguous send for reconciliation: unknown ends only as sent or failed', async () => {
      const id = await insert(agentA, { conv: ids.convA2 });
      expect(await asWorker(workerA, (tx) => tx.$executeRaw`UPDATE scheduled_replies SET status='sending', claimed_at=now(), attempts=1 WHERE id=${id}::uuid`)).toBe(1);
      expect(await asWorker(workerA, (tx) => tx.$executeRaw`UPDATE scheduled_replies SET status='unknown', reason_code='send_failed' WHERE id=${id}::uuid`)).toBe(1);
      for (const bad of ['pending', 'sending', 'cancelled', 'skipped'])
        await expect(asWorker(workerA, (tx) => tx.$executeRaw`UPDATE scheduled_replies SET status=${bad} WHERE id=${id}::uuid`), bad).rejects.toThrow(/scheduled_reply_status_transition/);
      // The app role never touches it, and a reason is a machine code only.
      expect(await withTenant(adminA, (tx) => tx.$executeRaw`UPDATE scheduled_replies SET status='cancelled' WHERE id=${id}::uuid`)).toBe(0);
      await expect(asWorker(workerA, (tx) => tx.$executeRaw`UPDATE scheduled_replies SET reason_code='The customer wrote: hello' WHERE id=${id}::uuid`)).rejects.toThrow(/check/);
      expect(await asWorker(workerA, (tx) => tx.$executeRaw`UPDATE scheduled_replies SET status='failed', reason_code='send_failed' WHERE id=${id}::uuid`)).toBe(1);
    });

    it('lets the worker skip a pending reply with a reason, and learn which workspaces have one due', async () => {
      const id = (await owner.query<{ id: string }>(`INSERT INTO scheduled_replies(account_id,conversation_id,channel,content,send_at)
        VALUES($1,$2,'instagram','Hello',now() - interval '1 minute') RETURNING id`, [accountA, ids.convA2])).rows[0].id;
      const accounts = await asWorker(workerA, (tx) => tx.$queryRaw<{ account_id: string }[]>`SELECT account_id FROM crm_due_scheduled_reply_accounts()`);
      expect(accounts.map((r) => r.account_id)).toContain(accountA);
      expect(accounts.map((r) => r.account_id)).not.toContain(accountB);
      await expect(withTenant(agentA, (tx) => tx.$queryRaw`SELECT account_id FROM crm_due_scheduled_reply_accounts()`)).rejects.toThrow(/permission denied/);
      expect(await asWorker(workerA, (tx) => tx.$executeRaw`UPDATE scheduled_replies SET status='skipped', reason_code='window_closed' WHERE id=${id}::uuid`)).toBe(1);
      expect(await status(id)).toBe('skipped');
    });

    it('drops scheduled replies with their conversation', async () => {
      const conv = await newConversation(accountA, adminUser);
      await owner.query("INSERT INTO scheduled_replies(account_id,conversation_id,channel,content,send_at) VALUES($1,$2,'whatsapp','Hi',now() + interval '1 hour')",
        [accountA, conv]);
      await owner.query('DELETE FROM conversations WHERE id=$1', [conv]);
      expect((await owner.query('SELECT count(*)::int AS n FROM scheduled_replies WHERE conversation_id=$1', [conv])).rows[0].n).toBe(0);
    });
  });

  describe('Instagram connection kind', () => {
    it('defaults to the Instagram login and reads through the app column grant, with the token still hidden', async () => {
      const rows = await withTenant(agentA, (tx) => tx.$queryRaw<{ connection_kind: string; facebook_page_id: string | null }[]>`
        SELECT connection_kind, facebook_page_id FROM instagram_accounts`);
      expect(rows).toEqual([{ connection_kind: 'instagram_login', facebook_page_id: null }]);
      await expect(withTenant(adminA, (tx) => tx.$queryRaw`SELECT access_token_enc FROM instagram_accounts`)).rejects.toThrow(/permission denied/);
      // Browser roles never write the kind; only the worker (the connect paths) does.
      await expect(withTenant(adminA, (tx) => tx.$executeRaw`UPDATE instagram_accounts SET connection_kind='facebook_page'`)).rejects.toThrow(/permission denied/);
    });

    it('requires a numeric Page id for a Page connection and none for the Instagram login', async () => {
      const set = (kind: string, page: string | null) => asWorker(workerA, (tx) => tx.$executeRaw`UPDATE instagram_accounts
        SET connection_kind=${kind}, facebook_page_id=${page} WHERE id=${ids.igA}::uuid`);
      await expect(set('facebook_page', null)).rejects.toThrow(/instagram_accounts_facebook_page_check/);
      await expect(set('facebook_page', 'abc')).rejects.toThrow(/instagram_accounts_facebook_page_check/);
      await expect(set('instagram_login', '123')).rejects.toThrow(/instagram_accounts_facebook_page_check/);
      await expect(set('whatsapp', null)).rejects.toThrow(/instagram_accounts_connection_kind_check|instagram_accounts_facebook_page_check/);
      expect(await set('facebook_page', '100200300')).toBe(1);
      const seen = await withTenant(agentA, (tx) => tx.$queryRaw<{ connection_kind: string; facebook_page_id: string }[]>`
        SELECT connection_kind, facebook_page_id FROM instagram_accounts`);
      expect(seen).toEqual([{ connection_kind: 'facebook_page', facebook_page_id: '100200300' }]);
      // Another workspace's worker cannot change A's connection.
      expect(await asWorker(workerB, (tx) => tx.$executeRaw`UPDATE instagram_accounts SET connection_kind='instagram_login', facebook_page_id=NULL
        WHERE id=${ids.igA}::uuid`)).toBe(0);
      expect(await set('instagram_login', null)).toBe(1);
    });

    it('has both checks validated', async () => {
      const rows = (await owner.query<{ name: string; valid: boolean }>(`SELECT conname AS name, convalidated AS valid FROM pg_constraint
        WHERE conname IN ('instagram_accounts_connection_kind_check','instagram_accounts_facebook_page_check') ORDER BY 1`)).rows;
      expect(rows).toEqual([{ name: 'instagram_accounts_connection_kind_check', valid: true }, { name: 'instagram_accounts_facebook_page_check', valid: true }]);
    });
  });

  it('accepts the Share-to-Story trigger (validated) and still nothing unknown', async () => {
    const def = (await owner.query<{ def: string; valid: boolean }>(
      "SELECT pg_get_constraintdef(oid) AS def, convalidated AS valid FROM pg_constraint WHERE conname='flows_trigger_type_check'")).rows[0];
    expect(def.def).toContain("'ig_share_to_story'");
    expect(def.valid).toBe(true);
    await owner.query(`INSERT INTO flows(account_id,user_id,name,trigger_type,trigger_config,channel_scope)
      VALUES($1,$2,'Share','ig_share_to_story','{"frequency":"every_time"}','instagram')`, [accountA, adminUser]);
    await expect(owner.query("INSERT INTO flows(account_id,user_id,name,trigger_type) VALUES($1,$2,'Bad','ig_not_a_trigger')", [accountA, adminUser]))
      .rejects.toThrow(/flows_trigger_type_check/);
  });
});
