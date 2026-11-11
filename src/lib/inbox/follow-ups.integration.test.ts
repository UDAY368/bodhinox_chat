// Reminders and scheduled replies (Stage 4, 4D) on PostgreSQL: tenancy and role
// rules through the real RLS policies, the queue-before-acknowledgement write,
// and the worker's send path (one provider call per reply through the outbound
// intent, an ambiguous outcome surfaced and never re-sent, a recovered claim
// completing from its accepted intent). The provider call is mocked; nothing
// leaves the machine.
//
// Connection settings come only from the environment (TEST_DATABASE_URL,
// TEST_APP_DATABASE_URL, TEST_WORKER_DATABASE_URL), as test-db-local.cjs sets
// them; the suite is skipped without them and refuses a non-test database.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sendText = vi.hoisted(() => vi.fn());
vi.mock('@/lib/whatsapp/meta-api', async (original) => ({
  ...(await original<typeof import('@/lib/whatsapp/meta-api')>()),
  sendTextMessage: (...args: unknown[]) => sendText(...args),
}));
vi.mock('@/lib/flows/meta-send', async (original) => ({
  ...(await original<typeof import('@/lib/flows/meta-send')>()),
  conversationNumberDisconnected: async () => false,
  loadAccountMetaCredentials: async () => ({ phoneNumberId: 'pn-test', accessToken: 'token-test', configId: 'cfg', wabaId: null }),
}));

import { disconnectDatabases } from '@/lib/db/prisma';
import type { TenantContext } from '@/lib/db/tenant';
import {
  createReminder,
  listReminders,
  runDueReminders,
  updateReminder,
} from './reminders';
import {
  createScheduledReply,
  listScheduledReplies,
  reconcileScheduledReply,
  runScheduledReplies,
  updateScheduledReply,
} from './scheduled-replies';

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

const hoursFromNow = (n: number) => new Date(Date.now() + n * 3_600_000);
const digits = () => `${Date.now()}${Math.floor(Math.random() * 1e6)}`.slice(0, 18);
const code = (p: Promise<unknown>) => p.then(() => null, (e: { code?: string; meta?: { code?: string } }) => e.code ?? e.meta?.code ?? 'error');

let owner: pg.Client;
/** A contact and a conversation for it, with the customer's last message `lastCustomerHoursAgo` ago. */
async function conversation(account: string, user: string, lastCustomerHoursAgo: number | null): Promise<string> {
  const contact = (await owner.query<{ id: string }>("INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$3,'Follow up') RETURNING id",
    [account, user, `+1555${digits()}`])).rows[0].id;
  const id = (await owner.query<{ id: string }>('INSERT INTO conversations(account_id,user_id,contact_id) VALUES($1,$2,$3) RETURNING id',
    [account, user, contact])).rows[0].id;
  if (lastCustomerHoursAgo !== null)
    await owner.query("INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,message_id,created_at) VALUES($1,$2,'customer','text','hello',$3,$4)",
      [account, id, `wamid.in.${randomUUID()}`, hoursFromNow(-lastCustomerHoursAgo)]);
  return id;
}
/** Make a scheduled reply due (the app role cannot schedule into the past, the owner can move the time). */
const makeDue = (id: string) => owner.query("UPDATE scheduled_replies SET send_at = now() - interval '1 minute' WHERE id=$1", [id]);
const row = async (id: string) => (await owner.query('SELECT status, reason_code, message_id, attempts FROM scheduled_replies WHERE id=$1', [id])).rows[0];
const message = async (id: string | null) => (await owner.query('SELECT status, message_id, content_text, sender_type FROM messages WHERE id=$1', [id])).rows[0];

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('reminders and scheduled replies on PostgreSQL', { timeout: 120_000 }, () => {
  const ids = { open: '', openB: '', stale: '' };

  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Follow up test', 'test-only-hash' FROM unnest($1::uuid[]) x",
      [[adminUser, agentUser, agent2User, viewerUser, ownerUserB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Follow up A',$2),($3,'Follow up B',$4)", [accountA, adminUser, accountB, ownerUserB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'agent'),($1,$4,'agent'),($1,$5,'viewer'),($6,$7,'owner')",
      [accountA, adminUser, agentUser, agent2User, viewerUser, accountB, ownerUserB]);
    ids.open = await conversation(accountA, adminUser, 1);
    ids.stale = await conversation(accountA, adminUser, 48);
    ids.openB = await conversation(accountB, ownerUserB, 1);
  });

  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM outbound_intents WHERE account_id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[adminUser, agentUser, agent2User, viewerUser, ownerUserB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  beforeEach(() => { sendText.mockReset(); sendText.mockResolvedValue({ messageId: `wamid.out.${randomUUID()}` }); });

  describe('reminders', () => {
    const at = () => hoursFromNow(3);
    const state = { agent: '', snooze: '' };

    it('an agent sets a reminder as themselves; only they list it', async () => {
      const created = await createReminder(agentA, { conversationId: ids.open, kind: 'reminder', remindAt: at(), note: 'Call back' });
      state.agent = created.id;
      expect(created).toMatchObject({ user_id: agentUser, status: 'pending', note: 'Call back' });
      expect((await listReminders(agentA, { conversationId: ids.open })).map((r) => r.id)).toEqual([created.id]);
      expect(await listReminders(agent2A, { conversationId: ids.open })).toEqual([]);
      expect(await listReminders(ownerB, {})).toEqual([]);
    });

    it('viewers cannot set one, and another workspace’s conversation is not found', async () => {
      expect(await code(createReminder(viewerA, { conversationId: ids.open, kind: 'reminder', remindAt: at(), note: null }))).not.toBeNull();
      await expect(createReminder(agentA, { conversationId: ids.openB, kind: 'reminder', remindAt: at(), note: null }))
        .rejects.toMatchObject({ code: 'notFound' });
    });

    it('another member or workspace cannot change it; the owner can edit, then dismiss', async () => {
      await expect(updateReminder(agent2A, state.agent, { status: 'cancelled' })).rejects.toMatchObject({ code: 'notFound' });
      await expect(updateReminder(adminA, state.agent, { note: 'mine now' })).rejects.toMatchObject({ code: 'notFound' });
      await expect(updateReminder(ownerB, state.agent, { status: 'dismissed' })).rejects.toMatchObject({ code: 'notFound' });
      expect((await updateReminder(agentA, state.agent, { note: 'Call back before 5' })).note).toBe('Call back before 5');
    });

    it('a new snooze replaces the person’s earlier one: one pending snooze per conversation', async () => {
      const first = await createReminder(agentA, { conversationId: ids.stale, kind: 'snooze', remindAt: at(), note: null });
      const second = await createReminder(agentA, { conversationId: ids.stale, kind: 'snooze', remindAt: hoursFromNow(5), note: null });
      state.snooze = second.id;
      const pending = await listReminders(agentA, { conversationId: ids.stale, kind: 'snooze', status: 'pending' });
      expect(pending.map((r) => r.id)).toEqual([second.id]);
      expect((await owner.query('SELECT status FROM conversation_reminders WHERE id=$1', [first.id])).rows[0].status).toBe('cancelled');
    });

    it('the worker fires a due reminder once and notifies its owner once', async () => {
      await owner.query("UPDATE conversation_reminders SET remind_at = now() - interval '1 minute' WHERE id=$1", [state.agent]);
      expect(await runDueReminders(accountA)).toBe(1);
      expect(await runDueReminders(accountA)).toBe(0);
      expect((await owner.query('SELECT status, fired_at IS NOT NULL AS fired FROM conversation_reminders WHERE id=$1', [state.agent])).rows[0])
        .toEqual({ status: 'fired', fired: true });
      const notes = await owner.query('SELECT user_id, conversation_id FROM notifications WHERE dedupe_key=$1', [`reminder:${state.agent}`]);
      expect(notes.rows).toEqual([{ user_id: agentUser, conversation_id: ids.open }]);
      // Another workspace's worker run touches nothing of A's.
      expect(await runDueReminders(accountB)).toBe(0);
    });

    it('a fired reminder can be dismissed by its owner but no longer edited', async () => {
      await expect(updateReminder(agentA, state.agent, { note: 'late edit' })).rejects.toMatchObject({ code: 'notFound' });
      expect((await updateReminder(agentA, state.agent, { status: 'dismissed' })).status).toBe('dismissed');
    });
  });

  describe('scheduled replies (WhatsApp)', () => {
    const when = () => hoursFromNow(2);

    it('queues the row before it answers, and the workspace sees it', async () => {
      const created = await createScheduledReply(agentA, { conversationId: ids.open, content: 'Your order ships today', sendAt: when() });
      expect(created).toMatchObject({ status: 'pending', channel: 'whatsapp', created_by_user_id: agentUser });
      expect((await row(created.id)).status).toBe('pending');
      expect((await listScheduledReplies(viewerA, ids.open)).map((r) => r.id)).toContain(created.id);
      expect(await listScheduledReplies(ownerB, ids.open)).toEqual([]);
    });

    it('refuses viewers, other workspaces’ conversations and times past 30 days', async () => {
      expect(await code(createScheduledReply(viewerA, { conversationId: ids.open, content: 'x', sendAt: when() }))).not.toBeNull();
      await expect(createScheduledReply(agentA, { conversationId: ids.openB, content: 'x', sendAt: when() })).rejects.toMatchObject({ code: 'notFound' });
      await expect(createScheduledReply(agentA, { conversationId: ids.open, content: 'x', sendAt: hoursFromNow(31 * 24) }))
        .rejects.toMatchObject({ code: 'tooFarWhatsapp' });
    });

    it('only the creator or an admin changes it; a cancelled reply stays cancelled', async () => {
      const created = await createScheduledReply(agentA, { conversationId: ids.open, content: 'Hold on', sendAt: when() });
      await expect(updateScheduledReply(agent2A, created.id, { kind: 'cancel' })).rejects.toMatchObject({ code: 'notPending' });
      await expect(updateScheduledReply(ownerB, created.id, { kind: 'cancel' })).rejects.toMatchObject({ code: 'notFound' });
      expect((await updateScheduledReply(agentA, created.id, { kind: 'edit', content: 'Hold on, please' })).content).toBe('Hold on, please');
      expect((await updateScheduledReply(adminA, created.id, { kind: 'cancel' })).status).toBe('cancelled');
      await expect(updateScheduledReply(agentA, created.id, { kind: 'cancel' })).rejects.toMatchObject({ code: 'notPending' });
      // A cancelled reply is never sent.
      await makeDue(created.id).catch(() => undefined);
      await runScheduledReplies(accountA);
      expect(sendText).not.toHaveBeenCalled();
    });

    it('sends a due reply exactly once: one provider call, an accepted intent, a sent message from the staff member', async () => {
      const created = await createScheduledReply(agentA, { conversationId: ids.open, content: 'See you at five', sendAt: when() });
      await makeDue(created.id);
      await runScheduledReplies(accountA);
      expect(sendText).toHaveBeenCalledTimes(1);
      expect(sendText).toHaveBeenCalledWith(expect.objectContaining({ text: 'See you at five', phoneNumberId: 'pn-test' }));
      const done = await row(created.id);
      expect(done).toMatchObject({ status: 'sent', attempts: 1 });
      expect(await message(done.message_id)).toMatchObject({ status: 'sent', sender_type: 'agent', content_text: 'See you at five' });
      const intent = await owner.query('SELECT status FROM outbound_intents WHERE idempotency_key=$1', [`${accountA}:scheduled-reply:${created.id}`]);
      expect(intent.rows).toEqual([{ status: 'accepted' }]);
      // The next run finds nothing to do.
      await runScheduledReplies(accountA);
      expect(sendText).toHaveBeenCalledTimes(1);
    });

    it('skips a reply whose 24-hour window closed, with a machine reason and no provider call', async () => {
      const created = await createScheduledReply(agentA, { conversationId: ids.stale, content: 'Too late', sendAt: when() });
      await makeDue(created.id);
      await runScheduledReplies(accountA);
      expect(sendText).not.toHaveBeenCalled();
      expect(await row(created.id)).toMatchObject({ status: 'skipped', reason_code: 'window_closed', message_id: null });
    });

    it('an ambiguous outcome becomes unknown and is never re-sent; staff reconcile it', async () => {
      sendText.mockRejectedValue(new Error('socket hang up'));
      const created = await createScheduledReply(agentA, { conversationId: ids.open, content: 'Maybe sent', sendAt: when() });
      await makeDue(created.id);
      await runScheduledReplies(accountA);
      expect(sendText).toHaveBeenCalledTimes(1);
      const unknown = await row(created.id);
      expect(unknown.status).toBe('unknown');
      expect((await message(unknown.message_id)).status).toBe('unknown');
      // Not due again, whatever the schedule does.
      await runScheduledReplies(accountA);
      expect(sendText).toHaveBeenCalledTimes(1);
      // Only an unknown reply can be reconciled, and the other workspace cannot.
      await expect(reconcileScheduledReply(ownerB, created.id, 'sent')).rejects.toMatchObject({ code: 'notFound' });
      expect((await reconcileScheduledReply(agentA, created.id, 'failed')).status).toBe('failed');
      expect((await message(unknown.message_id)).status).toBe('failed');
      await expect(reconcileScheduledReply(agentA, created.id, 'sent')).rejects.toMatchObject({ code: 'notPending' });
      await runScheduledReplies(accountA);
      expect(sendText).toHaveBeenCalledTimes(1);
    });

    it('a claim whose worker vanished is completed from its accepted intent without a second send', async () => {
      const created = await createScheduledReply(agentA, { conversationId: ids.open, content: 'Crash between send and record', sendAt: when() });
      const stored = await owner.query<{ id: string }>("INSERT INTO messages(account_id,conversation_id,sender_type,sender_id,content_type,content_text,status) VALUES($1,$2,'agent',$3,'text','Crash between send and record','sending') RETURNING id",
        [accountA, ids.open, agentUser]);
      await owner.query("UPDATE scheduled_replies SET status='sending', claimed_at = now() - interval '1 hour', attempts=1, message_id=$2, send_at = now() - interval '2 hours' WHERE id=$1",
        [created.id, stored.rows[0].id]);
      await owner.query("INSERT INTO outbound_intents(account_id,idempotency_key,status,result) VALUES($1,$2,'accepted',$3::jsonb)",
        [accountA, `${accountA}:scheduled-reply:${created.id}`, JSON.stringify({ messageId: 'wamid.prior' })]);
      await runScheduledReplies(accountA);
      expect(sendText).not.toHaveBeenCalled();
      expect(await row(created.id)).toMatchObject({ status: 'sent', attempts: 2 });
      expect(await message(stored.rows[0].id)).toMatchObject({ status: 'sent', message_id: 'wamid.prior' });
    });

    it('a claim whose intent never reached an outcome is surfaced as unknown, not sent again', async () => {
      const created = await createScheduledReply(agentA, { conversationId: ids.open, content: 'Intent left dispatching', sendAt: when() });
      const stored = await owner.query<{ id: string }>("INSERT INTO messages(account_id,conversation_id,sender_type,sender_id,content_type,content_text,status) VALUES($1,$2,'agent',$3,'text','Intent left dispatching','sending') RETURNING id",
        [accountA, ids.open, agentUser]);
      await owner.query("UPDATE scheduled_replies SET status='sending', claimed_at = now() - interval '1 hour', attempts=1, message_id=$2, send_at = now() - interval '2 hours' WHERE id=$1",
        [created.id, stored.rows[0].id]);
      await owner.query("INSERT INTO outbound_intents(account_id,idempotency_key,status) VALUES($1,$2,'dispatching')", [accountA, `${accountA}:scheduled-reply:${created.id}`]);
      await runScheduledReplies(accountA);
      expect(sendText).not.toHaveBeenCalled();
      expect((await row(created.id)).status).toBe('unknown');
    });
  });
});
