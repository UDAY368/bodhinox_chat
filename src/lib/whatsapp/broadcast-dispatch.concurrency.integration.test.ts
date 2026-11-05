import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Meta is stubbed: every send resolves after a short delay with a message id, and the
// calls are counted per recipient so a double send is visible.
const sends = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('@/lib/whatsapp/meta-api', async (original) => ({
  ...(await original<typeof import('@/lib/whatsapp/meta-api')>()),
  sendTemplateMessage: vi.fn(async ({ to }: { to: string }) => {
    sends.calls.push(to);
    await new Promise((resolve) => setTimeout(resolve, 40));
    return { messageId: `wamid.concurrency.${to}.${crypto.randomUUID()}` };
  }),
}));

import { createAdminClient } from '@/lib/data/admin';
import { disconnectDatabases, getWorkerPrisma } from '@/lib/db/prisma';
import { handleJob } from '@/lib/jobs/handlers';
import { encrypt } from '@/lib/whatsapp/encryption';
import { createBroadcast, deliverBroadcast } from './broadcast-core';
import { planBroadcastResume } from './broadcast-resume';

// Real database through the constrained worker role; the owner client only seeds and reads back.
// Never loads .env files: run through scripts/test-db-local.cjs (local Docker database only).
const ownerUrl = process.env.TEST_DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountId = randomUUID(), userId = randomUUID();
const PHONES = ['+14155550301', '+14155550302', '+14155550303', '+14155550304'];
let owner: pg.Client;

const db = () => createAdminClient({ accountId, role: 'owner' });
const newBroadcast = async () => (await createBroadcast(db(), accountId, userId, {
  name: `Concurrency ${randomUUID().slice(0, 8)}`, templateName: 'promo', recipients: PHONES.map((to) => ({ to })),
})).broadcastId;
const dispatchJob = (broadcastId: string) => ({
  id: randomUUID(), type: 'broadcast.dispatch', tenant_id: accountId, payload: { broadcastId },
  attempts: 1, max_attempts: 5, lease_token: randomUUID(),
});
const recipients = async (broadcastId: string) => (await owner.query(
  'SELECT id::text, status, whatsapp_message_id FROM broadcast_recipients WHERE broadcast_id=$1 ORDER BY id', [broadcastId])).rows as
  { id: string; status: string; whatsapp_message_id: string | null }[];
const intents = async (broadcastId: string) => (await owner.query(
  `SELECT idempotency_key, status FROM outbound_intents WHERE account_id=$1 AND idempotency_key LIKE $2`,
  [accountId, `${accountId}:broadcast:${broadcastId}:%`])).rows as { idempotency_key: string; status: string }[];
const sentPerPhone = () => Object.fromEntries(PHONES.map((p) => [p, sends.calls.filter((c) => c === p.replace('+', '') || c === p).length]));

describe.skipIf(!ownerUrl || !workerUrl)('[WA-04] broadcast dispatch under concurrent claimers on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getWorkerPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_worker') throw new Error('Requires constrained test worker credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Broadcast concurrency','test-only-hash')", [userId, `${userId}@example.invalid`]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Broadcast concurrency',$2)", [accountId, userId]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner')", [accountId, userId]);
    await owner.query(`INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,access_token,status) VALUES($1,$2,$3,$4,'connected')`,
      [accountId, userId, `test-${accountId}`, encrypt('test-only-token')]);
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id=$1', [accountId]);
      await owner.query('DELETE FROM accounts WHERE id=$1', [accountId]);
      await owner.query('DELETE FROM auth_users WHERE id=$1', [userId]);
      await owner.end();
    }
    await disconnectDatabases();
  });
  beforeEach(() => { sends.calls.length = 0; });

  it('two dispatch jobs for one campaign: one pass sends, the other waits; each recipient gets one intent and one send', async () => {
    const broadcastId = await newBroadcast();
    const [first, second] = [dispatchJob(broadcastId), dispatchJob(broadcastId)];
    await Promise.all([handleJob(first), handleJob(second)]);

    expect(sends.calls).toHaveLength(PHONES.length);
    expect(Object.values(sentPerPhone())).toEqual(PHONES.map(() => 1));
    const rows = await recipients(broadcastId);
    expect(rows.map((r) => r.status)).toEqual(PHONES.map(() => 'sent'));
    const keys = await intents(broadcastId);
    expect(keys).toHaveLength(PHONES.length);
    expect(keys.every((k) => k.status === 'accepted')).toBe(true);
    // The pass that found the lock taken left a delayed retry instead of sending in parallel.
    const waits = (await owner.query(`SELECT dedupe_key FROM jobs WHERE tenant_id=$1 AND dedupe_key = ANY($2::text[])`,
      [accountId, [`broadcast:${broadcastId}:wait:${first.id}`, `broadcast:${broadcastId}:wait:${second.id}`]])).rows;
    expect(waits).toHaveLength(1);
    expect((await owner.query('SELECT delivery_locked_at FROM broadcasts WHERE id=$1', [broadcastId])).rows[0].delivery_locked_at).toBeNull();
  });

  it('a redelivered job after the pass finished sends nothing more', async () => {
    const broadcastId = await newBroadcast();
    await handleJob(dispatchJob(broadcastId));
    expect(sends.calls).toHaveLength(PHONES.length);
    await handleJob(dispatchJob(broadcastId));
    expect(sends.calls).toHaveLength(PHONES.length);
    expect((await recipients(broadcastId)).every((r) => r.status === 'sent')).toBe(true);
  });

  it('two passes on the same plan (a stolen stale lock): the intents still allow one send per recipient and no sent row is downgraded', async () => {
    const broadcastId = await newBroadcast();
    const { plan } = await planBroadcastResume(db(), accountId, broadcastId, 'pending');
    const pass = () => deliverBroadcast(db(), plan, { accountId, assertLease: () => {}, attemptId: randomUUID(), retryRejected: true });
    const results = await Promise.all([pass(), pass(), pass()]);

    expect(sends.calls).toHaveLength(PHONES.length);
    expect(Object.values(sentPerPhone())).toEqual(PHONES.map(() => 1));
    expect(results.reduce((n, r) => n + r.sent, 0)).toBeGreaterThanOrEqual(PHONES.length);
    const rows = await recipients(broadcastId);
    // Every recipient was delivered exactly once, so every row must read 'sent' with its message id,
    // whichever pass wrote last.
    expect(rows.map((r) => r.status)).toEqual(PHONES.map(() => 'sent'));
    expect(rows.every((r) => r.whatsapp_message_id?.startsWith('wamid.concurrency.'))).toBe(true);
    expect((await intents(broadcastId)).every((k) => k.status === 'accepted')).toBe(true);
  });

  it('a pass that finds another pass mid-send leaves that pass\'s sent row alone (regression: failed overwrote sent)', async () => {
    const broadcastId = await newBroadcast();
    const { plan } = await planBroadcastResume(db(), accountId, broadcastId, 'pending');
    const [target] = plan.planned;
    // The moment between the other pass persisting the row and recording its intent as accepted.
    await owner.query("UPDATE broadcast_recipients SET status='sent', whatsapp_message_id=$2, sent_at=now() WHERE id=$1",
      [target.recipientRowId, `wamid.other-pass.${randomUUID()}`]);
    for (const variant of [target.phone, target.phone.replace(/^\+/, '')]) {
      await owner.query("INSERT INTO outbound_intents(account_id,idempotency_key,status) VALUES($1,$2,'dispatching') ON CONFLICT DO NOTHING",
        [accountId, `${accountId}:broadcast:${broadcastId}:${target.recipientRowId}:${variant}`]);
    }
    await deliverBroadcast(db(), { ...plan, planned: [target] }, { accountId, assertLease: () => {}, attemptId: randomUUID(), retryRejected: true });
    expect(sends.calls).toHaveLength(0);
    const row = (await recipients(broadcastId)).find((r) => r.id === target.recipientRowId)!;
    expect(row.status).toBe('sent');
    expect(row.whatsapp_message_id).toMatch(/^wamid\.other-pass\./);
  });
});
