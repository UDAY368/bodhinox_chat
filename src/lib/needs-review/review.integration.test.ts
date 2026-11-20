import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { dispatchOnce } from '@/lib/jobs/dispatch';
import { withLeaseScope } from '@/lib/jobs/lease';
import { countNeedsReview, listNeedsReview, NeedsReviewError, resolveNeedsReview } from './review';

// The "needs review" list on PostgreSQL: tenancy, one send at most for "send again" (also
// clicked twice at once), module records resolved, audit rows, and the stuck-sending rule.
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const ownerA = randomUUID(), ownerB = randomUUID();
const asA = { accountId: accountA, userId: ownerA, role: 'owner' as const };
const asB = { accountId: accountB, userId: ownerB, role: 'owner' as const };
const contactA = randomUUID(), contactB = randomUUID();
let db: pg.Client;

/** An uncertain intent of `account` for `key`, optionally claimed by a job with the given status. */
async function intent(account: string, key: string, options: { status?: string; minutesOld?: number; job?: { status: string; leaseMinutes?: number } } = {}) {
  let jobId: string | null = null;
  if (options.job) {
    jobId = randomUUID();
    await db.query(`INSERT INTO jobs(id,type,tenant_id,payload,status,dedupe_key,attempts,lease_until)
      VALUES($1,'commerce.order_followup',$2,$3,$4,$5,1,$6)`,
    [jobId, account, JSON.stringify({ orderId: 'x', kind: 'dispatched' }), options.job.status, `test-job:${jobId}`,
      options.job.leaseMinutes === undefined ? null : new Date(Date.now() + options.job.leaseMinutes * 60_000)]);
  }
  const old = new Date(Date.now() - (options.minutesOld ?? 0) * 60_000);
  const { rows } = await db.query(`INSERT INTO outbound_intents(account_id,idempotency_key,status,job_id,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$5) RETURNING id::text AS id`, [account, `${account}:${key}`, options.status ?? 'unknown', jobId, old]);
  return { id: rows[0].id as string, jobId };
}

async function order(account: string, contact: string) {
  const id = randomUUID();
  await db.query(`INSERT INTO orders(id,account_id,source,contact_id,currency,subtotal_minor,status) VALUES($1,$2,'manual',$3,'INR',100,'paid')`,
    [id, account, contact]);
  return id;
}

const audits = async (resource: string) => (await db.query(
  'SELECT action, user_id::text AS user_id, metadata FROM audit_logs WHERE resource_id=$1', [resource])).rows;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('needs review on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Review', 'test-only-hash' FROM unnest($1::uuid[]) x", [[ownerA, ownerB]]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Review A',$2),($3,'Review B',$4)", [accountA, ownerA, accountB, ownerB]);
    await db.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES ($1,$2,'owner'),($3,$4,'owner')", [accountA, ownerA, accountB, ownerB]);
    await db.query("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'Asha','14155550501'),($4,$5,$6,'Bo','14155550502')",
      [contactA, accountA, ownerA, contactB, accountB, ownerB]);
  });

  afterAll(async () => {
    await db.query('DELETE FROM jobs WHERE tenant_id = ANY($1::uuid[])', [[accountA, accountB]]);
    await db.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[accountA, accountB]]);
    await db.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[ownerA, ownerB]]);
    await db.end();
    await disconnectDatabases();
  });

  it("lists only the workspace's own uncertain sends, with the contact link and no message text", async () => {
    const orderA = await order(accountA, contactA);
    const a = await intent(accountA, `order:${orderA}:dispatched`);
    const b = await intent(accountB, `order:${await order(accountB, contactB)}:dispatched`);
    const pageA = await listNeedsReview(asA, { kind: 'order' });
    expect(pageA.items.map((i) => i.id)).toContain(a.id);
    expect(pageA.items.map((i) => i.id)).not.toContain(b.id);
    const row = pageA.items.find((i) => i.id === a.id)!;
    expect(row).toMatchObject({ kind: 'order', reason: 'outcome_unknown', contact: { id: contactA, name: 'Asha' }, can_send_again: false });
    expect(Object.keys(row).sort()).toEqual(['can_send_again', 'contact', 'conversation_id', 'created_at', 'id', 'kind', 'reason']);
    expect((await listNeedsReview(asB)).items.map((i) => i.id)).not.toContain(a.id);
    expect((await listNeedsReview(asA, { kind: 'flow' })).items.map((i) => i.id)).not.toContain(a.id);
    expect(await countNeedsReview(asA)).toBe(pageA.total);
  });

  it('another workspace can neither resolve nor change a send', async () => {
    const key = `commerce:${randomUUID()}`;
    const a = await intent(accountA, key);
    for (const action of ['was_sent', 'send_again'] as const)
      await expect(resolveNeedsReview(asB, a.id, action)).rejects.toMatchObject({ code: 'not_found' });
    const { rows } = await db.query('SELECT status, idempotency_key FROM outbound_intents WHERE id=$1', [a.id]);
    expect(rows[0]).toEqual({ status: 'unknown', idempotency_key: `${accountA}:${key}` });
    expect(await audits(a.id)).toEqual([]);
  });

  it('was_sent accepts the intent, resolves the order message and writes an audit row', async () => {
    const orderA = await order(accountA, contactA);
    await db.query("INSERT INTO order_messages(account_id,order_id,kind,status,reason) VALUES($1,$2,'dispatched','outcome_unknown','uncertain')", [accountA, orderA]);
    const a = await intent(accountA, `order:${orderA}:dispatched`);
    expect(await resolveNeedsReview(asA, a.id, 'was_sent')).toEqual({ id: a.id, action: 'was_sent', requeued: false });
    const { rows } = await db.query('SELECT status, result FROM outbound_intents WHERE id=$1', [a.id]);
    expect(rows[0]).toEqual({ status: 'accepted', result: {} });
    const ledger = await db.query('SELECT resolved_by::text AS by FROM order_messages WHERE account_id=$1 AND order_id=$2', [accountA, orderA]);
    expect(ledger.rows[0].by).toBe(ownerA);
    expect(await audits(a.id)).toEqual([{ action: 'needs_review.was_sent', user_id: ownerA, metadata: { kind: 'order', status: 'unknown', requeued: false } }]);
    // Resolved: off the list, and a second decision is refused.
    expect((await listNeedsReview(asA)).items.map((i) => i.id)).not.toContain(a.id);
    await expect(resolveNeedsReview(asA, a.id, 'send_again')).rejects.toBeInstanceOf(NeedsReviewError);
    // A later run of the job finds it accepted and sends nothing.
    const send = vi.fn(async () => ({ whatsapp_message_id: 'wamid.new' }));
    await dispatchOnce(accountA, `order:${orderA}:dispatched`, send);
    expect(send).not.toHaveBeenCalled();
  });

  it('send_again clicked twice at once queues its job once, and the job then sends exactly once', async () => {
    const orderA = await order(accountA, contactA);
    const key = `order:${orderA}:delivered`;
    const a = await intent(accountA, key, { job: { status: 'failed' } });
    expect((await listNeedsReview(asA)).items.find((i) => i.id === a.id)?.can_send_again).toBe(true);
    const outcomes = await Promise.allSettled([resolveNeedsReview(asA, a.id, 'send_again'), resolveNeedsReview(asA, a.id, 'send_again')]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const refused = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: 'not_open' });
    const copies = await db.query("SELECT type, status, payload FROM jobs WHERE tenant_id=$1 AND dedupe_key=$2", [accountA, `needs-review:${a.id}`]);
    expect(copies.rows).toEqual([{ type: 'commerce.order_followup', status: 'pending', payload: { orderId: 'x', kind: 'dispatched' } }]);
    const retired = await db.query('SELECT status, idempotency_key FROM outbound_intents WHERE id=$1', [a.id]);
    expect(retired.rows[0]).toEqual({ status: 'failed', idempotency_key: `${accountA}:${key}#reviewed:${a.id}` });
    expect(await audits(a.id)).toEqual([{ action: 'needs_review.send_again', user_id: ownerA, metadata: { kind: 'order', status: 'unknown', requeued: true } }]);
    // The queued job's dispatchOnce claims the freed key and sends once; a replay returns the stored result.
    const jobId = randomUUID();
    const send = vi.fn(async () => ({ whatsapp_message_id: 'wamid.again' }));
    await withLeaseScope(() => {}, () => dispatchOnce(accountA, key, send), jobId);
    await withLeaseScope(() => {}, () => dispatchOnce(accountA, key, send), jobId);
    expect(send).toHaveBeenCalledTimes(1);
    const claimed = await db.query('SELECT status, job_id::text AS job_id FROM outbound_intents WHERE idempotency_key=$1', [`${accountA}:${key}`]);
    expect(claimed.rows[0]).toEqual({ status: 'accepted', job_id: jobId });
  });

  it('a job still pending is not copied; a send outside any job is retired without a queue', async () => {
    const pending = await intent(accountA, `scheduled-reply:${randomUUID()}`, { job: { status: 'pending' } });
    expect(await resolveNeedsReview(asA, pending.id, 'send_again')).toMatchObject({ requeued: true });
    expect((await db.query('SELECT 1 FROM jobs WHERE dedupe_key=$1', [`needs-review:${pending.id}`])).rows).toHaveLength(0);
    const loose = await intent(accountA, `ig_send:${randomUUID()}`);
    expect(await resolveNeedsReview(asA, loose.id, 'send_again')).toMatchObject({ requeued: false });
    expect((await db.query('SELECT status FROM outbound_intents WHERE id=$1', [loose.id])).rows[0].status).toBe('failed');
  });

  it("lists a send stuck in 'dispatching' only after 10 minutes and only when its job is not running", async () => {
    const fresh = await intent(accountA, `ig_send:${randomUUID()}`, { status: 'dispatching', minutesOld: 2 });
    const stuck = await intent(accountA, `ig_send:${randomUUID()}`, { status: 'dispatching', minutesOld: 15 });
    const running = await intent(accountA, `ig_send:${randomUUID()}`, { status: 'dispatching', minutesOld: 15, job: { status: 'running', leaseMinutes: 1 } });
    const ids = (await listNeedsReview(asA, { kind: 'other' })).items.map((i) => i.id);
    expect(ids).toContain(stuck.id);
    expect(ids).not.toContain(fresh.id);
    expect(ids).not.toContain(running.id);
    expect((await listNeedsReview(asA, { kind: 'other' })).items.find((i) => i.id === stuck.id)?.reason).toBe('stuck_sending');
    await expect(resolveNeedsReview(asA, running.id, 'send_again')).rejects.toMatchObject({ code: 'not_open' });
  });

  it('a send another screen already resolved is not listed', async () => {
    const orderA = await order(accountA, contactA);
    await db.query(`INSERT INTO order_messages(account_id,order_id,kind,status,reason,resolved_at,resolved_by)
      VALUES($1,$2,'feedback','outcome_unknown','uncertain',now(),$3)`, [accountA, orderA, ownerA]);
    const a = await intent(accountA, `order:${orderA}:feedback`);
    expect((await listNeedsReview(asA)).items.map((i) => i.id)).not.toContain(a.id);
  });
});
