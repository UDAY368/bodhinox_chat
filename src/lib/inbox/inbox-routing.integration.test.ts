import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import type { TenantContext } from '@/lib/db/tenant';
import { saveInboxSettings, loadInboxSettings } from './inbox-settings';
import { applyInboundLifecycle, claimOnAgentReply, runAutoResolve } from './lifecycle';
import {
  createRoutingRule, deleteRoutingRule, listRoutingRules, reorderRoutingRules, RoutingRuleError, runReassign, updateRoutingRule,
} from './routing';
import { runSlaCheck } from './sla';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const adminA = randomUUID(), agentA = randomUUID(), agent2A = randomUUID(), viewerA = randomUUID(), ownerB = randomUUID(), leaverA = randomUUID();
const asAdmin: TenantContext = { accountId: accountA, userId: adminA, role: 'admin' };
const asAgent: TenantContext = { accountId: accountA, userId: agentA, role: 'agent' };
const asViewer: TenantContext = { accountId: accountA, userId: viewerA, role: 'viewer' };
const asB: TenantContext = { accountId: accountB, userId: ownerB, role: 'owner' };
const seed = String(Date.now()).slice(-8);
let owner: pg.Client;
let phone = 0;
let tagA = '', tagB = '';

const errorCode = async (work: Promise<unknown>) => work.then(() => null, (error) => (error instanceof RoutingRuleError ? error.code : 'other'));

/** A contact, an open conversation and one customer message (the inbound). */
async function inbound(text: string, options: { tag?: string; at?: string } = {}) {
  const contact = (await owner.query('INSERT INTO contacts(account_id,user_id,phone) VALUES($1,$2,$3) RETURNING id',
    [accountA, adminA, `9196${seed}${String(phone++).padStart(2, '0')}`])).rows[0].id as string;
  if (options.tag) await owner.query('INSERT INTO contact_tags(account_id,contact_id,tag_id) VALUES($1,$2,$3)', [accountA, contact, options.tag]);
  const conversation = (await owner.query('INSERT INTO conversations(account_id,user_id,contact_id,last_message_at) VALUES($1,$2,$3,now()) RETURNING id',
    [accountA, adminA, contact])).rows[0].id as string;
  const message = (await owner.query(`INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,created_at)
    VALUES($1,$2,'customer','text',$3,COALESCE($4::timestamptz,now())) RETURNING id`, [accountA, conversation, text, options.at ?? null])).rows[0].id as string;
  return { contact, conversation, message, input: { accountId: accountA, conversationId: conversation, contactId: contact, messageId: message, text } };
}

const conversation = async (id: string) => (await owner.query(
  'SELECT status,lifecycle_state,assigned_agent_id,first_response_due_at,first_responded_at,reopened_count FROM conversations WHERE id=$1', [id])).rows[0];

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('inbox lifecycle and routing on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Routing test', 'test-only-hash' FROM unnest($1::uuid[]) x",
      [[adminA, agentA, agent2A, viewerA, ownerB, leaverA]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Routing A',$2),($3,'Routing B',$4)", [accountA, adminA, accountB, ownerB]);
    await owner.query(`INSERT INTO account_memberships(account_id,user_id,role) VALUES
      ($1,$2,'admin'),($1,$3,'agent'),($1,$4,'agent'),($1,$5,'viewer'),($6,$7,'owner'),($1,$8,'agent')`,
      [accountA, adminA, agentA, agent2A, viewerA, accountB, ownerB, leaverA]);
    tagA = (await owner.query("INSERT INTO tags(account_id,user_id,name) VALUES($1,$2,'VIP') RETURNING id", [accountA, adminA])).rows[0].id;
    tagB = (await owner.query("INSERT INTO tags(account_id,user_id,name) VALUES($1,$2,'Other') RETURNING id", [accountB, ownerB])).rows[0].id;
  });

  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[adminA, agentA, agent2A, viewerA, ownerB, leaverA]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('lets admins save settings, members read them, and refuses agents', async () => {
    const settings = {
      timezone: 'UTC', working_hours: {}, away_message_enabled: false, away_message: null,
      auto_resolve_after_hours: 24, sla_first_response_minutes: 10,
    };
    await expect(saveInboxSettings(asAgent, settings)).rejects.toThrow();
    expect(await saveInboxSettings(asAdmin, settings)).toEqual(settings);
    expect(await loadInboxSettings(asViewer)).toEqual(settings);
    expect((await loadInboxSettings(asB)).sla_first_response_minutes).toBeNull();
  });

  it('manages rules for admins only, with references inside the workspace', async () => {
    const rule = { enabled: true, reassign_after_minutes: null, conditions: {} } as const;
    await expect(createRoutingRule(asAgent, { ...rule, name: 'x', assign_to: { mode: 'member', user_id: agentA } })).rejects.toThrow();
    expect(await errorCode(createRoutingRule(asAdmin, { ...rule, name: 'x', assign_to: { mode: 'member', user_id: viewerA } }))).toBe('unknown_member');
    expect(await errorCode(createRoutingRule(asAdmin, { ...rule, name: 'x', assign_to: { mode: 'member', user_id: ownerB } }))).toBe('unknown_member');
    expect(await errorCode(createRoutingRule(asAdmin, { ...rule, name: 'x', conditions: { tags_any: [tagB] }, assign_to: { mode: 'member', user_id: agentA } }))).toBe('unknown_tag');
    const first = await createRoutingRule(asAdmin, { ...rule, name: 'First', assign_to: { mode: 'member', user_id: agentA } });
    const second = await createRoutingRule(asAdmin, { ...rule, name: 'Second', assign_to: { mode: 'member', user_id: agent2A } });
    expect([first.position, second.position]).toEqual([0, 1]);
    expect((await reorderRoutingRules(asAdmin, [second.id, first.id])).map((r) => r.name)).toEqual(['Second', 'First']);
    expect(await errorCode(reorderRoutingRules(asAdmin, [second.id]))).toBe('invalid_order');
    expect(await errorCode(updateRoutingRule(asB, first.id, { ...rule, name: 'Stolen', assign_to: { mode: 'member', user_id: ownerB } }))).toBe('not_found');
    expect(await listRoutingRules(asB)).toEqual([]);
    await deleteRoutingRule(asAdmin, first.id);
    await deleteRoutingRule(asAdmin, second.id);
    expect(await errorCode(deleteRoutingRule(asAdmin, first.id))).toBe('not_found');
  });

  it('routes an unassigned inbound by rule order and rotates a round robin', async () => {
    const base = { enabled: true, reassign_after_minutes: null } as const;
    const vip = await createRoutingRule(asAdmin, { ...base, name: 'VIP', conditions: { tags_any: [tagA], keywords_any: ['refund'] }, assign_to: { mode: 'member', user_id: adminA } });
    const pool = await createRoutingRule(asAdmin, { ...base, name: 'Pool', conditions: {}, assign_to: { mode: 'round_robin', user_ids: [agentA, leaverA, agent2A] } });
    // Demoted after the rule was saved: skipped from now on.
    await owner.query("UPDATE account_memberships SET role='viewer' WHERE account_id=$1 AND user_id=$2", [accountA, leaverA]);

    const tagged = await inbound('I need a REFUND', { tag: tagA });
    expect(await applyInboundLifecycle(tagged.input)).toMatchObject({ state: 'assigned', routedTo: adminA, ruleId: vip.id });

    const one = await inbound('hello');
    const two = await inbound('hello again');
    expect((await applyInboundLifecycle(one.input)).routedTo).toBe(agentA);
    // The member who became a viewer is skipped.
    expect((await applyInboundLifecycle(two.input)).routedTo).toBe(agent2A);
    expect((await conversation(two.conversation)).lifecycle_state).toBe('assigned');
    const notified = await owner.query("SELECT 1 FROM notifications WHERE account_id=$1 AND user_id=$2 AND type='conversation_assigned' AND conversation_id=$3",
      [accountA, agent2A, two.conversation]);
    expect(notified.rowCount).toBe(1);

    // A retry leaves the assignment and the rotation alone.
    expect(await applyInboundLifecycle(two.input)).toMatchObject({ state: 'assigned', routedTo: null });
    const cursor = await owner.query('SELECT round_robin_last_user_id FROM routing_rules WHERE id=$1', [pool.id]);
    expect(cursor.rows[0].round_robin_last_user_id).toBe(agent2A);
    await deleteRoutingRule(asAdmin, vip.id);
    await deleteRoutingRule(asAdmin, pool.id);
  });

  it('matches a channel condition against the conversation channel', async () => {
    const base = { enabled: true, reassign_after_minutes: null } as const;
    const ig = await createRoutingRule(asAdmin, { ...base, name: 'Instagram', conditions: { channel: 'instagram' }, assign_to: { mode: 'member', user_id: agent2A } });
    const wa = await createRoutingRule(asAdmin, { ...base, name: 'WhatsApp', conditions: { channel: 'whatsapp' }, assign_to: { mode: 'member', user_id: agentA } });
    // A plain WhatsApp conversation skips the Instagram rule and takes the WhatsApp one.
    const whatsapp = await inbound('hello there');
    expect(await applyInboundLifecycle(whatsapp.input)).toMatchObject({ routedTo: agentA, ruleId: wa.id });
    await deleteRoutingRule(asAdmin, ig.id);
    await deleteRoutingRule(asAdmin, wa.id);
  });

  it('marks AI-owned conversations as bot without an SLA clock, but routes after a one-off bot reply', async () => {
    const pool = await createRoutingRule(asAdmin, { enabled: true, reassign_after_minutes: null, name: 'Pool', conditions: {}, assign_to: { mode: 'member', user_id: agentA } });
    const ai = await inbound('hi', { at: new Date(Date.now() - 1000).toISOString() });
    expect((await conversation(ai.conversation)).first_response_due_at).not.toBeNull();
    await owner.query("INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,ai_generated) VALUES($1,$2,'bot','text','auto',true)",
      [accountA, ai.conversation]);
    expect(await applyInboundLifecycle(ai.input)).toMatchObject({ state: 'bot', botOwned: true, botReplied: true, routedTo: null });
    expect(await conversation(ai.conversation)).toMatchObject({ lifecycle_state: 'bot', first_response_due_at: null, assigned_agent_id: null });

    const welcome = await inbound('hi', { at: new Date(Date.now() - 1000).toISOString() });
    await owner.query("INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text) VALUES($1,$2,'bot','text','welcome')",
      [accountA, welcome.conversation]);
    expect(await applyInboundLifecycle(welcome.input)).toMatchObject({ state: 'assigned', botOwned: false, botReplied: true, routedTo: agentA });

    // Back from bot: the next unanswered inbound needs a person again.
    const later = await owner.query("INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text) VALUES($1,$2,'customer','text','human please') RETURNING id",
      [accountA, ai.conversation]);
    expect(await applyInboundLifecycle({ ...ai.input, messageId: later.rows[0].id })).toMatchObject({ state: 'assigned', routedTo: agentA });
    await deleteRoutingRule(asAdmin, pool.id);
  });

  it('lets a replying agent claim an unassigned conversation, never a viewer or another workspace', async () => {
    const open = await inbound('anyone?');
    expect(await claimOnAgentReply(asViewer, open.conversation)).toBe(false);
    expect(await claimOnAgentReply(asB, open.conversation)).toBe(false);
    expect(await claimOnAgentReply(asAgent, open.conversation)).toBe(true);
    expect(await conversation(open.conversation)).toMatchObject({ lifecycle_state: 'assigned', assigned_agent_id: agentA });
    expect(await claimOnAgentReply({ ...asAgent, userId: agent2A }, open.conversation)).toBe(false);
    expect((await conversation(open.conversation)).assigned_agent_id).toBe(agentA);
  });

  it('notifies an SLA breach once per cycle to the assignee and admins, not after a reply', async () => {
    const late = await inbound('still waiting');
    const answered = await inbound('waiting too');
    await owner.query("UPDATE conversations SET assigned_agent_id=$2, first_response_due_at=now()-interval '1 minute' WHERE id=$1", [late.conversation, agentA]);
    await owner.query("UPDATE conversations SET first_response_due_at=now()-interval '1 minute', first_responded_at=now() WHERE id=$1", [answered.conversation]);
    expect(await runSlaCheck(accountA)).toBeGreaterThanOrEqual(1);
    expect(await runSlaCheck(accountA)).toBe(0);
    const rows = await owner.query("SELECT user_id,link FROM notifications WHERE account_id=$1 AND type='sla_breach' AND conversation_id=$2 ORDER BY user_id",
      [accountA, late.conversation]);
    expect(rows.rows.map((r) => r.user_id).sort()).toEqual([adminA, agentA].sort());
    expect(rows.rows[0].link).toBe(`/inbox?c=${late.conversation}`);
    expect((await owner.query("SELECT 1 FROM notifications WHERE type='sla_breach' AND conversation_id=$1", [answered.conversation])).rowCount).toBe(0);
  });

  it('hands an unanswered conversation to the next member, and stops once answered', async () => {
    const rule = await createRoutingRule(asAdmin, { enabled: true, reassign_after_minutes: 5, name: 'Rotate', conditions: {},
      assign_to: { mode: 'round_robin', user_ids: [agentA, agent2A] } });
    const waiting = await inbound('help');
    const routed = await applyInboundLifecycle(waiting.input);
    const job = await owner.query("SELECT payload,run_at FROM jobs WHERE tenant_id=$1 AND type='inbox.reassign' AND payload->>'conversationId'=$2",
      [accountA, waiting.conversation]);
    expect(job.rows[0].payload).toMatchObject({ ruleId: rule.id, assignee: routed.routedTo, attempt: 0 });
    expect(await runReassign(accountA, job.rows[0].payload)).toBe('reassigned');
    const next = (await conversation(waiting.conversation)).assigned_agent_id;
    expect(next).not.toBe(routed.routedTo);
    // The job for the old assignee is now stale.
    expect(await runReassign(accountA, job.rows[0].payload)).toBe('stale');
    await owner.query("INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text) VALUES($1,$2,'agent','text','on it')",
      [accountA, waiting.conversation]);
    expect(await runReassign(accountA, { ...job.rows[0].payload, assignee: next, attempt: 1 })).toBe('stale');
    await deleteRoutingRule(asAdmin, rule.id);
  });

  it('auto-resolves idle conversations where the business spoke last, never a waiting customer', async () => {
    const idle = await inbound('thanks');
    const waiting = await inbound('hello?');
    await owner.query("INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,created_at) VALUES($1,$2,'agent','text','bye',now()+interval '1 second')",
      [accountA, idle.conversation]);
    await owner.query("UPDATE conversations SET last_message_at=now()-interval '2 days' WHERE id=ANY($1::uuid[])", [[idle.conversation, waiting.conversation]]);
    expect(await runAutoResolve(accountA)).toBe(1);
    expect(await conversation(idle.conversation)).toMatchObject({ status: 'closed', lifecycle_state: 'resolved' });
    expect((await conversation(waiting.conversation)).status).not.toBe('closed');
    expect(await runAutoResolve(accountB)).toBe(0);
  });

  it('does not count an away or other bot message as answering a customer who needs a person', async () => {
    const away = await inbound('anyone there?');
    const assigned = await inbound('order status?');
    const botOwned = await inbound('menu');
    for (const c of [away, assigned, botOwned])
      await owner.query("INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,created_at) VALUES($1,$2,'bot','text','auto',now()+interval '1 second')",
        [accountA, c.conversation]);
    await owner.query('UPDATE conversations SET assigned_agent_id=$2 WHERE id=$1', [assigned.conversation, agentA]);
    await owner.query("UPDATE conversations SET lifecycle_state='bot' WHERE id=$1", [botOwned.conversation]);
    await owner.query("UPDATE conversations SET last_message_at=now()-interval '2 days' WHERE id=ANY($1::uuid[])",
      [[away.conversation, assigned.conversation, botOwned.conversation]]);
    expect((await conversation(away.conversation)).lifecycle_state).toBe('requesting');
    expect((await conversation(assigned.conversation)).lifecycle_state).toBe('assigned');
    expect(await runAutoResolve(accountA)).toBe(1);
    // The bot answered a conversation it owns: done. The customers waiting for a person stay open.
    expect(await conversation(botOwned.conversation)).toMatchObject({ status: 'closed', lifecycle_state: 'resolved' });
    expect(await conversation(away.conversation)).toMatchObject({ status: 'open', lifecycle_state: 'requesting' });
    expect(await conversation(assigned.conversation)).toMatchObject({ status: 'open', lifecycle_state: 'assigned' });
    // A member's reply after the bot message does answer it.
    await owner.query("INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,created_at) VALUES($1,$2,'agent','text','sorted',now()+interval '2 seconds')",
      [accountA, assigned.conversation]);
    await owner.query("UPDATE conversations SET last_message_at=now()-interval '2 days' WHERE id=$1", [assigned.conversation]);
    expect(await runAutoResolve(accountA)).toBe(1);
    expect(await conversation(assigned.conversation)).toMatchObject({ status: 'closed', lifecycle_state: 'resolved' });
  });

  it('reassigns after an earlier reply in the same cycle when the new assignee leaves it unanswered', async () => {
    const rule = await createRoutingRule(asAdmin, { enabled: true, reassign_after_minutes: 5, name: 'Second round', conditions: {},
      assign_to: { mode: 'round_robin', user_ids: [agentA, agent2A] } });
    const open = await inbound('first question', { at: new Date(Date.now() - 60_000).toISOString() });
    // A member answered earlier in this cycle, then the conversation went back to the queue.
    await owner.query("INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,created_at) VALUES($1,$2,'agent','text','answer',now()-interval '50 seconds')",
      [accountA, open.conversation]);
    expect((await conversation(open.conversation)).first_responded_at).not.toBeNull();
    const again = await owner.query("INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text) VALUES($1,$2,'customer','text','one more thing') RETURNING id",
      [accountA, open.conversation]);
    const routed = await applyInboundLifecycle({ ...open.input, messageId: again.rows[0].id });
    expect(routed.routedTo).not.toBeNull();
    const jobs = (attempt: string) => owner.query(
      "SELECT payload FROM jobs WHERE tenant_id=$1 AND type='inbox.reassign' AND payload->>'conversationId'=$2 AND payload->>'attempt'=$3",
      [accountA, open.conversation, attempt]);
    const job = await jobs('0');
    expect(job.rows).toHaveLength(1);
    expect(await runReassign(accountA, job.rows[0].payload)).toBe('reassigned');
    expect((await conversation(open.conversation)).assigned_agent_id).not.toBe(routed.routedTo);

    // Given back and routed again in the same cycle: its own check is queued, not dropped as a duplicate of the first.
    await owner.query('UPDATE conversations SET assigned_agent_id=NULL WHERE id=$1', [open.conversation]);
    const third = await owner.query("INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text) VALUES($1,$2,'customer','text','hello?') RETURNING id",
      [accountA, open.conversation]);
    expect((await applyInboundLifecycle({ ...open.input, messageId: third.rows[0].id })).routedTo).not.toBeNull();
    expect((await jobs('0')).rows).toHaveLength(2);
    await deleteRoutingRule(asAdmin, rule.id);
  });

  it('routes by the time the customer wrote, not when the delayed job runs', async () => {
    const hours = { start: '09:00', end: '18:00' };
    await saveInboxSettings(asAdmin, {
      timezone: 'UTC', working_hours: { mon: [hours], tue: [hours], wed: [hours], thu: [hours], fri: [hours] },
      away_message_enabled: false, away_message: null, auto_resolve_after_hours: 24, sla_first_response_minutes: 10,
    });
    const day = await createRoutingRule(asAdmin, { enabled: true, reassign_after_minutes: null, name: 'Daytime',
      conditions: { within_working_hours: true }, assign_to: { mode: 'member', user_id: agentA } });
    const night = await createRoutingRule(asAdmin, { enabled: true, reassign_after_minutes: null, name: 'On call',
      conditions: { within_working_hours: false }, assign_to: { mode: 'member', user_id: agent2A } });
    // Monday: written 17:59:50, the job runs after closing at 18:00:30.
    const runAt = new Date('2026-11-02T18:00:30Z');
    const inHours = await inbound('just before closing', { at: '2026-11-02T17:59:50Z' });
    expect(await applyInboundLifecycle(inHours.input, runAt)).toMatchObject({ routedTo: agentA, ruleId: day.id });
    const afterHours = await inbound('after closing', { at: '2026-11-02T18:00:10Z' });
    expect(await applyInboundLifecycle(afterHours.input, runAt)).toMatchObject({ routedTo: agent2A, ruleId: night.id });
    await deleteRoutingRule(asAdmin, day.id);
    await deleteRoutingRule(asAdmin, night.id);
  });
});
