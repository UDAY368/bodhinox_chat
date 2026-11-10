import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { createNotification } from './notify';
import { messageSearchVector } from './message-search';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const adminA = randomUUID(), agentA = randomUUID(), agent2A = randomUUID(), viewerA = randomUUID(), ownerB = randomUUID();
const outsider = randomUUID();
const asAdmin: TenantContext = { accountId: accountA, userId: adminA, role: 'admin' };
const asAgent: TenantContext = { accountId: accountA, userId: agentA, role: 'agent' };
const asAgent2: TenantContext = { accountId: accountA, userId: agent2A, role: 'agent' };
const asViewer: TenantContext = { accountId: accountA, userId: viewerA, role: 'viewer' };
const asB: TenantContext = { accountId: accountB, userId: ownerB, role: 'owner' };
const asWorkerA: TenantContext = { accountId: accountA, role: 'owner' };
const seed = String(Date.now()).slice(-9);
let owner: pg.Client;
let contactA = '';
let conversationA = '';
let quickReplyA = '';

const app = <T>(context: TenantContext, op: Parameters<typeof withTenant<T>>[1]) => withTenant(context, op);
const worker = <T>(context: TenantContext, op: Parameters<typeof withTenant<T>>[1]) => withTenant(context, op, getWorkerPrisma());

async function conversation(id: string) {
  return (await owner.query(
    `SELECT status, lifecycle_state, assigned_agent_id, first_response_due_at, first_responded_at, resolved_at, reopened_count, reopened_at
     FROM conversations WHERE id=$1`, [id])).rows[0];
}

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('inbox premium tables on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Inbox test', 'test-only-hash' FROM unnest($1::uuid[]) x",
      [[adminA, agentA, agent2A, viewerA, ownerB, outsider]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Inbox A',$2),($3,'Inbox B',$4)", [accountA, adminA, accountB, ownerB]);
    await owner.query(`INSERT INTO account_memberships(account_id,user_id,role) VALUES
      ($1,$2,'admin'),($1,$3,'agent'),($1,$4,'agent'),($1,$5,'viewer'),($6,$7,'owner')`,
      [accountA, adminA, agentA, agent2A, viewerA, accountB, ownerB]);
    contactA = (await owner.query("INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$3,'Asha') RETURNING id", [accountA, adminA, `9198${seed}`])).rows[0].id;
    conversationA = (await owner.query('INSERT INTO conversations(account_id,user_id,contact_id) VALUES($1,$2,$3) RETURNING id', [accountA, adminA, contactA])).rows[0].id;
    quickReplyA = (await owner.query("INSERT INTO quick_replies(account_id,user_id,title,content_text) VALUES($1,$2,'Hi','Hello') RETURNING id", [accountA, adminA])).rows[0].id;
  });

  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[adminA, agentA, agent2A, viewerA, ownerB, outsider]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  describe('workspace inbox settings', () => {
    it('lets admins write and every member read, inside the account only', async () => {
      await expect(app(asAgent, (tx) => tx.$executeRaw`INSERT INTO workspace_inbox_settings(account_id) VALUES(${accountA}::uuid)`)).rejects.toThrow();
      await app(asAdmin, (tx) => tx.$executeRaw`INSERT INTO workspace_inbox_settings(account_id,timezone,working_hours,sla_first_response_minutes)
        VALUES(${accountA}::uuid,'Asia/Kolkata','{"mon":[{"start":"09:00","end":"18:00"}]}'::jsonb,30)`);
      const read = await app(asViewer, (tx) => tx.$queryRaw<{ timezone: string }[]>`SELECT timezone FROM workspace_inbox_settings`);
      expect(read).toEqual([{ timezone: 'Asia/Kolkata' }]);
      expect(await app(asB, (tx) => tx.$queryRaw`SELECT 1 FROM workspace_inbox_settings`)).toHaveLength(0);
      await expect(app(asAdmin, (tx) => tx.$executeRaw`UPDATE workspace_inbox_settings SET auto_resolve_after_hours=721`)).rejects.toThrow();
      await expect(app(asAdmin, (tx) => tx.$executeRaw`UPDATE workspace_inbox_settings SET away_message_enabled=true`)).rejects.toThrow();
    });
  });

  describe('conversation lifecycle', () => {
    it('derives the state from status and assignee and stamps SLA, resolve and reopen', async () => {
      const id = (await owner.query('INSERT INTO conversations(account_id,user_id,contact_id,whatsapp_config_id) VALUES($1,$2,$3,NULL) RETURNING id',
        [accountA, adminA, (await owner.query("INSERT INTO contacts(account_id,user_id,phone) VALUES($1,$2,$3) RETURNING id", [accountA, adminA, `9197${seed}`])).rows[0].id])).rows[0].id;
      let row = await conversation(id);
      expect(row.lifecycle_state).toBe('requesting');
      // Creating a conversation does not start the clock; the customer's first message does.
      expect(row.first_response_due_at).toBeNull();
      await owner.query("INSERT INTO messages(account_id,conversation_id,sender_type,content_text) VALUES($1,$2,'customer','hi')", [accountA, id]);
      row = await conversation(id);
      expect(row.first_response_due_at).not.toBeNull();

      await app(asAgent, (tx) => tx.$executeRaw`UPDATE conversations SET assigned_agent_id=${agentA}::uuid WHERE id=${id}::uuid`);
      expect((await conversation(id)).lifecycle_state).toBe('assigned');

      // A bot reply is not a first response; an agent's is.
      await app(asAgent, (tx) => tx.$executeRaw`INSERT INTO messages(conversation_id,sender_type,content_text) VALUES(${id}::uuid,'bot','auto')`);
      expect((await conversation(id)).first_responded_at).toBeNull();
      await app(asAgent, (tx) => tx.$executeRaw`INSERT INTO messages(conversation_id,sender_type,sender_id,content_text) VALUES(${id}::uuid,'agent',${agentA}::uuid,'hi')`);
      const responded = (await conversation(id)).first_responded_at;
      expect(responded).not.toBeNull();
      await app(asAgent, (tx) => tx.$executeRaw`INSERT INTO messages(conversation_id,sender_type,sender_id,content_text) VALUES(${id}::uuid,'agent',${agentA}::uuid,'again')`);
      expect((await conversation(id)).first_responded_at).toEqual(responded);

      await app(asAgent, (tx) => tx.$executeRaw`UPDATE conversations SET status='closed' WHERE id=${id}::uuid`);
      row = await conversation(id);
      expect(row).toMatchObject({ lifecycle_state: 'resolved', reopened_count: 0, reopened_at: null });
      expect(row.resolved_at).not.toBeNull();

      // Re-opening (as reopenClosedConversation does) starts a new cycle.
      await app(asAgent, (tx) => tx.$executeRaw`UPDATE conversations SET status='open' WHERE id=${id}::uuid`);
      row = await conversation(id);
      expect(row).toMatchObject({ lifecycle_state: 'assigned', reopened_count: 1, resolved_at: null, first_responded_at: null });
      expect(row.first_response_due_at).not.toBeNull();
      // The new cycle's start is stamped, so its resolution can be timed.
      const reopenedAt: Date = row.reopened_at;
      expect(reopenedAt).toBeInstanceOf(Date);

      // Writing lifecycle_state drives status; unassigning moves to requesting.
      await app(asAgent, (tx) => tx.$executeRaw`UPDATE conversations SET lifecycle_state='resolved' WHERE id=${id}::uuid`);
      expect((await conversation(id)).status).toBe('closed');
      await app(asAgent, (tx) => tx.$executeRaw`UPDATE conversations SET lifecycle_state='requesting', assigned_agent_id=NULL WHERE id=${id}::uuid`);
      row = await conversation(id);
      expect(row).toMatchObject({ status: 'open', lifecycle_state: 'requesting', reopened_count: 2 });
      expect(row.reopened_at.getTime()).toBeGreaterThanOrEqual(reopenedAt.getTime());

      // A bot conversation becomes requesting when the bot is paused.
      await app(asAgent, (tx) => tx.$executeRaw`UPDATE conversations SET lifecycle_state='bot' WHERE id=${id}::uuid`);
      expect((await conversation(id)).lifecycle_state).toBe('bot');
      await app(asAgent, (tx) => tx.$executeRaw`UPDATE conversations SET bot_paused=true WHERE id=${id}::uuid`);
      expect((await conversation(id)).lifecycle_state).toBe('requesting');
      await expect(app(asAgent, (tx) => tx.$executeRaw`UPDATE conversations SET lifecycle_state='waiting' WHERE id=${id}::uuid`)).rejects.toThrow();
    });
  });

  describe('conversation notes', () => {
    let noteId = '';
    it('lets agents add their own notes and every member read them', async () => {
      await expect(app(asViewer, (tx) => tx.$executeRaw`INSERT INTO conversation_notes(conversation_id,author_id,body)
        VALUES(${conversationA}::uuid,${viewerA}::uuid,'viewer note')`)).rejects.toThrow();
      await expect(app(asAgent, (tx) => tx.$executeRaw`INSERT INTO conversation_notes(conversation_id,author_id,body)
        VALUES(${conversationA}::uuid,${agent2A}::uuid,'forged author')`)).rejects.toThrow();
      await expect(app(asAgent, (tx) => tx.$executeRaw`INSERT INTO conversation_notes(conversation_id,author_id,body)
        VALUES(${conversationA}::uuid,${agentA}::uuid,'')`)).rejects.toThrow();
      noteId = randomUUID();
      await app(asAgent, (tx) => tx.$executeRaw`INSERT INTO conversation_notes(id,conversation_id,author_id,body,mentions)
        VALUES(${noteId}::uuid,${conversationA}::uuid,${agentA}::uuid,'Customer prefers mornings',ARRAY[${agent2A}::uuid])`);
      const seen = await app(asViewer, (tx) => tx.$queryRaw<{ body: string }[]>`SELECT body FROM conversation_notes WHERE id=${noteId}::uuid`);
      expect(seen).toEqual([{ body: 'Customer prefers mornings' }]);
      expect(await app(asB, (tx) => tx.$queryRaw`SELECT 1 FROM conversation_notes`)).toHaveLength(0);
    });

    it('lets only the author edit, and admins soft-delete', async () => {
      expect(await app(asAgent2, (tx) => tx.$executeRaw`UPDATE conversation_notes SET body='hijack' WHERE id=${noteId}::uuid`)).toBe(0);
      await expect(app(asAdmin, (tx) => tx.$executeRaw`UPDATE conversation_notes SET body='admin edit' WHERE id=${noteId}::uuid`)).rejects.toThrow();
      expect(await app(asAgent, (tx) => tx.$executeRaw`UPDATE conversation_notes SET body='Prefers mornings' WHERE id=${noteId}::uuid`)).toBe(1);
      expect((await owner.query('SELECT edited_at FROM conversation_notes WHERE id=$1', [noteId])).rows[0].edited_at).not.toBeNull();
      await expect(app(asAgent, (tx) => tx.$executeRaw`UPDATE conversation_notes SET author_id=${agent2A}::uuid WHERE id=${noteId}::uuid`)).rejects.toThrow();
      await expect(app(asAdmin, (tx) => tx.$executeRaw`DELETE FROM conversation_notes WHERE id=${noteId}::uuid`)).rejects.toThrow();
      expect(await app(asAdmin, (tx) => tx.$executeRaw`UPDATE conversation_notes SET deleted_at=now() WHERE id=${noteId}::uuid`)).toBe(1);
      expect(await app(asAgent, (tx) => tx.$executeRaw`UPDATE conversation_notes SET body='undelete', deleted_at=NULL WHERE id=${noteId}::uuid`)).toBe(0);
    });
  });

  describe('routing rules', () => {
    it('lets admins write, members read and the worker move only the rotation cursor', async () => {
      const assign = JSON.stringify({ mode: 'round_robin', user_ids: [agentA, agent2A] });
      await expect(app(asAgent, (tx) => tx.$executeRaw`INSERT INTO routing_rules(name,assign_to) VALUES('VIP',${assign}::jsonb)`)).rejects.toThrow();
      await expect(app(asAdmin, (tx) => tx.$executeRaw`INSERT INTO routing_rules(name,assign_to) VALUES('Bad','{"mode":"random"}'::jsonb)`)).rejects.toThrow();
      const id = randomUUID();
      await app(asAdmin, (tx) => tx.$executeRaw`INSERT INTO routing_rules(id,name,assign_to,conditions,reassign_after_minutes)
        VALUES(${id}::uuid,'VIP',${assign}::jsonb,'{"keywords_any":["refund"]}'::jsonb,15)`);
      expect(await app(asViewer, (tx) => tx.$queryRaw`SELECT 1 FROM routing_rules`)).toHaveLength(1);
      expect(await worker(asWorkerA, (tx) => tx.$executeRaw`UPDATE routing_rules SET round_robin_last_user_id=${agentA}::uuid WHERE id=${id}::uuid`)).toBe(1);
      await expect(worker(asWorkerA, (tx) => tx.$executeRaw`UPDATE routing_rules SET name='renamed' WHERE id=${id}::uuid`)).rejects.toThrow();
      const sweep = await getWorkerPrisma().$queryRaw<{ account_id: string }[]>`SELECT account_id::text FROM crm_accounts_for_inbox_sweep()`;
      expect(sweep.map((r) => r.account_id)).toContain(accountA);
      await expect(getPrisma().$queryRaw`SELECT * FROM crm_accounts_for_inbox_sweep()`).rejects.toThrow();
    });
  });

  describe('away message sends', () => {
    it('claims a window once, from the worker only', async () => {
      await expect(app(asAgent, (tx) => tx.$executeRaw`INSERT INTO away_message_sends(conversation_id,window_key)
        VALUES(${conversationA}::uuid,'open:2026-11-03T09:00')`)).rejects.toThrow();
      const claim = () => worker(asWorkerA, (tx) => tx.$executeRaw`INSERT INTO away_message_sends(conversation_id,window_key)
        VALUES(${conversationA}::uuid,'open:2026-11-03T09:00') ON CONFLICT DO NOTHING`);
      expect(await claim()).toBe(1);
      expect(await claim()).toBe(0);
    });
  });

  describe('per-member rows', () => {
    it('keeps saved filters private to their owner', async () => {
      await app(asAgent, (tx) => tx.$executeRaw`INSERT INTO saved_filters(user_id,name,filters) VALUES(${agentA}::uuid,'Mine','{"status":"open"}'::jsonb)`);
      await expect(app(asAgent, (tx) => tx.$executeRaw`INSERT INTO saved_filters(user_id,name) VALUES(${agent2A}::uuid,'Theirs')`)).rejects.toThrow();
      expect(await app(asAgent, (tx) => tx.$queryRaw`SELECT 1 FROM saved_filters`)).toHaveLength(1);
      expect(await app(asAgent2, (tx) => tx.$queryRaw`SELECT 1 FROM saved_filters`)).toHaveLength(0);
      expect(await app(asAdmin, (tx) => tx.$queryRaw`SELECT 1 FROM saved_filters`)).toHaveLength(0);
    });

    it('keeps quick-reply favourites per member and drops them with the reply', async () => {
      await app(asAgent, (tx) => tx.$executeRaw`INSERT INTO quick_reply_favourites(user_id,quick_reply_id) VALUES(${agentA}::uuid,${quickReplyA}::uuid)`);
      await expect(app(asAgent, (tx) => tx.$executeRaw`INSERT INTO quick_reply_favourites(user_id,quick_reply_id) VALUES(${agent2A}::uuid,${quickReplyA}::uuid)`)).rejects.toThrow();
      expect(await app(asAgent2, (tx) => tx.$queryRaw`SELECT 1 FROM quick_reply_favourites`)).toHaveLength(0);
      const extra = (await owner.query("INSERT INTO quick_replies(account_id,user_id,title,content_text) VALUES($1,$2,'Bye','Bye') RETURNING id", [accountA, adminA])).rows[0].id;
      await app(asAgent, (tx) => tx.$executeRaw`INSERT INTO quick_reply_favourites(user_id,quick_reply_id) VALUES(${agentA}::uuid,${extra}::uuid)`);
      await owner.query('DELETE FROM quick_replies WHERE id=$1', [extra]);
      expect(await app(asAgent, (tx) => tx.$queryRaw`SELECT 1 FROM quick_reply_favourites`)).toHaveLength(1);
    });

    it('lets members read preferences but write only their own', async () => {
      await app(asAgent2, (tx) => tx.$executeRaw`INSERT INTO notification_preferences(user_id,event,in_app,email) VALUES(${agent2A}::uuid,'mention',false,true)`);
      await expect(app(asAgent, (tx) => tx.$executeRaw`INSERT INTO notification_preferences(user_id,event) VALUES(${agent2A}::uuid,'sla_breach')`)).rejects.toThrow();
      expect(await app(asAgent, (tx) => tx.$executeRaw`UPDATE notification_preferences SET email=false WHERE user_id=${agent2A}::uuid`)).toBe(0);
      expect(await app(asAgent, (tx) => tx.$queryRaw`SELECT 1 FROM notification_preferences`)).toHaveLength(1);
      await expect(app(asAgent2, (tx) => tx.$executeRaw`INSERT INTO notification_preferences(user_id,event) VALUES(${agent2A}::uuid,'everything')`)).rejects.toThrow();
    });
  });

  describe('phone masking flag', () => {
    it('is admin-set and only for agents and viewers', async () => {
      expect(await app(asAgent, (tx) => tx.$executeRaw`UPDATE account_memberships SET mask_phone_numbers=true WHERE user_id=${agent2A}::uuid`)).toBe(0);
      expect(await app(asAdmin, (tx) => tx.$executeRaw`UPDATE account_memberships SET mask_phone_numbers=true WHERE user_id=${agentA}::uuid`)).toBe(1);
      await expect(app(asAdmin, (tx) => tx.$executeRaw`UPDATE account_memberships SET mask_phone_numbers=true WHERE user_id=${adminA}::uuid`)).rejects.toThrow();
      await expect(app(asAdmin, (tx) => tx.$executeRaw`UPDATE account_memberships SET role='owner' WHERE user_id=${agentA}::uuid`)).rejects.toThrow();
      expect(await app(asB, (tx) => tx.$executeRaw`UPDATE account_memberships SET mask_phone_numbers=true WHERE user_id=${agent2A}::uuid`)).toBe(0);
      const row = await app(asAgent, (tx) => tx.$queryRaw<{ mask_phone_numbers: boolean }[]>`
        SELECT mask_phone_numbers FROM account_memberships WHERE user_id=${agentA}::uuid`);
      expect(row).toEqual([{ mask_phone_numbers: true }]);
    });
  });

  describe('createNotification', () => {
    it('notifies other members as an agent, honouring preferences and dedupe', async () => {
      const send = () => app(asAgent, (tx) => createNotification(tx, {
        accountId: accountA, userIds: [agent2A, adminA, outsider, agentA], actorUserId: agentA, event: 'mention',
        title: 'Mentioned in a note', body: 'Customer prefers mornings', link: `/inbox?conversation=${conversationA}`,
        conversationId: conversationA, dedupeKey: `note:${seed}`,
      }));
      // agent2A turned in-app mentions off and email on (above); adminA has defaults.
      expect(await send()).toEqual({ inApp: [adminA], emailQueued: [agent2A] });
      expect(await send()).toEqual({ inApp: [], emailQueued: [] });
      const notices = await app(asAdmin, (tx) => tx.$queryRaw<{ type: string; link: string }[]>`SELECT type, link FROM notifications WHERE type='mention'`);
      expect(notices).toEqual([{ type: 'mention', link: `/inbox?conversation=${conversationA}` }]);
      expect(await app(asAgent2, (tx) => tx.$queryRaw`SELECT 1 FROM notifications WHERE type='mention'`)).toHaveLength(0);
      const queued = await worker(asWorkerA, (tx) => tx.$queryRaw<{ user_id: string }[]>`SELECT user_id::text FROM notification_email_queue`);
      expect(queued).toEqual([{ user_id: agent2A }]);
      await expect(app(asAgent, (tx) => tx.$queryRaw`SELECT 1 FROM notification_email_queue`)).rejects.toThrow();
      const pending = await getWorkerPrisma().$queryRaw<{ account_id: string }[]>`SELECT account_id::text FROM crm_accounts_with_pending_notification_email()`;
      expect(pending.map((r) => r.account_id)).toContain(accountA);
    });

    it('rejects external links at the database too', async () => {
      await expect(app(asAgent, (tx) => tx.$executeRaw`INSERT INTO notifications(user_id,type,title,link)
        VALUES(${adminA}::uuid,'mention','x','https://evil.example')`)).rejects.toThrow();
    });
  });

  describe('message search', () => {
    it('finds messages through the indexed expression, in the account only', async () => {
      await app(asAgent, (tx) => tx.$executeRaw`INSERT INTO messages(conversation_id,sender_type,content_text)
        VALUES(${conversationA}::uuid,'customer',${`Where is order ZX${seed}?`})`);
      const term = `zx${seed}`;
      const found = await app(asViewer, (tx) => tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM messages m WHERE ${messageSearchVector('m')} @@ websearch_to_tsquery('simple', ${term})`);
      expect(found).toEqual([{ n: 1 }]);
      const other = await app(asB, (tx) => tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM messages m WHERE ${messageSearchVector('m')} @@ websearch_to_tsquery('simple', ${term})`);
      expect(other).toEqual([{ n: 0 }]);
      const plan = await owner.query(`SET enable_seqscan=off; EXPLAIN SELECT 1 FROM messages m
        WHERE to_tsvector('simple'::regconfig, COALESCE(m.content_text, '')) @@ websearch_to_tsquery('simple', 'order')`);
      const text = (Array.isArray(plan) ? plan[1] : plan).rows.map((r: Record<string, string>) => r['QUERY PLAN']).join('\n');
      await owner.query('RESET enable_seqscan');
      expect(text).toContain('messages_search_idx');
    });
  });
});
