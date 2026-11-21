// Batch 7 inbox: the server-paged conversation list (keyset pages, SQL counts,
// realtime membership checks) and the bulk actions, on a real PostgreSQL with
// the constrained app role. Two workspaces; B's rows must never show up in A's
// list or be changed by A's bulk actions.
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import type { TenantContext } from '@/lib/db/tenant';
import { BulkConversationError, MAX_BULK_IDS, bulkConversationAction } from './bulk-actions';
import { ConversationActionError } from './conversation-actions';
import { listInboxConversations, matchInboxConversations, type ListRow } from './conversation-list';
import { listQueryParams, parseListQuery, type InboxListQuery } from './inbox-filters';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;

const accountA = randomUUID(), accountB = randomUUID();
const ownerA = randomUUID(), agentA = randomUUID(), viewerA = randomUUID(), ownerB = randomUUID();
const users = [ownerA, agentA, viewerA, ownerB];
type Actor = Required<TenantContext>;
const asOwner: Actor = { accountId: accountA, userId: ownerA, role: 'owner' };
const asAgent: Actor = { accountId: accountA, userId: agentA, role: 'agent' };
const asB: Actor = { accountId: accountB, userId: ownerB, role: 'owner' };
const seed = String(Date.now()).slice(-8);

/** Seeded in A: 40 tied on one time, 85 on distinct times, 12 with no message yet. */
const TIED = 40, DATED = 85, UNDATED = 12;
const TOTAL_A = TIED + DATED + UNDATED;
let owner: pg.Client;
let idsB: string[] = [];
let labelA = '', labelB = '';

const query = (over: Partial<InboxListQuery> = {}): InboxListQuery => ({ ...parseListQuery(new URLSearchParams()), ...over });

/** Every page of the query, `limit` at a time. */
async function allPages(actor: Actor, q: InboxListQuery, limit: number): Promise<{ rows: ListRow[]; pages: number }> {
  const rows: ListRow[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page = await listInboxConversations(actor, q, { cursor, limit });
    rows.push(...page.conversations);
    cursor = page.nextCursor;
    pages += 1;
    if (pages > 100) throw new Error('paging did not end');
  } while (cursor);
  return { rows, pages };
}

/** The list's order, straight from SQL. */
async function expectedOrder(where = 'TRUE'): Promise<string[]> {
  return (await owner.query(`SELECT id::text FROM conversations WHERE account_id=$1 AND ${where}
    ORDER BY last_message_at DESC NULLS LAST, id`, [accountA])).rows.map((r) => r.id as string);
}

describe.skipIf(!ownerUrl || !appUrl)('inbox list paging and bulk actions on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Inbox list test', 'test-only-hash' FROM unnest($1::uuid[]) x", [users]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'List A',$2),($3,'List B',$4)", [accountA, ownerA, accountB, ownerB]);
    await owner.query(`INSERT INTO account_memberships(account_id,user_id,role) VALUES
      ($1,$2,'owner'),($1,$3,'agent'),($1,$4,'viewer'),($5,$6,'owner')`, [accountA, ownerA, agentA, viewerA, accountB, ownerB]);
    await owner.query(`INSERT INTO contacts(account_id,user_id,phone,name)
      SELECT $1, $2, '9177' || $3 || lpad(g::text, 4, '0'), 'Contact ' || g FROM generate_series(1, $4::int) g`,
    [accountA, ownerA, seed.slice(0, 4), TOTAL_A]);
    // Times are whole seconds in the past; the tied block shares one exact time.
    await owner.query(`INSERT INTO conversations(account_id,user_id,contact_id,status,unread_count,last_message_at)
      SELECT $1, $2, ct.id,
        (ARRAY['open','closed','pending'])[1 + (n % 3)], n % 2,
        CASE WHEN n <= $3::int THEN date_trunc('second', now()) - interval '3 days'
             WHEN n <= $3::int + $4::int THEN date_trunc('second', now()) - (n || ' minutes')::interval
             ELSE NULL END
      FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM contacts WHERE account_id = $1) ct`,
    [accountA, ownerA, TIED, DATED]);
    await owner.query(`INSERT INTO contacts(account_id,user_id,phone,name)
      SELECT $1, $2, '9188' || $3 || lpad(g::text, 4, '0'), 'B ' || g FROM generate_series(1, 5) g`, [accountB, ownerB, seed.slice(0, 4)]);
    idsB = (await owner.query(`INSERT INTO conversations(account_id,user_id,contact_id,status,unread_count,last_message_at)
      SELECT $1, $2, id, 'open', 3, now() FROM contacts WHERE account_id=$1 RETURNING id::text`, [accountB, ownerB])).rows.map((r) => r.id);
    labelA = (await owner.query("INSERT INTO conversation_labels(account_id,name) VALUES($1,'VIP') RETURNING id::text", [accountA])).rows[0].id;
    labelB = (await owner.query("INSERT INTO conversation_labels(account_id,name) VALUES($1,'B label') RETURNING id::text", [accountB])).rows[0].id;
  });

  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [users]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('pages the whole list in a stable order, with no duplicates or gaps, ties and undated rows included', async () => {
    const expected = await expectedOrder();
    for (const limit of [7, 20, 50, 100]) {
      const { rows, pages } = await allPages(asOwner, query(), limit);
      const ids = rows.map((row) => row.id);
      expect(new Set(ids).size, `limit ${limit}: duplicates`).toBe(ids.length);
      expect(ids, `limit ${limit}: order or gaps`).toEqual(expected);
      expect(pages).toBe(Math.ceil(TOTAL_A / limit));
    }
    // Nothing of workspace B, and the rows carry their contact.
    const { rows } = await allPages(asOwner, query(), 100);
    expect(rows.some((row) => idsB.includes(row.id))).toBe(false);
    expect((rows[0].contact as { name: string }).name).toMatch(/^Contact /);
  });

  it('pages a filter (Open includes legacy pending rows) and counts it in SQL', async () => {
    const expected = await expectedOrder("status IN ('open','pending')");
    const { rows } = await allPages(asOwner, query({ filter: 'open' }), 13);
    expect(rows.map((row) => row.id)).toEqual(expected);

    const first = await listInboxConversations(asOwner, query({ filter: 'open' }), { limit: 10 });
    const sql = (await owner.query(`SELECT count(*)::int AS all,
        count(*) FILTER (WHERE status IN ('open','pending'))::int AS open,
        count(*) FILTER (WHERE status = 'closed')::int AS closed,
        count(*) FILTER (WHERE unread_count > 0)::int AS unread
      FROM conversations WHERE account_id=$1`, [accountA])).rows[0];
    expect(first.counts?.views).toMatchObject({ all: TOTAL_A, open: sql.open, closed: sql.closed, unread: sql.unread });
    expect(first.counts?.total).toBe(sql.open);
    expect(first.counts?.channels.all).toBe(sql.open);
    // Later pages skip the counts.
    expect((await listInboxConversations(asOwner, query({ filter: 'open' }), { cursor: first.nextCursor, limit: 10 })).counts).toBeUndefined();
  });

  it('keeps later pages free of duplicates when a row moves to the top between pages', async () => {
    const first = await listInboxConversations(asOwner, query(), { limit: 30 });
    const seen = new Set(first.conversations.map((row) => row.id));
    const later = (await expectedOrder()).slice(60, 61)[0];
    await owner.query('UPDATE conversations SET last_message_at=now() WHERE id=$1', [later]);
    try {
      let cursor = first.nextCursor;
      const rest: string[] = [];
      while (cursor) {
        const page = await listInboxConversations(asOwner, query(), { cursor, limit: 30 });
        rest.push(...page.conversations.map((row) => row.id));
        cursor = page.nextCursor;
      }
      expect(rest.some((id) => seen.has(id))).toBe(false);
      expect(new Set(rest).size).toBe(rest.length);
      // The moved row is above the cursor now: the realtime check (ids=) brings it in, not a later page.
      expect(rest).not.toContain(later);
      expect(seen.size + rest.length).toBe(TOTAL_A - 1);
      const check = await matchInboxConversations(asOwner, query(), { ids: [later] });
      expect(check.conversations.map((row) => row.id)).toEqual([later]);
    } finally {
      await owner.query("UPDATE conversations SET last_message_at=date_trunc('second', now()) - interval '200 minutes' WHERE id=$1", [later]);
    }
  });

  it('refuses a forged or mismatched cursor', async () => {
    await expect(listInboxConversations(asOwner, query(), { cursor: 'not-a-cursor' })).rejects.toMatchObject({ code: 'invalid_cursor' });
    const page = await listInboxConversations(asOwner, query(), { limit: 5 });
    // A recent-order cursor is not a window-order cursor.
    await expect(listInboxConversations(asOwner, query({ session: 'active' }), { cursor: page.nextCursor }))
      .rejects.toMatchObject({ code: 'invalid_cursor' });
  });

  it('answers realtime checks for its own rows only: another workspace\'s id is dropped', async () => {
    const [openId] = await expectedOrder("status = 'open'");
    const [closedId] = await expectedOrder("status = 'closed'");
    const check = await matchInboxConversations(asOwner, query({ filter: 'open' }), { ids: [openId, closedId, idsB[0]] });
    expect(check.conversations.map((row) => row.id)).toEqual([openId]);
    expect(check.removedIds.sort()).toEqual([closedId, idsB[0]].sort());
    const since = await matchInboxConversations(asB, query(), { since: new Date(Date.now() - 3_600_000).toISOString() });
    expect(since.conversations.map((row) => row.id).sort()).toEqual([...idsB].sort());
  });

  it('bulk resolves only this workspace\'s ticked rows, audits the change and logs each resolve', async () => {
    const targets = (await expectedOrder("status <> 'closed'")).slice(0, 3);
    const result = await bulkConversationAction(asAgent, { action: { type: 'resolve' }, target: { ids: [...targets, idsB[0]] } });
    expect(result).toEqual({ matched: 3, changed: 3, refusedIds: [idsB[0]] });
    const statuses = (await owner.query('SELECT id::text, status FROM conversations WHERE id=ANY($1::uuid[])', [[...targets, idsB[0]]])).rows;
    expect(statuses.find((r) => r.id === idsB[0]).status).toBe('open');
    expect(statuses.filter((r) => targets.includes(r.id)).every((r) => r.status === 'closed')).toBe(true);
    const audit = (await owner.query("SELECT user_id::text, metadata FROM audit_logs WHERE account_id=$1 AND action='inbox.bulk_resolve'", [accountA])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].user_id).toBe(agentA);
    expect([...audit[0].metadata.conversation_ids].sort()).toEqual([...targets].sort());
    // The same handling log entry a single resolve writes (the row trigger).
    const logged = (await owner.query("SELECT count(*)::int AS n FROM conversation_handling_events WHERE account_id=$1 AND kind='resolved' AND conversation_id=ANY($2::uuid[])",
      [accountA, targets])).rows[0].n;
    expect(logged).toBe(3);
    // Nothing was audited in B.
    expect((await owner.query('SELECT count(*)::int AS n FROM audit_logs WHERE account_id=$1', [accountB])).rows[0].n).toBe(0);
  });

  it('bulk assigns to a member who can own conversations, notifying them like a single assign; a viewer is refused', async () => {
    const targets = (await expectedOrder("status <> 'closed' AND assigned_agent_id IS NULL")).slice(0, 4);
    await expect(bulkConversationAction(asOwner, { action: { type: 'assign', agentId: viewerA }, target: { ids: targets } }))
      .rejects.toBeInstanceOf(ConversationActionError);
    await expect(bulkConversationAction(asOwner, { action: { type: 'assign', agentId: ownerB }, target: { ids: targets } }))
      .rejects.toBeInstanceOf(ConversationActionError);
    const result = await bulkConversationAction(asOwner, { action: { type: 'assign', agentId: agentA }, target: { ids: targets } });
    expect(result.changed).toBe(4);
    const notified = (await owner.query("SELECT count(*)::int AS n FROM notifications WHERE account_id=$1 AND user_id=$2 AND type='conversation_assigned' AND conversation_id=ANY($3::uuid[])",
      [accountA, agentA, targets])).rows[0].n;
    expect(notified).toBe(4);
    // Already assigned: unchanged, no repeat notification.
    expect((await bulkConversationAction(asOwner, { action: { type: 'assign', agentId: agentA }, target: { ids: targets } })).changed).toBe(0);
  });

  it('bulk labels with this workspace\'s labels only and marks rows read', async () => {
    const targets = (await expectedOrder('unread_count > 0')).slice(0, 5);
    await expect(bulkConversationAction(asOwner, { action: { type: 'label', labelId: labelB }, target: { ids: targets } }))
      .rejects.toMatchObject({ code: 'not_found' });
    expect((await bulkConversationAction(asOwner, { action: { type: 'label', labelId: labelA }, target: { ids: [...targets, idsB[1]] } })).changed).toBe(5);
    expect((await owner.query('SELECT count(*)::int AS n FROM conversation_label_links WHERE label_id=$1', [labelA])).rows[0].n).toBe(5);
    const read = await bulkConversationAction(asOwner, { action: { type: 'read' }, target: { ids: [...targets, idsB[1]] } });
    expect(read).toMatchObject({ changed: 5, refusedIds: [idsB[1]] });
    expect((await owner.query('SELECT unread_count FROM conversations WHERE id=$1', [idsB[1]])).rows[0].unread_count).toBe(3);
  });

  it('acts on every conversation matching a filter in its own workspace only, and caps the ticked ids', async () => {
    const before = (await owner.query("SELECT count(*)::int AS n FROM conversations WHERE account_id=$1 AND unread_count > 0", [accountA])).rows[0].n;
    expect(before).toBeGreaterThan(0);
    // B marks "every unread conversation" read: only B's five change.
    const result = await bulkConversationAction(asB, { action: { type: 'read' }, target: { query: listQueryParams(query({ filter: 'unread' })).toString() } });
    expect(result).toMatchObject({ matched: 5, changed: 5 });
    expect((await owner.query("SELECT count(*)::int AS n FROM conversations WHERE account_id=$1 AND unread_count > 0", [accountA])).rows[0].n).toBe(before);
    const tooMany = Array.from({ length: MAX_BULK_IDS + 1 }, () => randomUUID());
    await expect(bulkConversationAction(asOwner, { action: { type: 'read' }, target: { ids: tooMany } })).rejects.toBeInstanceOf(BulkConversationError);
    await expect(bulkConversationAction(asOwner, { action: { type: 'drop' }, target: { ids: [idsB[0]] } })).rejects.toMatchObject({ code: 'invalid_request' });
  });
});
