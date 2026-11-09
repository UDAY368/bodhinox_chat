// Data retention on PostgreSQL with the constrained roles (audit finding 39): the
// closed-workspace purge (flag off = dry run; on = audit row, retained invoices, cascade),
// per-contact erasure and the hourly retention sweep. Every case keeps a second
// workspace with the same kind of data and proves it is untouched.
import { randomInt, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { runDataRetentionSweep } from '@/lib/jobs/data-retention';
import { requestContactErasure, runContactErasure } from './contact-erasure';
import { runWorkspacePurge } from './workspace-purge';

const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const A = randomUUID(), B = randomUUID(), C = randomUUID();
const ownerA = randomUUID(), ownerB = randomUUID(), ownerC = randomUUID();
const users = [ownerA, ownerB, ownerC];
const ON = { WORKSPACE_PURGE_ENABLED: 'true' };
const PHONE = `9190${randomInt(10_000_000, 99_999_999)}`;
const pnA = `71${randomInt(1e9, 9e9)}`, pnB = `72${randomInt(1e9, 9e9)}`, pnShared = `73${randomInt(1e9, 9e9)}`;
let db: pg.Client;
const q = (sql: string, params: unknown[] = []) => db.query(sql, params);
const count = async (sql: string, params: unknown[]) => Number((await q(sql, params)).rows[0].n);
const invoiceNumber = () => `RT/2026-27/${randomInt(100_000_000, 999_999_999)}`;

async function workspace(id: string, owner: string, name: string) {
  await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,$2,$3)", [id, name, owner]);
  await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner')", [id, owner]);
}

async function seedContact(account: string, owner: string, pn: string) {
  const contact = (await q("INSERT INTO contacts(account_id,user_id,name,phone) VALUES($1,$2,'Erase Me',$3) RETURNING id", [account, owner, PHONE])).rows[0].id as string;
  const conversation = (await q('INSERT INTO conversations(account_id,user_id,contact_id) VALUES($1,$2,$3) RETURNING id', [account, owner, contact])).rows[0].id as string;
  const key = `account-${account}/inbound/1234-photo.jpg`;
  await q("INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,media_url) VALUES($1,$2,'customer','image','private text',$3)",
    [account, conversation, `/api/media/object?${new URLSearchParams({ bucket: 'chat-media', key })}`]);
  await q("INSERT INTO media_objects(account_id,object_key,bucket,content_type,byte_size) VALUES($1,$2,'chat-media','image/jpeg',10)", [account, key]);
  const broadcast = (await q("INSERT INTO broadcasts(account_id,user_id,name,template_name,status) VALUES($1,$2,'Promo','promo','sent') RETURNING id", [account, owner])).rows[0].id;
  await q(`INSERT INTO broadcast_recipients(account_id,broadcast_id,contact_id,status,template_params,error_message)
    VALUES($1,$2,$3,'failed','{"name":"Erase Me"}'::jsonb,'bad number')`, [account, broadcast, contact]);
  await q("INSERT INTO notifications(account_id,user_id,contact_id,type,title,body) VALUES($1,$2,$3,'mention','Erase Me wrote','private text')", [account, owner, contact]);
  await q("INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,access_token,status) VALUES($1,$2,$3,'unused','disconnected')", [account, owner, pn]);
  const receipt = (await q("INSERT INTO webhook_receipts(provider,dedupe_key,payload,status) VALUES('meta',$1,$2::jsonb,'processed') RETURNING id", [randomUUID(),
    JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: pn }, contacts: [{ wa_id: PHONE }], messages: [{ from: PHONE, text: { body: 'private text' } }] } }] }] })])).rows[0].id as string;
  const delivery = (await q("INSERT INTO jobs(type,tenant_id,payload,status) VALUES('webhook.delivery',$1,$2::jsonb,'done') RETURNING id",
    [account, JSON.stringify({ payload: JSON.stringify({ data: { contact_id: contact, phone: PHONE, text: 'private text' } }) })])).rows[0].id as string;
  return { contact, conversation, key, receipt, delivery };
}

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('[SEC-01][BIL-03] Data retention on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await q('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const worker = await getWorkerPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (worker[0].role !== 'bodhinox_worker') throw new Error('Requires constrained test worker credentials');
    await q("INSERT INTO auth_users(id,email,full_name) SELECT x, x::text || '@example.invalid', 'Retention' FROM unnest($1::uuid[]) x", [users]);
  }, 60_000);

  beforeEach(() => {
    // No object storage in this suite: storage clean-up reports "not cleared" instead of calling S3.
    for (const name of ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) delete process.env[name];
  });

  afterAll(async () => {
    if (!db) return;
    const accounts = [A, B, C];
    await q('DELETE FROM jobs WHERE tenant_id = ANY($1::uuid[])', [accounts]);
    await q('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [accounts]);
    await q('DELETE FROM workspace_purges WHERE account_id = ANY($1::uuid[])', [accounts]);
    await q('DELETE FROM purged_invoices WHERE account_id = ANY($1::uuid[])', [accounts]);
    await q('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [users]);
    await db.end();
    await disconnectDatabases();
  }, 60_000);

  it('erases one contact everywhere in its workspace and leaves the same number in another workspace alone', async () => {
    await workspace(A, ownerA, 'Retention A');
    await workspace(B, ownerB, 'Retention B');
    const a = await seedContact(A, ownerA, pnA);
    const b = await seedContact(B, ownerB, pnB);
    // A number A once held (row kept, disconnected) and B now holds: its receipts are not A's to erase.
    await q("INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,access_token,status) VALUES($1,$2,$3,'','disconnected')", [A, ownerA, pnShared]);
    await q("INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,access_token,status) VALUES($1,$2,$3,'unused','connected')", [B, ownerB, pnShared]);
    const sharedReceipt = (await q("INSERT INTO webhook_receipts(provider,dedupe_key,payload,status) VALUES('meta',$1,$2::jsonb,'processed') RETURNING id", [randomUUID(),
      JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: pnShared }, messages: [{ from: PHONE, text: { body: 'B text' } }] } }] }] })])).rows[0].id as string;
    // Pending deliveries: one about the erased contact (cancelled), one about another number that
    // contains the erased number's digits (kept: it is sent as queued).
    const pendingOwn = (await q("INSERT INTO jobs(type,tenant_id,payload) VALUES('webhook.delivery',$1,$2::jsonb) RETURNING id",
      [A, JSON.stringify({ payload: JSON.stringify({ data: { contact_id: a.contact } }) })])).rows[0].id as string;
    const pendingOther = (await q("INSERT INTO jobs(type,tenant_id,payload) VALUES('webhook.delivery',$1,$2::jsonb) RETURNING id",
      [A, JSON.stringify({ payload: JSON.stringify({ data: { phone: `${PHONE}9` } }) })])).rows[0].id as string;

    // The app role audits and queues the request; another workspace's contact is not found.
    const actor = { accountId: A, userId: ownerA, role: 'owner' as const };
    await expect(requestContactErasure(actor, b.contact)).rejects.toMatchObject({ code: 'not_found' });
    await requestContactErasure(actor, a.contact);
    const job = (await q("SELECT id, payload FROM jobs WHERE tenant_id=$1 AND type='contact.erase'", [A])).rows;
    expect(job).toEqual([{ id: expect.any(String), payload: { contactId: a.contact, requestedBy: ownerA } }]);
    expect(await count("SELECT count(*) AS n FROM audit_logs WHERE account_id=$1 AND action='contact.erasure_requested' AND resource_id=$2", [A, a.contact])).toBe(1);

    const counts = await runContactErasure(A, job[0].payload, job[0].id);
    expect(counts).toMatchObject({ contacts: 1, mediaFiles: 1, webhookReceipts: 1, jobPayloads: 2, campaignRecipients: 1, notifications: 1 });
    expect(await count('SELECT count(*) AS n FROM contacts WHERE id=$1', [a.contact])).toBe(0);
    expect(await count('SELECT count(*) AS n FROM messages WHERE conversation_id=$1', [a.conversation])).toBe(0);
    expect(await count('SELECT count(*) AS n FROM media_objects WHERE account_id=$1 AND object_key=$2', [A, a.key])).toBe(0);
    expect((await q('SELECT template_params, error_message FROM broadcast_recipients WHERE account_id=$1', [A])).rows)
      .toEqual([{ template_params: null, error_message: null }]);
    expect(await count('SELECT count(*) AS n FROM notifications WHERE account_id=$1', [A])).toBe(0);
    expect(await count('SELECT count(*) AS n FROM webhook_receipts WHERE id=$1', [a.receipt])).toBe(0);
    expect((await q('SELECT payload FROM jobs WHERE id=$1', [a.delivery])).rows[0].payload).toEqual({});
    expect(await count(`SELECT count(*) AS n FROM outbox_events WHERE account_id=$1 AND payload::text LIKE '%' || $2 || '%'`, [A, a.contact])).toBe(0);
    expect((await q("SELECT metadata FROM audit_logs WHERE account_id=$1 AND action='contact.erased'", [A])).rows[0].metadata).toMatchObject({ contacts: 1 });
    expect(await count('SELECT count(*) AS n FROM webhook_receipts WHERE id=$1', [sharedReceipt])).toBe(1);
    expect(await count('SELECT count(*) AS n FROM jobs WHERE id=$1', [pendingOwn])).toBe(0);
    expect(await count('SELECT count(*) AS n FROM jobs WHERE id=$1', [pendingOther])).toBe(1);
    await q('DELETE FROM jobs WHERE id=$1', [pendingOther]);
    // Running again (a retried job) is a no-op.
    expect(await runContactErasure(A, job[0].payload, job[0].id)).toBeNull();

    // Workspace B, with the same customer number, is untouched.
    expect(await count('SELECT count(*) AS n FROM contacts WHERE id=$1', [b.contact])).toBe(1);
    expect(await count('SELECT count(*) AS n FROM messages WHERE conversation_id=$1', [b.conversation])).toBe(1);
    expect(await count('SELECT count(*) AS n FROM media_objects WHERE account_id=$1', [B])).toBe(1);
    expect(await count('SELECT count(*) AS n FROM webhook_receipts WHERE id=$1', [b.receipt])).toBe(1);
    expect((await q('SELECT payload FROM jobs WHERE id=$1', [b.delivery])).rows[0].payload).not.toEqual({});
    expect((await q('SELECT template_params FROM broadcast_recipients WHERE account_id=$1', [B])).rows[0].template_params).toEqual({ name: 'Erase Me' });
    expect(await count('SELECT count(*) AS n FROM notifications WHERE account_id=$1', [B])).toBe(1);
  });

  it('purges only a due workspace: a dry run while off, then audit row, kept invoices and cascade when on', async () => {
    await workspace(C, ownerC, 'Retention C');
    await q("INSERT INTO contacts(account_id,user_id,name,phone) VALUES($1,$2,'C contact','14155550123')", [C, ownerC]);
    await q("INSERT INTO account_lifecycle(account_id,status,deletion_requested_at,purge_after) VALUES($1,'closing',now()-interval '31 days',now()-interval '1 day')", [C]);
    // B is closing too, but its grace period has not ended.
    await q("INSERT INTO account_lifecycle(account_id,status,deletion_requested_at,purge_after) VALUES($1,'closing',now(),now()+interval '30 days')", [B]);
    const invoiceC = invoiceNumber(), invoiceB = invoiceNumber();
    await withTenant({ accountId: C, role: 'owner' }, (tx) => tx.$executeRaw`INSERT INTO invoices(number,subtotal_minor,total_minor) VALUES(${invoiceC},100,118)`, getWorkerPrisma());
    await withTenant({ accountId: B, role: 'owner' }, (tx) => tx.$executeRaw`INSERT INTO invoices(number,subtotal_minor,total_minor) VALUES(${invoiceB},100,118)`, getWorkerPrisma());

    // The function only acts on the workspace named by the caller's tenant scope.
    const mismatch = await withTenant({ accountId: B, role: 'owner' }, (tx) => tx.$queryRaw<{ reason: string }[]>`
      SELECT crm_workspace_purge_finish(${C}::uuid, '{}'::jsonb, 0) AS reason`, getWorkerPrisma());
    expect(mismatch[0].reason).toBe('scope_mismatch');
    // The app role cannot call it at all.
    await expect(withTenant({ accountId: C, role: 'owner' }, (tx) => tx.$queryRaw`SELECT crm_workspace_purge_finish(${C}::uuid, '{}'::jsonb, 0)`, getPrisma()))
      .rejects.toThrow();

    // Flag off: counts only.
    const dry = await runWorkspacePurge(C, {});
    expect(dry).toMatchObject({ state: 'dry_run', reason: null, counts: { contacts: 1, invoices: 1 } });
    expect(await count('SELECT count(*) AS n FROM accounts WHERE id=$1', [C])).toBe(1);
    expect(await count('SELECT count(*) AS n FROM workspace_purges WHERE account_id=$1', [C])).toBe(0);

    // Not due: refused, nothing deleted.
    expect(await runWorkspacePurge(B, ON)).toEqual({ state: 'skipped', reason: 'not_due' });
    expect(await count('SELECT count(*) AS n FROM accounts WHERE id=$1', [B])).toBe(1);

    const purged = await runWorkspacePurge(C, ON);
    expect(purged).toMatchObject({ state: 'purged', invoicesRetained: 1, storageCleared: false, counts: { contacts: 1 } });
    expect(await count('SELECT count(*) AS n FROM accounts WHERE id=$1', [C])).toBe(0);
    expect(await count('SELECT count(*) AS n FROM contacts WHERE account_id=$1', [C])).toBe(0);
    expect(await count('SELECT count(*) AS n FROM account_lifecycle WHERE account_id=$1', [C])).toBe(0);
    expect((await q('SELECT counts, invoices_retained, storage_cleared_at FROM workspace_purges WHERE account_id=$1', [C])).rows)
      .toEqual([{ counts: expect.objectContaining({ contacts: 1 }), invoices_retained: 1, storage_cleared_at: null }]);
    expect((await q('SELECT number FROM purged_invoices WHERE account_id=$1', [C])).rows).toEqual([{ number: invoiceC }]);
    // Listed again for storage clean-up (as purged), never as due.
    expect((await q('SELECT purged FROM crm_accounts_due_for_purge() WHERE account_id=$1', [C])).rows).toEqual([{ purged: true }]);

    // Workspace B is untouched: its row, lifecycle, invoice and contact remain.
    expect(await count('SELECT count(*) AS n FROM accounts WHERE id=$1', [B])).toBe(1);
    expect(await count('SELECT count(*) AS n FROM invoices WHERE account_id=$1 AND number=$2', [B, invoiceB])).toBe(1);
    expect(await count('SELECT count(*) AS n FROM contacts WHERE account_id=$1', [B])).toBe(1);
    expect(await count('SELECT count(*) AS n FROM purged_invoices WHERE account_id=$1', [B])).toBe(0);
  });

  it('sweeps only finished jobs, processed receipts and old realtime events, in every workspace', async () => {
    const job = async (tenant: string | null, status: string, days: number) => (await q(
      "INSERT INTO jobs(type,tenant_id,payload,status,updated_at) VALUES('flow.sweep',$1,'{}'::jsonb,$2,now()-make_interval(days=>$3)) RETURNING id",
      [tenant, status, days])).rows[0].id as string;
    const oldDoneA = await job(A, 'done', 31), oldDoneB = await job(B, 'done', 31), recentDone = await job(A, 'done', 2);
    const oldFailed = await job(B, 'failed', 91), recentFailed = await job(B, 'failed', 31), oldPending = await job(A, 'pending', 60);
    const receipt = async (status: string, days: number) => (await q(
      "INSERT INTO webhook_receipts(provider,dedupe_key,payload,status,created_at) VALUES('meta',$1,'{}'::jsonb,$2,now()-make_interval(days=>$3)) RETURNING id",
      [randomUUID(), status, days])).rows[0].id as string;
    const oldProcessed = await receipt('processed', 31), oldPendingReceipt = await receipt('pending', 31), recentProcessed = await receipt('processed', 1);
    const event = async (account: string, days: number) => (await q(
      "INSERT INTO outbox_events(account_id,event_type,payload,created_at) VALUES($1,'contacts.UPDATE','{}'::jsonb,now()-make_interval(days=>$2)) RETURNING id",
      [account, days])).rows[0].id as string;
    const oldA = await event(A, 8), oldB = await event(B, 8), recentB = await event(B, 1);

    await runDataRetentionSweep();
    const left = async (table: string, ids: string[]) => (await q(`SELECT id::text FROM ${table} WHERE id = ANY($1::uuid[])`, [ids])).rows.map((r) => r.id).sort();
    expect(await left('jobs', [oldDoneA, oldDoneB, recentDone, oldFailed, recentFailed, oldPending])).toEqual([recentDone, recentFailed, oldPending].sort());
    expect(await left('webhook_receipts', [oldProcessed, oldPendingReceipt, recentProcessed])).toEqual([oldPendingReceipt, recentProcessed].sort());
    expect(await left('outbox_events', [oldA, oldB, recentB])).toEqual([recentB]);
  });
});
