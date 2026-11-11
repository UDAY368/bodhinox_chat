// Stage 5 (5E) on PostgreSQL: agent visibility (list, open, search, send lookup,
// labels, favourites, bulk pause), labels and favourites tenancy, assignment mode
// and capacity, the bulk contact actions and the stored Instagram facts. Runs
// against the disposable test database only (CI and test:all:local).
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import type { QuerySpec } from '@/lib/data/types';
import { executeQuery } from '@/lib/repositories/crm';
import { bulkContactAction, contactChannelStatus, scopeContacts } from '@/lib/contacts/bulk';
import { loadInstagramFacts } from '@/lib/contacts/instagram-facts';
import { listFavourites, setFavourite } from './favourites';
import { listConversationNotes } from './notes';
import { createReminder } from './reminders';
import { createScheduledReply } from './scheduled-replies';
import { createLabel, deleteLabel, LabelError, listLabelLinks, listLabels, setConversationLabel, updateLabel } from './labels';
import { applyInboundLifecycle } from './lifecycle';
import { createRoutingRule, deleteRoutingRule, getMemberCapacity, RoutingRuleError, setMemberCapacity } from './routing';
import { parseInboxSearchParams, searchInboxMessages } from './search';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const adminA = randomUUID(), agentA = randomUUID(), agent2A = randomUUID(), teammateA = randomUUID(), viewerA = randomUUID(), ownerB = randomUUID();
const users = [adminA, agentA, agent2A, teammateA, viewerA, ownerB];
const asAdmin: TenantContext = { accountId: accountA, userId: adminA, role: 'admin' };
const asAgent: TenantContext = { accountId: accountA, userId: agentA, role: 'agent' };
const asAgent2: TenantContext = { accountId: accountA, userId: agent2A, role: 'agent' };
const asViewer: TenantContext = { accountId: accountA, userId: viewerA, role: 'viewer' };
const asB: TenantContext = { accountId: accountB, userId: ownerB, role: 'owner' };
const seed = String(Date.now()).slice(-8);
const word = `zq${seed}visible`;
let owner: pg.Client;
let phone = 0;

/** A contact, a conversation (assigned to `assignee`) and one customer message. */
async function thread(account: string, by: string, assignee: string | null, text = 'hello') {
  const contact = (await owner.query('INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$3,$4) RETURNING id',
    [account, by, `9197${seed}${String(phone++).padStart(2, '0')}`, `Org ${phone}`])).rows[0].id as string;
  const conversation = (await owner.query(`INSERT INTO conversations(account_id,user_id,contact_id,assigned_agent_id,last_message_at)
    VALUES($1,$2,$3,$4,now()) RETURNING id`, [account, by, contact, assignee])).rows[0].id as string;
  const message = (await owner.query(`INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text)
    VALUES($1,$2,'customer','text',$3) RETURNING id`, [account, conversation, text])).rows[0].id as string;
  return { contact, conversation, message, input: { accountId: account, conversationId: conversation, contactId: contact, messageId: message, text } };
}

const setVisibility = (value: 'all' | 'assigned_or_team') => owner.query(
  `INSERT INTO workspace_inbox_settings(account_id,agent_visibility) VALUES($1,$2)
   ON CONFLICT (account_id) DO UPDATE SET agent_visibility=EXCLUDED.agent_visibility`, [accountA, value]);
const setMode = (value: 'off' | 'basic' | 'rules') => owner.query(
  `INSERT INTO workspace_inbox_settings(account_id,auto_assign_mode) VALUES($1,$2)
   ON CONFLICT (account_id) DO UPDATE SET auto_assign_mode=EXCLUDED.auto_assign_mode`, [accountA, value]);

const listIds = async (ctx: TenantContext) => {
  const result = await executeQuery({ resource: 'conversations', operation: 'select', filters: [], projection: 'id' } as QuerySpec, ctx, true);
  expect(result.error).toBeNull();
  return (result.data as { id: string }[]).map((row) => row.id);
};
const open = async (ctx: TenantContext, id: string) => (await executeQuery({
  resource: 'conversations', operation: 'select', projection: 'id,channel', filters: [{ field: 'id', op: 'eq', value: id }],
  cardinality: 'maybeSingle',
} as QuerySpec, ctx, true)).data;
const messagesOf = async (ctx: TenantContext, conversationId: string) => (await executeQuery({
  resource: 'messages', operation: 'select', projection: 'id', filters: [{ field: 'conversation_id', op: 'eq', value: conversationId }],
} as QuerySpec, ctx, true)).data as { id: string }[];
const search = (ctx: TenantContext, q: string) => withTenant(ctx, (tx) =>
  searchInboxMessages(tx, { accountId: ctx.accountId, userId: ctx.userId!, role: ctx.role! }, parseInboxSearchParams(new URLSearchParams({ q }), ctx.userId!)));
const labelCode = (work: Promise<unknown>) => work.then(() => null, (error) => (error instanceof LabelError ? error.code : 'other'));
const routingCode = (work: Promise<unknown>) => work.then(() => null, (error) => (error instanceof RoutingRuleError ? error.code : 'other'));

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('inbox and contacts organisation on PostgreSQL', { timeout: 120_000 }, () => {
  let mine: Awaited<ReturnType<typeof thread>>, theirs: Awaited<ReturnType<typeof thread>>;
  let team: Awaited<ReturnType<typeof thread>>, nobody: Awaited<ReturnType<typeof thread>>, other: Awaited<ReturnType<typeof thread>>;

  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Organisation test', 'test-only-hash' FROM unnest($1::uuid[]) x", [users]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Organisation A',$2),($3,'Organisation B',$4)", [accountA, adminA, accountB, ownerB]);
    await owner.query(`INSERT INTO account_memberships(account_id,user_id,role) VALUES
      ($1,$2,'admin'),($1,$3,'agent'),($1,$4,'agent'),($1,$5,'agent'),($1,$6,'viewer'),($7,$8,'owner')`,
      [accountA, adminA, agentA, agent2A, teammateA, viewerA, accountB, ownerB]);
    // agentA and teammateA share a team; agent2A is in none.
    const teamId = (await owner.query("INSERT INTO teams(account_id,name) VALUES($1,'Support') RETURNING id", [accountA])).rows[0].id;
    await owner.query('INSERT INTO team_members(account_id,team_id,user_id) VALUES($1,$2,$3),($1,$2,$4)', [accountA, teamId, agentA, teammateA]);
    mine = await thread(accountA, adminA, agentA, `${word} mine`);
    theirs = await thread(accountA, adminA, agent2A, `${word} theirs`);
    team = await thread(accountA, adminA, teammateA, `${word} team`);
    nobody = await thread(accountA, adminA, null, `${word} nobody`);
    other = await thread(accountB, ownerB, ownerB, `${word} other workspace`);
  });

  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [users]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('by default (visibility all) every member sees every conversation of the workspace, as before', async () => {
    const all = [mine, theirs, team, nobody].map((t) => t.conversation).sort();
    expect((await listIds(asAgent)).sort()).toEqual(all);
    expect((await listIds(asViewer)).sort()).toEqual(all);
    expect(await open(asAgent, theirs.conversation)).toMatchObject({ id: theirs.conversation });
    expect((await search(asAgent, word)).results).toHaveLength(4);
  });

  it('a restricted agent cannot list, open, read, search, label or favourite another agent\'s conversation', async () => {
    await setVisibility('assigned_or_team');
    try {
      // Their own, their team's and unassigned conversations stay visible.
      expect((await listIds(asAgent)).sort()).toEqual([mine, team, nobody].map((t) => t.conversation).sort());
      // The send route's lookup and the thread read find nothing: 404 to the caller.
      expect(await open(asAgent, theirs.conversation)).toBeNull();
      expect(await messagesOf(asAgent, theirs.conversation)).toEqual([]);
      expect(await messagesOf(asAgent, mine.conversation)).toHaveLength(1);
      const found = (await search(asAgent, word)).results.map((r) => r.conversation_id).sort();
      expect(found).toEqual([mine, team, nobody].map((t) => t.conversation).sort());
      const label = await createLabel(asAdmin, { name: `Hidden ${seed}`, color: 'red' });
      expect(await labelCode(setConversationLabel(asAgent, label.id, theirs.conversation, true))).toBe('not_found');
      expect(await labelCode(setFavourite(asAgent, theirs.conversation, true))).toBe('not_found');
      // The admin labels it; the restricted agent's link list leaves it out.
      await setConversationLabel(asAdmin, label.id, theirs.conversation, true);
      expect((await listLabelLinks(asAgent)).some((l) => l.conversation_id === theirs.conversation)).toBe(false);
      expect((await listLabelLinks(asAdmin)).some((l) => l.conversation_id === theirs.conversation)).toBe(true);
      // Admins and owners always see everything.
      expect(await listIds(asAdmin)).toContain(theirs.conversation);
      // The other agent sees theirs and the unassigned one, not agentA's team work.
      expect((await listIds(asAgent2)).sort()).toEqual([theirs, nobody].map((t) => t.conversation).sort());
      await deleteLabel(asAdmin, label.id);
    } finally {
      await setVisibility('all');
    }
  });

  it('a restricted agent cannot read notes of, remind on or schedule a reply into another agent\'s conversation', async () => {
    const code = (work: Promise<unknown>) => work.then(() => null, (error) => (error as { code?: string }).code ?? 'other');
    const soon = new Date(Date.now() + 60 * 60_000);
    await setVisibility('assigned_or_team');
    try {
      expect(await code(withTenant(asAgent, (tx) => listConversationNotes(tx, accountA, theirs.conversation)))).toBe('not_found');
      expect(await withTenant(asAgent, (tx) => listConversationNotes(tx, accountA, mine.conversation))).toEqual([]);
      expect(await code(createReminder(asAgent, { conversationId: theirs.conversation, kind: 'reminder', remindAt: soon, note: null })))
        .toBe('notFound');
      expect(await code(createScheduledReply(asAgent, { conversationId: theirs.conversation, content: 'Later', sendAt: soon })))
        .toBe('notFound');
      // Their own conversation and an admin are not refused as not found.
      expect(await code(createScheduledReply(asAgent, { conversationId: mine.conversation, content: 'Later', sendAt: soon })))
        .not.toBe('notFound');
      expect(await withTenant(asAdmin, (tx) => listConversationNotes(tx, accountA, theirs.conversation))).toEqual([]);
    } finally {
      await setVisibility('all');
    }
    // Default visibility: unchanged.
    expect(await withTenant(asAgent, (tx) => listConversationNotes(tx, accountA, theirs.conversation))).toEqual([]);
  });

  it('keeps labels per workspace (20 at most, unique names) and agents-and-above only', async () => {
    const vip = await createLabel(asAgent, { name: `VIP ${seed}`, color: 'blue' });
    expect(await labelCode(createLabel(asAgent, { name: `vip ${seed}`, color: 'gray' }))).toBe('name_taken');
    await expect(createLabel(asViewer, { name: 'Viewer', color: 'gray' })).rejects.toThrow();
    // Another workspace cannot see, rename, delete or apply it, nor apply it to its own conversation.
    expect(await listLabels(asB)).toEqual([]);
    expect(await labelCode(updateLabel(asB, vip.id, { name: 'Stolen' }))).toBe('not_found');
    expect(await labelCode(deleteLabel(asB, vip.id))).toBe('not_found');
    expect(await labelCode(setConversationLabel(asB, vip.id, other.conversation, true))).toBe('not_found');
    expect(await labelCode(setConversationLabel(asAgent, vip.id, other.conversation, true))).toBe('not_found');
    // Applying is idempotent; links go with the label.
    await setConversationLabel(asAgent, vip.id, mine.conversation, true);
    await setConversationLabel(asAgent, vip.id, mine.conversation, true);
    expect(await listLabelLinks(asAgent)).toEqual([{ conversation_id: mine.conversation, label_id: vip.id }]);
    expect(await listLabelLinks(asAgent, 'instagram')).toEqual([]);
    await setConversationLabel(asAgent, vip.id, mine.conversation, false);
    const extra = [];
    for (let i = 0; i < 19; i++) extra.push(await createLabel(asAdmin, { name: `L${i} ${seed}`, color: 'gray' }));
    expect(await labelCode(createLabel(asAdmin, { name: `Twenty-first ${seed}`, color: 'gray' }))).toBe('limit');
    for (const label of [vip, ...extra]) await deleteLabel(asAdmin, label.id);
    expect(await listLabels(asAdmin)).toEqual([]);
  });

  it('keeps favourites personal to the member and the workspace', async () => {
    await setFavourite(asAgent, mine.conversation, true);
    await setFavourite(asAgent, mine.conversation, true);
    expect(await listFavourites(asAgent)).toEqual([mine.conversation]);
    expect(await listFavourites(asAgent2)).toEqual([]);
    expect(await listFavourites(asB)).toEqual([]);
    expect(await labelCode(setFavourite(asB, mine.conversation, true))).toBe('not_found');
    expect(await labelCode(setFavourite(asAgent, other.conversation, true))).toBe('not_found');
    // Another member's row is invisible and untouchable (own_read/own_write RLS).
    await setFavourite(asAgent2, mine.conversation, false);
    expect(await listFavourites(asAgent)).toEqual([mine.conversation]);
    await setFavourite(asAgent, mine.conversation, false);
    expect(await listFavourites(asAgent)).toEqual([]);
  });

  it('skips an agent at their limit, and leaves the conversation unassigned when everyone is full', async () => {
    expect(await routingCode(setMemberCapacity(asAgent, agentA, 1))).not.toBeNull();
    expect(await routingCode(setMemberCapacity(asB, agentA, 1))).toBe('not_found');
    expect(await routingCode(getMemberCapacity(asB, agentA))).toBe('not_found');
    // agentA already holds one open conversation: at a limit of 1 they are full.
    expect(await setMemberCapacity(asAdmin, agentA, 1)).toEqual({ user_id: agentA, max_open_conversations: 1, open_conversations: 1 });
    const pool = await createRoutingRule(asAdmin, { name: 'Pool', enabled: true, reassign_after_minutes: null, conditions: {},
      assign_to: { mode: 'round_robin', user_ids: [agentA, agent2A] } });
    try {
      const first = await thread(accountA, adminA, null);
      expect((await applyInboundLifecycle(first.input)).routedTo).toBe(agent2A);
      const second = await thread(accountA, adminA, null);
      expect((await applyInboundLifecycle(second.input)).routedTo).toBe(agent2A);
      await setMemberCapacity(asAdmin, agent2A, 3);
      // agent2A now holds theirs + two: full too.
      const third = await thread(accountA, adminA, null);
      expect(await applyInboundLifecycle(third.input)).toMatchObject({ routedTo: null, state: 'requesting' });
      expect((await owner.query('SELECT assigned_agent_id FROM conversations WHERE id=$1', [third.conversation])).rows[0].assigned_agent_id).toBeNull();
      await owner.query('UPDATE conversations SET status=$1 WHERE id = ANY($2::uuid[])', ['closed', [first.conversation, second.conversation, third.conversation]]);
    } finally {
      await deleteRoutingRule(asAdmin, pool.id);
      await setMemberCapacity(asAdmin, agentA, null);
      await setMemberCapacity(asAdmin, agent2A, null);
    }
  });

  it('assigns nothing in off mode and spreads over online agents with room in basic mode', async () => {
    try {
      await setMode('off');
      const off = await thread(accountA, adminA, null);
      expect((await applyInboundLifecycle(off.input)).routedTo).toBeNull();
      await setMode('basic');
      // Nobody online: nothing is assigned.
      const empty = await thread(accountA, adminA, null);
      expect((await applyInboundLifecycle(empty.input)).routedTo).toBeNull();
      await owner.query("INSERT INTO member_presence(account_id,user_id,status,last_seen_at) VALUES($1,$2,'online',now()),($1,$3,'online',now()),($1,$4,'online',now() - interval '1 hour')",
        [accountA, agentA, agent2A, teammateA]);
      const routed = [];
      for (let i = 0; i < 4; i++) {
        const t = await thread(accountA, adminA, null);
        routed.push((await applyInboundLifecycle(t.input)).routedTo);
      }
      // Evenly between the two online agents; the stale one is offline.
      expect(routed.filter((id) => id === agentA)).toHaveLength(2);
      expect(routed.filter((id) => id === agent2A)).toHaveLength(2);
      // A full agent is skipped in basic mode too.
      await setMemberCapacity(asAdmin, agentA, 1);
      const capped = await thread(accountA, adminA, null);
      expect((await applyInboundLifecycle(capped.input)).routedTo).toBe(agent2A);
    } finally {
      await setMode('rules');
      await setMemberCapacity(asAdmin, agentA, null);
      await owner.query('DELETE FROM member_presence WHERE account_id=$1', [accountA]);
      await owner.query("UPDATE conversations SET status='closed' WHERE account_id=$1 AND id <> ALL($2::uuid[])",
        [accountA, [mine, theirs, team, nobody].map((t) => t.conversation)]);
    }
  });

  it('runs the bulk actions on the caller\'s workspace only', async () => {
    const field = (await owner.query("INSERT INTO custom_fields(account_id,user_id,field_name) VALUES($1,$2,'Tier') RETURNING id", [accountA, adminA])).rows[0].id;
    const fieldB = (await owner.query("INSERT INTO custom_fields(account_id,user_id,field_name) VALUES($1,$2,'Tier') RETURNING id", [accountB, ownerB])).rows[0].id;
    const tag = (await owner.query("INSERT INTO tags(account_id,user_id,name) VALUES($1,$2,$3) RETURNING id", [accountA, adminA, `Bulk ${seed}`])).rows[0].id;
    const picked = [mine.contact, theirs.contact];
    await owner.query('INSERT INTO contact_tags(account_id,contact_id,tag_id) SELECT $1, x, $2 FROM unnest($3::uuid[]) x', [accountA, tag, picked]);

    // Unsubscribe from Instagram: only the picked contacts of A; WhatsApp opt-out untouched.
    expect(await bulkContactAction(asAgent, { scope: { contactIds: picked }, action: { type: 'unsubscribe_instagram' }, expected: 2 }))
      .toEqual({ matched: 2, changed: 2 });
    const consent = await owner.query('SELECT id, instagram_opted_out_at IS NOT NULL AS ig, opted_out_at IS NOT NULL AS wa FROM contacts WHERE account_id=ANY($1::uuid[])', [[accountA, accountB]]);
    for (const row of consent.rows) {
      expect(row.ig).toBe(picked.includes(row.id));
      expect(row.wa).toBe(false);
    }
    expect(await contactChannelStatus(asAgent, [mine.contact, other.contact])).toEqual({ [mine.contact]: 'unsubscribed' });
    // Another workspace's contact ids count as no match.
    await expect(bulkContactAction(asAgent, { scope: { contactIds: [other.contact] }, action: { type: 'unsubscribe_instagram' }, expected: 1 }))
      .rejects.toMatchObject({ matched: 0 });

    // Remove a tag, set a custom field (another workspace's field is refused).
    expect(await bulkContactAction(asAgent, { scope: { tagIds: [tag] }, action: { type: 'remove_tag', tagId: tag }, expected: 2 }))
      .toEqual({ matched: 2, changed: 2 });
    await expect(bulkContactAction(asAgent, { scope: { contactIds: picked }, action: { type: 'set_field', fieldId: fieldB, value: 'gold' }, expected: 2 }))
      .rejects.toThrow('Custom field not found');
    await bulkContactAction(asAgent, { scope: { contactIds: picked }, action: { type: 'set_field', fieldId: field, value: 'gold' }, expected: 2 });
    await bulkContactAction(asAgent, { scope: { contactIds: picked }, action: { type: 'set_field', fieldId: field, value: 'silver' }, expected: 2 });
    const values = await owner.query('SELECT value FROM contact_custom_values WHERE custom_field_id=$1', [field]);
    expect(values.rows.map((r) => r.value)).toEqual(['silver', 'silver']);
    await expect(bulkContactAction(asViewer, { scope: { contactIds: picked }, action: { type: 'set_field', fieldId: field, value: 'x' }, expected: 2 }))
      .rejects.toThrow();

    // The channel-filtered view counts exactly what a bulk action checks.
    const view = await scopeContacts(asAgent, { channel: 'whatsapp' }, { offset: 0, limit: 100 });
    expect(view.contacts.every((c) => c.account_id === accountA)).toBe(true);
    expect(await scopeContacts(asAgent, { subscribedOnly: true }, { offset: 0, limit: 10 })).toEqual({ contacts: [], total: 0 });
  });

  it('pauses automations in bulk only on conversations the member may see', async () => {
    await setVisibility('assigned_or_team');
    try {
      const picked = [mine.contact, theirs.contact];
      expect(await bulkContactAction(asAgent, { scope: { contactIds: picked }, action: { type: 'pause_automations', minutes: 60 }, expected: 2 }))
        .toEqual({ matched: 2, changed: 1 });
      const rows = await owner.query('SELECT id, bot_paused, bot_paused_by, bot_paused_until > now() + interval \'50 minutes\' AS later FROM conversations WHERE id=ANY($1::uuid[])',
        [[mine.conversation, theirs.conversation]]);
      const byId = Object.fromEntries(rows.rows.map((r) => [r.id, r]));
      expect(byId[mine.conversation]).toMatchObject({ bot_paused: true, bot_paused_by: agentA, later: true });
      expect(byId[theirs.conversation].bot_paused).toBe(false);
      await bulkContactAction(asAdmin, { scope: { contactIds: picked }, action: { type: 'pause_automations', minutes: null }, expected: 2 });
      const forever = await owner.query('SELECT bool_and(bot_paused) AS paused, bool_and(bot_paused_until IS NULL) AS untimed FROM conversations WHERE id=ANY($1::uuid[])',
        [[mine.conversation, theirs.conversation]]);
      expect(forever.rows[0]).toEqual({ paused: true, untimed: true });
    } finally {
      await setVisibility('all');
      await owner.query('UPDATE conversations SET bot_paused=false, bot_paused_until=NULL, bot_paused_by=NULL WHERE account_id=$1', [accountA]);
    }
  });

  it('reads Instagram facts from stored state, for the caller\'s workspace only', async () => {
    const facts = await loadInstagramFacts(asViewer, mine.contact);
    expect(facts).toMatchObject({ identities: [], last_interaction_at: null, window_open_until: null });
    expect(await loadInstagramFacts(asB, mine.contact)).toBeNull();
  });
});
