// Stage 5 (5D) on PostgreSQL: automations that resume by themselves.
// - A timed pause records its end and who paused; once its time passes it
//   reads as not paused and the next read clears the flag, so the next inbound
//   reaches flows and automations again.
// - conversations_pause_reset: a write of bot_paused by any older path (AI
//   handoff, flows, the browser) means "until resumed" as before Stage 5, and a
//   resume clears the time and the author.
// - An agent reply with the default setting pauses until resumed (unchanged);
//   with agent_reply_pause_minutes it pauses for that long, never shortening a
//   longer pause and never turning an until-resumed pause into a timed one.
// - The pause writers act only on the given workspace's rows, and an agent can
//   pause as themselves under RLS.
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import {
  clearExpiredPause,
  pauseAutomations,
  pauseForAgentReplyNow,
  resumeAutomations,
} from './automation-pause';
import { botRepliesPaused } from '@/lib/whatsapp/bot-pause';
import { encrypt } from '@/lib/whatsapp/encryption';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const A = randomUUID(), B = randomUUID(), ownerA = randomUUID(), agentA = randomUUID(), ownerB = randomUUID();
const seed = String(Date.now()).slice(-6);
let db: pg.Client;
const q = (sql: string, params: unknown[] = []) => db.query(sql, params);
let n = 0;

async function conversation(account: string, user: string): Promise<{ id: string; contact: string }> {
  const contact = (await q("INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$3,'Pause') RETURNING id",
    [account, user, `1418${seed}${++n}0`])).rows[0].id;
  const id = (await q('INSERT INTO conversations(account_id,user_id,contact_id) VALUES($1,$2,$3) RETURNING id', [account, user, contact])).rows[0].id;
  return { id, contact };
}
const state = async (id: string) => (await q(
  'SELECT bot_paused, bot_paused_until, bot_paused_by::text AS bot_paused_by FROM conversations WHERE id=$1', [id])).rows[0] as
  { bot_paused: boolean; bot_paused_until: Date | null; bot_paused_by: string | null };
/** An explicit timed pause written as the 5D writers do (the trigger keeps the time). */
async function pausedUntil(id: string, until: string): Promise<void> {
  await q('BEGIN');
  await q("SELECT set_config('app.pause_explicit', 'on', true)");
  await q('UPDATE conversations SET bot_paused=true, bot_paused_until=$2::timestamptz, bot_paused_by=$3 WHERE id=$1', [id, until, ownerA]);
  await q('COMMIT');
}
const minutesFromNow = (date: Date | null) => (date ? Math.round((date.getTime() - Date.now()) / 60_000) : null);
const setting = (minutes: number | null) => q(`INSERT INTO workspace_inbox_settings(account_id,agent_reply_pause_minutes) VALUES($1,$2)
  ON CONFLICT (account_id) DO UPDATE SET agent_reply_pause_minutes=EXCLUDED.agent_reply_pause_minutes`, [A, minutes]);

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('timed pause of automated replies (Stage 5)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await q('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    for (const id of [ownerA, agentA, ownerB])
      await q("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Pause','test-only-hash')", [id, `${id}@example.invalid`]);
    await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Pause A',$2),($3,'Pause B',$4)", [A, ownerA, B, ownerB]);
    await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'agent'),($4,$5,'owner')",
      [A, ownerA, agentA, B, ownerB]);
  });
  afterAll(async () => {
    if (db) {
      await q('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[A, B]]).catch(() => undefined);
      await q('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[ownerA, agentA, ownerB]]).catch(() => undefined);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('pauses for a length and records who, as the agent under RLS', async () => {
    const c = await conversation(A, ownerA);
    const paused = await withTenant({ accountId: A, userId: agentA, role: 'agent' }, (tx) =>
      pauseAutomations(A, { conversationId: c.id, minutes: 180, byUserId: agentA }, tx), getPrisma());
    expect(paused).toBe(1);
    const row = await state(c.id);
    expect(row.bot_paused).toBe(true);
    expect(row.bot_paused_by).toBe(agentA);
    expect(minutesFromNow(row.bot_paused_until)).toBeGreaterThanOrEqual(179);
    expect(await botRepliesPaused(A, c.id)).toBe(true);
  });

  it('pauses all of a contact’s conversations, and resumes them with time and author cleared', async () => {
    const c = await conversation(A, ownerA);
    // The same contact on Instagram: one WhatsApp conversation per contact and number is allowed.
    const ig = (await q(`INSERT INTO instagram_accounts(account_id,ig_user_id,username,access_token_enc,scopes,connected_by_user_id)
      VALUES($1,$2,'pause_shop',$3,$4,$5) RETURNING id`,
      [A, `84${seed}`, encrypt('test-only-ig-token'), ['instagram_business_basic', 'instagram_business_manage_messages'], ownerA])).rows[0].id;
    const second = (await q(`INSERT INTO conversations(account_id,user_id,contact_id,channel,instagram_account_id)
      VALUES($1,$2,$3,'instagram',$4) RETURNING id`, [A, ownerA, c.contact, ig])).rows[0].id;
    expect(await pauseAutomations(A, { contactId: c.contact, minutes: null, byUserId: ownerA })).toBe(2);
    for (const id of [c.id, second]) expect(await state(id)).toEqual({ bot_paused: true, bot_paused_until: null, bot_paused_by: ownerA });
    expect(await resumeAutomations(A, { contactId: c.contact, byUserId: ownerA })).toBe(2);
    for (const id of [c.id, second]) expect(await state(id)).toEqual({ bot_paused: false, bot_paused_until: null, bot_paused_by: null });
  });

  it('reads an expired pause as not paused and clears it, so the next inbound reaches the bots', async () => {
    const c = await conversation(A, ownerA);
    await pausedUntil(c.id, new Date(Date.now() - 60_000).toISOString());
    expect(await botRepliesPaused(A, c.id)).toBe(false);
    expect(await state(c.id)).toEqual({ bot_paused: false, bot_paused_until: null, bot_paused_by: null });
    // A running pause and an until-resumed pause are left alone.
    await pausedUntil(c.id, new Date(Date.now() + 3_600_000).toISOString());
    expect(await clearExpiredPause(A, c.id)).toBe(false);
    expect((await state(c.id)).bot_paused).toBe(true);
  });

  it('turns an older path’s write into "until resumed", as before Stage 5', async () => {
    const c = await conversation(A, ownerA);
    await pausedUntil(c.id, new Date(Date.now() - 60_000).toISOString());
    // e.g. the AI handing off, which sets bot_paused alone.
    await q('UPDATE conversations SET bot_paused=true WHERE id=$1', [c.id]);
    expect((await state(c.id)).bot_paused_until).toBeNull();
    expect(await botRepliesPaused(A, c.id)).toBe(true);
    // The browser's old resume clears the author too.
    await q('UPDATE conversations SET bot_paused=false WHERE id=$1', [c.id]);
    expect(await state(c.id)).toEqual({ bot_paused: false, bot_paused_until: null, bot_paused_by: null });
  });

  it('pauses on an agent reply until resumed by default, and for the workspace setting when set', async () => {
    const c = await conversation(A, ownerA);
    await pauseForAgentReplyNow(A, c.id, agentA);
    expect(await state(c.id)).toEqual({ bot_paused: true, bot_paused_until: null, bot_paused_by: agentA });

    const timed = await conversation(A, ownerA);
    await setting(60);
    try {
      await pauseForAgentReplyNow(A, timed.id, agentA);
      const row = await state(timed.id);
      expect(row.bot_paused).toBe(true);
      expect(minutesFromNow(row.bot_paused_until)).toBeGreaterThanOrEqual(59);
      // A longer running pause is never shortened.
      await pausedUntil(timed.id, new Date(Date.now() + 5 * 3_600_000).toISOString());
      await pauseForAgentReplyNow(A, timed.id, agentA);
      expect(minutesFromNow((await state(timed.id)).bot_paused_until)).toBeGreaterThanOrEqual(299);
      // An until-resumed pause stays until resumed.
      await pauseForAgentReplyNow(A, c.id, ownerA);
      expect(await state(c.id)).toEqual({ bot_paused: true, bot_paused_until: null, bot_paused_by: agentA });
    } finally {
      await setting(null);
    }
  });

  it("never touches another workspace's conversation", async () => {
    const other = await conversation(B, ownerB);
    expect(await pauseAutomations(A, { conversationId: other.id, minutes: 30, byUserId: ownerA })).toBe(0);
    expect(await pauseAutomations(A, { contactId: other.contact, minutes: 30, byUserId: ownerA })).toBe(0);
    await pauseForAgentReplyNow(A, other.id, ownerA);
    expect(await state(other.id)).toEqual({ bot_paused: false, bot_paused_until: null, bot_paused_by: null });
    const asAgent = await withTenant({ accountId: A, userId: agentA, role: 'agent' }, (tx) =>
      pauseAutomations(B, { conversationId: other.id, minutes: 30, byUserId: agentA }, tx), getPrisma());
    expect(asAgent).toBe(0);
  });
});
