/**
 * Phase 12 automations on PostgreSQL: the tag_added loop check at
 * activation, the depth-3 runtime cap on a chain forced past it, the
 * notify_team notice, and dynamic segment recipients (with once_per_contact).
 */
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases } from '@/lib/db/prisma';
import { createScopedClient } from '@/lib/data/server';
import type { AccountContext } from '@/lib/auth/account';

vi.mock('next/server', () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }) },
}));

import { automationLoopChain, publishChecks, segmentAudienceIssues } from './publish-checks';
import { activateWithLoopLock } from './activation-lock';
import { runAutomationsForTrigger } from './engine';
import { MAX_TAG_CHAIN_DEPTH } from '@/lib/contacts/tag-chain';
import { notifyAutomationNotice } from '@/lib/notifications/emit';
import { contactsAlreadyRun, segmentRecipients } from '@/lib/jobs/scheduled-audience';
import { withJobScope } from '@/lib/jobs/scope';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountId = randomUUID(), otherAccountId = randomUUID();
const ownerId = randomUUID(), agentId = randomUUID(), adminId = randomUUID(), outsiderId = randomUUID();
const tagX = randomUUID(), tagY = randomUUID(), tagZ = randomUUID();
let owner: pg.Client;

async function automation(name: string, trigger: { type: string; tag?: string }, steps: { type: string; config: Record<string, unknown> }[], active = true): Promise<string> {
  const id = (await owner.query(
    `INSERT INTO automations(account_id,user_id,name,trigger_type,trigger_config,is_active) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
    [accountId, ownerId, name, trigger.type, trigger.tag ? { tag_id: trigger.tag } : {}, active])).rows[0].id;
  for (const [position, step] of steps.entries())
    await owner.query(`INSERT INTO automation_steps(account_id,automation_id,step_type,step_config,position) VALUES($1,$2,$3,$4,$5)`,
      [accountId, id, step.type, step.config, position]);
  return id;
}
const addTag = (tag: string) => ({ type: 'add_tag', config: { tag_id: tag } });
const removeTag = (tag: string) => ({ type: 'remove_tag', config: { tag_id: tag } });
async function contact(name: string, extra: { opted_out?: boolean } = {}): Promise<string> {
  return (await owner.query(
    `INSERT INTO contacts(account_id,user_id,phone,name,opted_out_at) VALUES($1,$2,$3,$4,$5) RETURNING id`,
    [accountId, ownerId, `+1415555${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`, name, extra.opted_out ? new Date() : null])).rows[0].id;
}

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('automations Phase 12 on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    const name = (await owner.query('SELECT current_database() AS name')).rows[0].name;
    if (!/test/i.test(name)) throw new Error('Automation loop tests require an isolated test database');
    await owner.query('BEGIN');
    await owner.query('SET LOCAL ROLE bodhinox_auth');
    for (const id of [ownerId, agentId, adminId, outsiderId])
      await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Loop test','test-only-hash')", [id, `${id}@example.invalid`]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Loop',$2),($3,'Other',$4)", [accountId, ownerId, otherAccountId, outsiderId]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'agent'),($1,$4,'admin'),($5,$6,'owner')",
      [accountId, ownerId, agentId, adminId, otherAccountId, outsiderId]);
    await owner.query('COMMIT');
    for (const [id, tag] of [[tagX, 'X'], [tagY, 'Y'], [tagZ, 'Z']])
      await owner.query('INSERT INTO tags(id,account_id,user_id,name) VALUES($1,$2,$3,$4)', [id, accountId, ownerId, `loop-${tag}`]);
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id IN ($1,$2)', [accountId, otherAccountId]);
      await owner.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[ownerId, agentId, adminId, outsiderId]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('refuses activation that closes A adds X, B on X adds Y, C on Y adds X with 422', async () => {
    await automation('A', { type: 'new_message_received' }, [addTag(tagX)]);
    await automation('B', { type: 'tag_added', tag: tagX }, [addTag(tagY)]);
    // The agent's own tenant client (app role, RLS), as the route uses.
    const db = createScopedClient({ accountId, userId: agentId, role: 'agent' });
    const candidate = { name: 'C', trigger_type: 'tag_added', trigger_config: { tag_id: tagY }, steps: [{ step_type: 'add_tag', step_config: { tag_id: tagX } }] };
    expect(await automationLoopChain(db, accountId, candidate)).toEqual(['C', 'B', 'C']);
    const ctx = { db, accountId, userId: agentId, role: 'agent', account: { id: accountId, name: 'Loop' } } as AccountContext;
    const refusal = (await publishChecks(ctx, accountId, candidate)) as unknown as { status: number };
    expect(refusal.status).toBe(422);
    // A chain that ends is allowed.
    expect(await publishChecks(ctx, accountId, { ...candidate, steps: [{ step_type: 'add_tag', step_config: { tag_id: tagZ } }] })).toBeNull();
  });

  it('does not see another workspace’s automations', async () => {
    const db = createScopedClient({ accountId: otherAccountId, userId: outsiderId, role: 'owner' });
    expect(await automationLoopChain(db, otherAccountId, { name: 'C', trigger_type: 'tag_added', trigger_config: { tag_id: tagY }, steps: [{ step_type: 'add_tag', step_config: { tag_id: tagX } }] })).toBeNull();
  });

  it('still stops a chain forced past the check at the depth-3 runtime cap', async () => {
    // Written directly (as an older save could have): each step re-arms the other's trigger.
    const p = await automation('P', { type: 'tag_added', tag: tagY }, [removeTag(tagY), removeTag(tagZ), addTag(tagZ)]);
    const q = await automation('Q', { type: 'tag_added', tag: tagZ }, [removeTag(tagZ), removeTag(tagY), addTag(tagY)]);
    const c = await contact('Chain');
    await owner.query('INSERT INTO contact_tags(account_id,contact_id,tag_id) VALUES($1,$2,$3)', [accountId, c, tagY]);
    // The engine runs in the worker's job scope (tenant-scoped client).
    await withJobScope({ accountId, role: 'owner' }, () =>
      runAutomationsForTrigger({ accountId, triggerType: 'tag_added', contactId: c, context: { tag_id: tagY } }));
    const runs = (await owner.query('SELECT count(*)::int AS n FROM automation_logs WHERE automation_id = ANY($1::uuid[]) AND contact_id=$2', [[p, q], c])).rows[0].n;
    expect(runs).toBeGreaterThan(1);
    expect(runs).toBeLessThanOrEqual(MAX_TAG_CHAIN_DEPTH + 1);
  });

  it('notifies current owners and admins once per run and step, as automation_notice', async () => {
    const autoId = await automation('Notice', { type: 'new_message_received' }, [], false);
    const input = { accountId, automationId: autoId, audience: 'admins' as const, title: 'Lead Asha', dedupeKey: `automation-notice:${randomUUID()}:s1` };
    expect((await notifyAutomationNotice(input)).sort()).toEqual([ownerId, adminId].sort());
    expect(await notifyAutomationNotice(input)).toEqual([]);
    const rows = (await owner.query('SELECT user_id::text, type, link FROM notifications WHERE account_id=$1 AND dedupe_key=$2', [accountId, input.dedupeKey])).rows;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.type === 'automation_notice' && r.link === `/automations/${autoId}/edit`)).toBe(true);
    expect(rows.map((r) => r.user_id)).not.toContain(agentId);
    expect(rows.map((r) => r.user_id)).not.toContain(outsiderId);
  });

  it("follows each member's automation_notice preference for in-app and email digest", async () => {
    const autoId = await automation('NoticePrefs', { type: 'new_message_received' }, [], false);
    await owner.query(`INSERT INTO notification_preferences(account_id,user_id,event,in_app,email) VALUES($1,$2,'automation_notice',false,true)
      ON CONFLICT (account_id,user_id,event) DO UPDATE SET in_app=false, email=true`, [accountId, adminId]);
    try {
      const input = { accountId, automationId: autoId, audience: 'admins' as const, title: 'Lead Ravi', dedupeKey: `automation-notice:${randomUUID()}:s1` };
      expect((await notifyAutomationNotice(input)).sort()).toEqual([ownerId, adminId].sort());
      const inApp = (await owner.query('SELECT user_id::text FROM notifications WHERE account_id=$1 AND dedupe_key=$2', [accountId, input.dedupeKey])).rows;
      expect(inApp.map((r) => r.user_id)).toEqual([ownerId]);
      const emails = (await owner.query('SELECT user_id::text, event FROM notification_email_queue WHERE account_id=$1 AND dedupe_key=$2', [accountId, input.dedupeKey])).rows;
      expect(emails).toEqual([{ user_id: adminId, event: 'automation_notice' }]);
      // A retried step adds nothing to either.
      expect(await notifyAutomationNotice(input)).toEqual([]);
      expect((await owner.query('SELECT count(*)::int AS n FROM notification_email_queue WHERE account_id=$1 AND dedupe_key=$2', [accountId, input.dedupeKey])).rows[0].n).toBe(1);
    } finally {
      await owner.query("DELETE FROM notification_preferences WHERE account_id=$1 AND user_id=$2 AND event='automation_notice'", [accountId, adminId]);
    }
  });

  it('notifies the assignee, and nobody for an unassigned or foreign conversation', async () => {
    const autoId = await automation('Notice2', { type: 'new_message_received' }, [], false);
    const c = await contact('Assigned');
    const conversationId = (await owner.query('INSERT INTO conversations(account_id,user_id,contact_id,assigned_agent_id) VALUES($1,$2,$3,$4) RETURNING id',
      [accountId, ownerId, c, agentId])).rows[0].id;
    const base = { accountId, automationId: autoId, audience: 'assignee' as const, title: 'Hello', conversationId, contactId: c };
    expect(await notifyAutomationNotice({ ...base, dedupeKey: `n:${randomUUID()}` })).toEqual([agentId]);
    // An unassigned conversation notifies nobody (an assignee must be a member: conversations' FK).
    await owner.query('UPDATE conversations SET assigned_agent_id=NULL WHERE id=$1', [conversationId]);
    expect(await notifyAutomationNotice({ ...base, dedupeKey: `n:${randomUUID()}` })).toEqual([]);
    // Another workspace's conversation id resolves to nothing under its tenant.
    expect(await notifyAutomationNotice({ ...base, accountId: otherAccountId, dedupeKey: `n:${randomUUID()}` })).toEqual([]);
  });

  it('resolves segment members at run time, skips opted-out ones, and applies once_per_contact', async () => {
    const inSeg = await contact('Seg one'), optedOut = await contact('Seg two', { opted_out: true }), outside = await contact('Not in seg');
    for (const id of [inSeg, optedOut]) await owner.query('INSERT INTO contact_tags(account_id,contact_id,tag_id) VALUES($1,$2,$3)', [accountId, id, tagX]);
    const segmentId = (await owner.query('INSERT INTO segments(account_id,user_id,name,filter) VALUES($1,$2,$3,$4) RETURNING id',
      [accountId, ownerId, `seg-${randomUUID().slice(0, 8)}`, { conditions: [{ field: 'tags', op: 'has_any', tagIds: [tagX] }] }])).rows[0].id;
    expect((await segmentRecipients(accountId, segmentId)).map((r) => r.id)).toEqual([inSeg]);
    // Dynamic: a newly tagged contact is included on the next occurrence.
    await owner.query('INSERT INTO contact_tags(account_id,contact_id,tag_id) VALUES($1,$2,$3)', [accountId, outside, tagX]);
    expect((await segmentRecipients(accountId, segmentId)).map((r) => r.id).sort()).toEqual([inSeg, outside].sort());
    // Another workspace cannot use it.
    await expect(segmentRecipients(otherAccountId, segmentId)).rejects.toThrow(/segment/);
    // once_per_contact reads automation_logs through its index.
    const autoId = await automation('Once', { type: 'time_based' }, [], false);
    await owner.query("INSERT INTO automation_logs(account_id,automation_id,user_id,contact_id,trigger_event,status) VALUES($1,$2,$3,$4,'time_based','success')",
      [accountId, autoId, ownerId, inSeg]);
    expect([...(await contactsAlreadyRun(accountId, autoId, [inSeg, outside]))]).toEqual([inSeg]);
    expect((await contactsAlreadyRun(otherAccountId, autoId, [inSeg])).size).toBe(0);
  });

  it('leaves already-run members out in SQL with once_per_contact, and refuses a segment naming a deleted tag', async () => {
    const tagged = await contact('Once one'), later = await contact('Once two');
    const tag = randomUUID();
    await owner.query('INSERT INTO tags(id,account_id,user_id,name) VALUES($1,$2,$3,$4)', [tag, accountId, ownerId, `once-${tag.slice(0, 8)}`]);
    for (const id of [tagged, later]) await owner.query('INSERT INTO contact_tags(account_id,contact_id,tag_id) VALUES($1,$2,$3)', [accountId, id, tag]);
    const segmentId = (await owner.query('INSERT INTO segments(account_id,user_id,name,filter) VALUES($1,$2,$3,$4) RETURNING id',
      [accountId, ownerId, `seg-${randomUUID().slice(0, 8)}`, { conditions: [{ field: 'tags', op: 'has_any', tagIds: [tag] }] }])).rows[0].id;
    const autoId = await automation('Once SQL', { type: 'time_based' }, [], false);
    await owner.query("INSERT INTO automation_logs(account_id,automation_id,user_id,contact_id,trigger_event,status) VALUES($1,$2,$3,$4,'time_based','success')",
      [accountId, autoId, ownerId, tagged]);
    expect((await segmentRecipients(accountId, segmentId, { onlyNewFor: autoId })).map((r) => r.id)).toEqual([later]);
    expect((await segmentRecipients(accountId, segmentId)).map((r) => r.id).sort()).toEqual([tagged, later].sort());

    // has_none on a tag that no longer exists would match every contact: refused instead.
    const gone = randomUUID();
    const excluding = (await owner.query('INSERT INTO segments(account_id,user_id,name,filter) VALUES($1,$2,$3,$4) RETURNING id',
      [accountId, ownerId, `seg-${randomUUID().slice(0, 8)}`, { conditions: [{ field: 'tags', op: 'has_none', tagIds: [gone] }] }])).rows[0].id;
    await expect(segmentRecipients(accountId, excluding)).rejects.toThrow(/segment/);
  });

  it('refuses at save time a schedule on a segment the plan archived', async () => {
    const segmentId = (await owner.query('INSERT INTO segments(account_id,user_id,name,filter,archived_at) VALUES($1,$2,$3,$4,now()) RETURNING id',
      [accountId, ownerId, `seg-${randomUUID().slice(0, 8)}`, { conditions: [{ field: 'tags', op: 'has_any', tagIds: [tagX] }] }])).rows[0].id;
    const issues = await segmentAudienceIssues({ accountId, userId: adminId, role: 'admin' }, 'time_based', { audience: { type: 'segment', segmentId } });
    expect(issues).toEqual([{ path: 'trigger.audience', message: expect.any(String) }]);
  });

  it('lets exactly one of two concurrent activations through when together they would loop', async () => {
    const tagA = randomUUID(), tagB = randomUUID();
    for (const id of [tagA, tagB]) await owner.query('INSERT INTO tags(id,account_id,user_id,name) VALUES($1,$2,$3,$4)', [id, accountId, ownerId, `race-${id.slice(0, 8)}`]);
    // Both saved but still off, as the routes write them before the locked flip.
    const first = await automation('Race A', { type: 'tag_added', tag: tagA }, [addTag(tagB)], false);
    const second = await automation('Race B', { type: 'tag_added', tag: tagB }, [addTag(tagA)], false);
    const tenant = { accountId, userId: adminId, role: 'admin' as const };
    const candidate = (name: string, on: string, adds: string) =>
      ({ name, trigger_type: 'tag_added', trigger_config: { tag_id: on }, steps: [{ step_type: 'add_tag', step_config: { tag_id: adds } }] });
    const results = await Promise.all([
      activateWithLoopLock(tenant, accountId, first, candidate('Race A', tagA, tagB)),
      activateWithLoopLock(tenant, accountId, second, candidate('Race B', tagB, tagA)),
    ]);
    expect(results.filter((r) => r === null)).toHaveLength(1);
    const active = (await owner.query('SELECT count(*)::int AS n FROM automations WHERE id = ANY($1::uuid[]) AND is_active', [[first, second]])).rows[0].n;
    expect(active).toBe(1);
    await owner.query('UPDATE automations SET is_active=false WHERE id = ANY($1::uuid[])', [[first, second]]);
  });
});
