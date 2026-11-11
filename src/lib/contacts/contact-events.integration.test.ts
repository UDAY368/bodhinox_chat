// Stage 5 (5D) on PostgreSQL: contact events that start automations.
// - Removing a tag queues tag_removed, and a field write queues field_changed,
//   for the workspace's matching active automations only, in the same
//   transaction as the change (a rolled-back change queues nothing).
// - Job payloads carry ids and presence, never field values.
// - One run per automation, contact and event id: a duplicated job runs once,
//   and an automation whose own step writes the field it listens to does not
//   start itself again.
// - Another workspace's contact or automation is never touched.
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { createAdminClient } from '@/lib/data/admin';
import { withJobScope } from '@/lib/jobs/scope';
import { queueContactEvent, removeContactTag } from './tag-write';
import { writeContactField } from './field-write';
import { executeScheduledOccurrence } from '@/lib/jobs/scheduled-audience';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const A = randomUUID(), B = randomUUID(), ownerA = randomUUID(), ownerB = randomUUID();
const tagA = randomUUID(), otherTagA = randomUUID(), tagB = randomUUID();
const seed = String(Date.now()).slice(-6);
let db: pg.Client;
const q = (sql: string, params: unknown[] = []) => db.query(sql, params);

async function automation(account: string, user: string, trigger: string, config: Record<string, unknown>,
  steps: { type: string; config: Record<string, unknown> }[] = [], active = true): Promise<string> {
  const id = (await q(`INSERT INTO automations(account_id,user_id,name,trigger_type,trigger_config,is_active)
    VALUES($1,$2,'Contact event',$3,$4,$5) RETURNING id`, [account, user, trigger, config, active])).rows[0].id;
  for (const [position, step] of steps.entries())
    await q('INSERT INTO automation_steps(account_id,automation_id,step_type,step_config,position) VALUES($1,$2,$3,$4,$5)',
      [account, id, step.type, step.config, position]);
  return id;
}
let n = 0;
const contact = async (account: string, user: string, company: string | null = null): Promise<string> =>
  (await q('INSERT INTO contacts(account_id,user_id,phone,name,company) VALUES($1,$2,$3,$4,$5) RETURNING id',
    [account, user, `1416${seed}${++n}0`, 'Event', company])).rows[0].id;
const jobs = async (automationId: string, contactId: string) => (await q(
  "SELECT payload, dedupe_key FROM jobs WHERE type='automation.trigger' AND payload->>'automationId'=$1 AND payload->>'contactId'=$2 ORDER BY created_at",
  [automationId, contactId])).rows as { payload: Record<string, unknown>; dedupe_key: string }[];
const runs = async (automationId: string, contactId: string) =>
  (await q('SELECT count(*)::int AS n FROM automation_logs WHERE automation_id=$1 AND contact_id=$2', [automationId, contactId])).rows[0].n as number;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('contact events start automations (Stage 5)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await q('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    for (const id of [ownerA, ownerB])
      await q("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Events','test-only-hash')", [id, `${id}@example.invalid`]);
    for (const [account, user] of [[A, ownerA], [B, ownerB]]) {
      await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Contact events',$2)", [account, user]);
      await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner')", [account, user]);
    }
    for (const [id, account, user, name] of [[tagA, A, ownerA, 'vip'], [otherTagA, A, ownerA, 'lead'], [tagB, B, ownerB, 'vip']])
      await q('INSERT INTO tags(id,account_id,user_id,name) VALUES($1,$2,$3,$4)', [id, account, user, `${name}-${seed}`]);
  });
  afterAll(async () => {
    if (db) {
      await q('DELETE FROM jobs WHERE tenant_id = ANY($1::uuid[])', [[A, B]]).catch(() => undefined);
      await q('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[A, B]]).catch(() => undefined);
      await q('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[ownerA, ownerB]]).catch(() => undefined);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('queues tag_removed for the matching automations of this workspace only, once per removal', async () => {
    const onTag = await automation(A, ownerA, 'tag_removed', { tag_id: tagA });
    const onOther = await automation(A, ownerA, 'tag_removed', { tag_id: otherTagA });
    const paused = await automation(A, ownerA, 'tag_removed', { tag_id: tagA }, [], false);
    // Another workspace naming A's tag id in its config is never queued for A's contact.
    const foreign = await automation(B, ownerB, 'tag_removed', { tag_id: tagA });
    const c = await contact(A, ownerA);
    await q('INSERT INTO contact_tags(account_id,contact_id,tag_id) VALUES($1,$2,$3)', [A, c, tagA]);

    const admin = createAdminClient({ accountId: A, role: 'owner' });
    expect(await removeContactTag(admin, { accountId: A, contactId: c, tagId: tagA })).toBe(true);
    const queued = await jobs(onTag, c);
    expect(queued).toHaveLength(1);
    expect(queued[0].payload).toMatchObject({ automationId: onTag, contactId: c, slot: expect.stringMatching(/^event:[0-9a-f-]{36}$/),
      event: { type: 'tag_removed', tag_id: tagA } });
    for (const other of [onOther, paused, foreign]) expect(await jobs(other, c)).toEqual([]);
    // Nothing left to remove: no event.
    expect(await removeContactTag(admin, { accountId: A, contactId: c, tagId: tagA })).toBe(false);
    expect(await jobs(onTag, c)).toHaveLength(1);
  });

  it('queues nothing when the change rolls back (the event is queued with the change, before acknowledgement)', async () => {
    const onTag = await automation(A, ownerA, 'tag_removed', { tag_id: otherTagA });
    const c = await contact(A, ownerA);
    await expect(withTenant({ accountId: A, role: 'owner' }, async (tx) => {
      await queueContactEvent(tx, { accountId: A, contactId: c, event: { type: 'tag_removed', tagId: otherTagA } });
      throw new Error('rolled back');
    }, getWorkerPrisma())).rejects.toThrow('rolled back');
    expect(await jobs(onTag, c)).toEqual([]);
  });

  it('queues field_changed with presence only, never the value, and only when the value really changes', async () => {
    const onEmail = await automation(A, ownerA, 'field_changed', { field: 'email' });
    const field = (await q("INSERT INTO custom_fields(account_id,user_id,field_name,field_type) VALUES($1,$2,$3,'text') RETURNING id",
      [A, ownerA, `plan-${seed}`])).rows[0].id;
    const onCustom = await automation(A, ownerA, 'field_changed', { field: `custom:${field}` });
    const c = await contact(A, ownerA);
    const admin = createAdminClient({ accountId: A, role: 'owner' });

    expect(await writeContactField(admin, A, c, 'email', 'secret.value@example.invalid')).toBe(true);
    expect(await writeContactField(admin, A, c, 'email', 'secret.value@example.invalid')).toBe(true);
    const queued = await jobs(onEmail, c);
    expect(queued).toHaveLength(1);
    expect(queued[0].payload).toMatchObject({ event: { type: 'field_changed', field: 'email', had_value: false, has_value: true } });
    expect(JSON.stringify(queued[0].payload)).not.toContain('secret.value');

    expect(await writeContactField(admin, A, c, `custom:${field}`, 'Gold')).toBe(true);
    expect(await writeContactField(admin, A, c, `custom:${field}`, '')).toBe(true);
    const custom = await jobs(onCustom, c);
    expect(custom.map((job) => job.payload.event)).toEqual([
      { type: 'field_changed', field: `custom:${field}`, had_value: false, has_value: true },
      { type: 'field_changed', field: `custom:${field}`, had_value: true, has_value: false },
    ]);
    expect(JSON.stringify(custom)).not.toContain('Gold');
  });

  it("refuses another workspace's contact and custom field, writing and queueing nothing", async () => {
    const onEmail = await automation(A, ownerA, 'field_changed', { field: 'name' });
    const foreignContact = await contact(B, ownerB);
    const admin = createAdminClient({ accountId: A, role: 'owner' });
    expect(await writeContactField(admin, A, foreignContact, 'name', 'Taken over')).toBe(false);
    expect((await q('SELECT name FROM contacts WHERE id=$1', [foreignContact])).rows[0].name).toBe('Event');
    expect(await jobs(onEmail, foreignContact)).toEqual([]);
    await expect(removeContactTag(admin, { accountId: A, contactId: foreignContact, tagId: tagA })).rejects.toThrow();
  });

  it('runs a queued event once, even when the job runs twice, and an automation cannot start itself through its own write', async () => {
    // Listens to company and writes company: without the guard it would queue itself forever.
    const loop = await automation(A, ownerA, 'field_changed', { field: 'company' },
      [{ type: 'update_contact_field', config: { field: 'company', value: 'Written by the automation' } }]);
    const c = await contact(A, ownerA, 'Before');
    const admin = createAdminClient({ accountId: A, role: 'owner' });
    expect(await writeContactField(admin, A, c, 'company', 'Changed by an agent')).toBe(true);
    const [job] = await jobs(loop, c);
    expect(job).toBeDefined();
    const slot = String(job.payload.slot);
    for (let i = 0; i < 2; i += 1)
      await withJobScope({ accountId: A, role: 'owner' }, () =>
        executeScheduledOccurrence(createAdminClient(), A, loop, slot, c, () => undefined));
    expect(await runs(loop, c)).toBe(1);
    expect((await q('SELECT company FROM contacts WHERE id=$1', [c])).rows[0].company).toBe('Written by the automation');
    // Its own write carried the same event id, so no second job was queued.
    expect(await jobs(loop, c)).toHaveLength(1);
  });

  it('keeps one job per automation, contact and event id', async () => {
    const onTag = await automation(A, ownerA, 'tag_removed', { tag_id: tagA });
    const c = await contact(A, ownerA);
    const eventId = randomUUID();
    for (let i = 0; i < 2; i += 1)
      await withTenant({ accountId: A, role: 'owner' }, (tx) =>
        queueContactEvent(tx, { accountId: A, contactId: c, eventId, event: { type: 'tag_removed', tagId: tagA } }), getWorkerPrisma());
    const queued = await jobs(onTag, c);
    expect(queued.map((row) => row.dedupe_key)).toEqual([`contact-event:${onTag}:${c}:${eventId}`]);
  });
});
