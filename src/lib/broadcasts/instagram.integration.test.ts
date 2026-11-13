// Instagram broadcasts and campaign pause on PostgreSQL: only contacts whose
// 24-hour window is open become recipients, each send goes through its
// outbound intent, a closed window or an opt-out fails the row without an
// intent, an ambiguous outcome is flagged for reconciliation, Pause stops a
// pass and blocks the dispatcher, and another workspace can neither pause nor
// read any of it.
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import type { TenantContext } from '@/lib/db/tenant';
import { encrypt } from '@/lib/whatsapp/encryption';
import { broadcastIntentKey, UNCERTAIN_SEND_MESSAGE } from '@/lib/whatsapp/broadcast-core';

const send = vi.hoisted(() => ({ calls: [] as { igsid: string; text: string }[], mode: 'ok' as 'ok' | 'timeout' }));
vi.mock('@/lib/instagram/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/instagram/config')>()),
  instagramConfig: () => ({ humanAgentEnabled: false, ctdWindowEnabled: false }),
}));
vi.mock('@/lib/channels/sender', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/channels/sender')>()),
  sendInstagramText: async (target: { igsid: string }, text: string) => {
    send.calls.push({ igsid: target.igsid, text });
    if (send.mode === 'timeout') throw new Error('socket hang up');
    return { messageId: `mid.${randomUUID()}` };
  },
}));

import { broadcastChannel, countInstagramAudience, createInstagramBroadcast, deliverInstagramBroadcast, IG_FAILURE } from './instagram';
import { broadcastHalted, pauseBroadcast, unpauseBroadcast } from './pause';
import { broadcastDispatchable, claimBroadcastStart, startScheduledNow } from './schedule';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const A = randomUUID(), B = randomUUID(), agent = randomUUID(), outsider = randomUUID();
const ctxA: TenantContext = { accountId: A, userId: agent, role: 'agent' };
const ctxB: TenantContext = { accountId: B, userId: outsider, role: 'owner' };
const seed = String(Date.now()).slice(-9);
let owner: pg.Client;
const q = (sql: string, params: unknown[] = []) => owner.query(sql, params);
const noop = () => undefined;

async function igContact(account: string, user: string, ig: string, name: string, igsid: string, wroteAgo: string | null): Promise<string> {
  // Instagram-only contacts carry an empty phone (as the Instagram inbound pipeline stores them).
  const contact = (await q("INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,'',$3) RETURNING id", [account, user, name])).rows[0].id;
  const conversation = (await q(`INSERT INTO conversations(account_id,user_id,contact_id,channel,instagram_account_id)
    VALUES($1,$2,$3,'instagram',$4) RETURNING id`, [account, user, contact, ig])).rows[0].id;
  await q('INSERT INTO contact_channel_identities(account_id,contact_id,instagram_account_id,external_id) VALUES($1,$2,$3,$4)',
    [account, contact, ig, igsid]);
  if (wroteAgo) await q(`INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,created_at)
    VALUES($1,$2,'customer','text','hi',now()-$3::interval)`, [account, conversation, wroteAgo]);
  return contact;
}

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Instagram broadcasts and pause on PostgreSQL', { timeout: 120_000 }, () => {
  let open1 = '', optedOut = '';
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await q('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
    if (!/test/i.test(app[0].name)) throw new Error('Requires constrained test app credentials');
    await getWorkerPrisma().$queryRaw`SELECT 1`;
    await q("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'IG broadcast', 'test-only-hash' FROM unnest($1::uuid[]) x", [[agent, outsider]]);
    await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'IG A',$2),($3,'IG B',$4)", [A, agent, B, outsider]);
    await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'agent'),($3,$4,'owner')", [A, agent, B, outsider]);
    const igA = (await q(`INSERT INTO instagram_accounts(account_id,ig_user_id,username,access_token_enc,scopes,connected_by_user_id)
      VALUES($1,$2,'shop',$3,ARRAY['instagram_business_basic','instagram_business_manage_messages'],$4) RETURNING id`,
      [A, `81${seed}`, encrypt('test-only-ig-token'), agent])).rows[0].id;
    const igB = (await q(`INSERT INTO instagram_accounts(account_id,ig_user_id,username,access_token_enc,scopes,connected_by_user_id)
      VALUES($1,$2,'other',$3,ARRAY['instagram_business_basic','instagram_business_manage_messages'],$4) RETURNING id`,
      [B, `82${seed}`, encrypt('test-only-ig-token'), outsider])).rows[0].id;
    open1 = await igContact(A, agent, igA, 'Priya Sharma', `91${seed}`, '2 hours');
    await igContact(A, agent, igA, 'Rohan Iyer', `92${seed}`, '23 hours');
    await igContact(A, agent, igA, 'Old Lead', `93${seed}`, '30 hours');
    await igContact(A, agent, igA, 'Never Wrote', `94${seed}`, null);
    optedOut = await igContact(A, agent, igA, 'Opted Out', `95${seed}`, '1 hour');
    await q('UPDATE contacts SET instagram_opted_out_at=now() WHERE id=$1', [optedOut]);
    await igContact(B, outsider, igB, 'Other Workspace', `96${seed}`, '1 hour');
  });
  beforeEach(() => { send.calls = []; send.mode = 'ok'; });
  afterAll(async () => {
    if (owner) {
      await q('DELETE FROM outbound_intents WHERE account_id = ANY($1::uuid[])', [[A, B]]);
      await q('DELETE FROM audit_logs WHERE account_id = ANY($1::uuid[])', [[A, B]]);
      await q('DELETE FROM jobs WHERE tenant_id = ANY($1::uuid[])', [[A, B]]);
      await q('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[A, B]]);
      await q('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[agent, outsider]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('counts only this workspace, leaving out opted-out contacts and closed windows', async () => {
    expect(await countInstagramAudience(ctxA, { audience: { type: 'all' } })).toEqual({ onInstagram: 4, eligible: 2 });
    await expect(countInstagramAudience(ctxA, { audience: { type: 'csv', csvContacts: [{ phone: '+14155550100' }] } })).rejects.toMatchObject({ status: 400 });
  });

  it('freezes the open-window recipients with their conversation and first name, and queues one durable job', async () => {
    const { id, recipients } = await createInstagramBroadcast(ctxA, { name: 'Flash sale', text: 'Hi {first name}, sale is on', audience: { type: 'all' } });
    expect(recipients).toBe(2);
    const b = (await q('SELECT channel, status, message_text, total_recipients, template_name FROM broadcasts WHERE id=$1', [id])).rows[0];
    expect(b).toMatchObject({ channel: 'instagram', status: 'sending', message_text: 'Hi {first name}, sale is on', total_recipients: 2, template_name: '' });
    const rows = (await q('SELECT template_params, conversation_id FROM broadcast_recipients WHERE broadcast_id=$1 ORDER BY template_params->>0', [id])).rows;
    expect(rows.map((r) => r.template_params)).toEqual([['Priya'], ['Rohan']]);
    expect(rows.every((r) => r.conversation_id)).toBe(true);
    expect((await q('SELECT count(*)::int AS n FROM jobs WHERE dedupe_key=$1', [`broadcast:${id}:initial`])).rows[0].n).toBe(1);
    expect(await broadcastChannel(A, id)).toBe('instagram');
    // Another workspace sees it as an unknown (WhatsApp-default) id.
    expect(await broadcastChannel(B, id)).toBe('whatsapp');
  });

  it('sends through one intent per recipient, re-checks the window and consent, and never resends', async () => {
    const { id } = await createInstagramBroadcast(ctxA, { name: 'Send', text: 'Hi {first name}', audience: { type: 'all' } });
    // Priya opts out after the campaign was created: her row fails without a send.
    await q('UPDATE contacts SET opted_out_at=now() WHERE id=$1', [open1]);
    const pass = await deliverInstagramBroadcast(A, id, 'pending', { assertLease: noop, paceMs: 0 });
    await q('UPDATE contacts SET opted_out_at=NULL WHERE id=$1', [open1]);
    expect(pass).toMatchObject({ sent: 1, failed: 1, remaining: 0, stopped: false });
    expect(send.calls).toEqual([{ igsid: `92${seed}`, text: 'Hi Rohan' }]);
    const rows = (await q('SELECT id, status, error_message, whatsapp_message_id FROM broadcast_recipients WHERE broadcast_id=$1 ORDER BY status', [id])).rows;
    expect(rows.find((r) => r.status === 'failed')?.error_message).toBe(IG_FAILURE.optedOut);
    const sentRow = rows.find((r) => r.status === 'sent')!;
    expect(sentRow.whatsapp_message_id).toMatch(/^mid\./);
    expect((await q('SELECT status FROM outbound_intents WHERE idempotency_key=$1', [`${A}:${broadcastIntentKey(id, sentRow.id, 'ig')}`])).rows[0].status).toBe('accepted');
    // The sent message is stored in the conversation as a bot message.
    expect((await q("SELECT count(*)::int AS n FROM messages WHERE account_id=$1 AND sender_type='bot' AND message_id=$2", [A, sentRow.whatsapp_message_id])).rows[0].n).toBe(1);
    // A second pass sends nothing: nobody is pending.
    expect(await deliverInstagramBroadcast(A, id, 'pending', { assertLease: noop, paceMs: 0 })).toMatchObject({ sent: 0, failed: 0 });
    expect(send.calls).toHaveLength(1);
  });

  it('fails a recipient whose window closed after creation, before any intent exists', async () => {
    const { id } = await createInstagramBroadcast(ctxA, { name: 'Closed', text: 'Hello', audience: { type: 'all' } });
    await q(`UPDATE messages SET created_at=now()-interval '2 days' WHERE account_id=$1 AND sender_type='customer'
      AND conversation_id IN (SELECT conversation_id FROM broadcast_recipients WHERE broadcast_id=$2)`, [A, id]);
    const pass = await deliverInstagramBroadcast(A, id, 'pending', { assertLease: noop, paceMs: 0 });
    expect(pass).toMatchObject({ sent: 0, failed: 2 });
    expect(send.calls).toEqual([]);
    const reasons = (await q('SELECT DISTINCT error_message FROM broadcast_recipients WHERE broadcast_id=$1', [id])).rows.map((r) => r.error_message);
    expect(reasons).toEqual([IG_FAILURE.windowClosed]);
    expect((await q("SELECT count(*)::int AS n FROM outbound_intents WHERE account_id=$1 AND idempotency_key LIKE $2", [A, `${A}:broadcast:${id}:%`])).rows[0].n).toBe(0);
  });

  it('flags an ambiguous outcome for reconciliation and leaves it out of Retry failed', async () => {
    // Re-open the windows the previous test closed.
    await q(`UPDATE messages SET created_at=now()-interval '1 hour' WHERE account_id=$1 AND sender_type='customer'
      AND content_text='hi' AND created_at < now()-interval '1 day' AND created_at > now()-interval '3 days'`, [A]);
    const { id } = await createInstagramBroadcast(ctxA, { name: 'Timeout', text: 'Hello', audience: { type: 'all' } });
    send.mode = 'timeout';
    const pass = await deliverInstagramBroadcast(A, id, 'pending', { assertLease: noop, paceMs: 0 });
    expect(pass.failed).toBeGreaterThan(0);
    const rows = (await q('SELECT error_message, outcome_uncertain_at FROM broadcast_recipients WHERE broadcast_id=$1', [id])).rows;
    expect(rows.every((r) => r.error_message === UNCERTAIN_SEND_MESSAGE && r.outcome_uncertain_at)).toBe(true);
    send.mode = 'ok'; send.calls = [];
    expect(await deliverInstagramBroadcast(A, id, 'failed', { assertLease: noop, paceMs: 0 })).toMatchObject({ sent: 0, failed: 0 });
    expect(send.calls).toEqual([]);
  });

  it('pauses only a sending campaign of its own workspace; a paused one is never dispatched until resumed', async () => {
    const { id } = await createInstagramBroadcast(ctxA, { name: 'Pause me', text: 'Hello', audience: { type: 'all' } });
    await expect(pauseBroadcast(ctxB, id)).rejects.toMatchObject({ status: 404 });
    expect(await pauseBroadcast(ctxA, id)).toBe(true);
    expect(await pauseBroadcast(ctxA, id)).toBe(false);
    expect((await q('SELECT status, paused_at FROM broadcasts WHERE id=$1', [id])).rows[0]).toMatchObject({ status: 'paused', paused_at: expect.any(Date) });
    expect(await broadcastHalted(A, id)).toBe(true);
    expect(await broadcastDispatchable(A, id)).toBe(false);
    expect(await claimBroadcastStart(A, id)).toBe(false);
    // A pass that runs anyway stops before the first send and leaves everyone pending.
    const pass = await deliverInstagramBroadcast(A, id, 'pending', { assertLease: noop, paceMs: 0, shouldStop: () => broadcastHalted(A, id) });
    expect(pass).toMatchObject({ stopped: true, sent: 0 });
    expect(send.calls).toEqual([]);
    expect((await q("SELECT count(*)::int AS n FROM broadcast_recipients WHERE broadcast_id=$1 AND status='pending'", [id])).rows[0].n).toBeGreaterThan(0);
    expect(await unpauseBroadcast(ctxB, id)).toBe(false);
    expect(await unpauseBroadcast(ctxA, id)).toBe(true);
    expect(await broadcastDispatchable(A, id)).toBe(true);
    const audit = (await q("SELECT action FROM audit_logs WHERE account_id=$1 AND resource_id=$2 ORDER BY created_at", [A, id])).rows.map((r) => r.action);
    expect(audit).toEqual(['campaigns.paused', 'campaigns.resumed']);
  });

  it('starts a scheduled campaign now by moving its one waiting job, only in its own workspace', async () => {
    const id = randomUUID();
    await q("INSERT INTO broadcasts(id,account_id,user_id,name,template_name,status,scheduled_at) VALUES($1,$2,$3,'Later','promo','scheduled',now()+interval '2 days')", [id, A, agent]);
    await q(`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,run_at) VALUES('broadcast.dispatch',$1,$2::jsonb,$3,now()+interval '2 days')`,
      [A, JSON.stringify({ broadcastId: id, scope: 'pending' }), `broadcast:${id}:initial`]);
    await expect(startScheduledNow(ctxB, id)).rejects.toMatchObject({ status: 404 });
    await startScheduledNow(ctxA, id);
    const job = (await q('SELECT count(*)::int AS n, bool_and(run_at <= now() + interval \'1 second\') AS due FROM jobs WHERE dedupe_key=$1', [`broadcast:${id}:initial`])).rows[0];
    expect(job).toEqual({ n: 1, due: true });
    expect(await broadcastDispatchable(A, id)).toBe(true);
    // Not scheduled any more (started): a second Send now is refused.
    await q("UPDATE broadcasts SET status='sending' WHERE id=$1", [id]);
    await expect(startScheduledNow(ctxA, id)).rejects.toMatchObject({ status: 409 });
  });

  it('refuses CSV audiences, empty text and roles below agent', async () => {
    await expect(createInstagramBroadcast(ctxA, { name: 'x', text: '  ', audience: { type: 'all' } })).rejects.toMatchObject({ status: 400 });
    await expect(createInstagramBroadcast(ctxA, { name: 'x', text: 'hi', audience: { type: 'csv', csvContacts: [{ phone: '+14155550100' }] } })).rejects.toMatchObject({ status: 400 });
    await expect(createInstagramBroadcast({ ...ctxA, role: 'viewer' }, { name: 'x', text: 'hi', audience: { type: 'all' } })).rejects.toMatchObject({ status: 403 });
  });
});
