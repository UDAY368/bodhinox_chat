// Stage 3 (3C) on a real PostgreSQL: AI replies to Instagram comments.
//   - the worker schedule function lists only workspaces with AI comment work, and only the worker can run it
//   - the job drafts a PENDING reply (owner decision 2), never posts it, and skips comments a flow, rule,
//     reply or blocked contact already owns; the daily cap holds
//   - an admin's approval queues the posting job in the same transaction; a second decision is refused;
//     agents and other workspaces cannot decide
//   - the approved reply is posted once (one outbound intent per comment) and a re-run never posts again
//   - auto-approve posts only a positive draft
//   - settings: admin-only, a working AI setup is needed to switch drafting on
// Meta (Graph) and the AI provider are mocked: no request leaves the test.
//
// Connection settings come only from the environment (TEST_DATABASE_URL,
// TEST_APP_DATABASE_URL, TEST_WORKER_DATABASE_URL); the suite is skipped without
// them and refuses a non-test database.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { encrypt } from '@/lib/whatsapp/encryption';

const m = vi.hoisted(() => ({
  getComment: vi.fn(), replyToComment: vi.fn(), generate: vi.fn(),
}));
vi.mock('./graph', async (original) => ({
  ...(await original<typeof import('./graph')>()), getComment: m.getComment, replyToComment: m.replyToComment,
}));
vi.mock('@/lib/ai/generate', () => ({ generateReply: m.generate }));
vi.mock('@/lib/ai/admin-client', () => ({ databaseAdmin: () => ({}) }));
vi.mock('@/lib/ai/config', () => ({ loadAiConfig: async () => ({ provider: 'openai', model: 'm', apiKey: 'k' }) }));
vi.mock('@/lib/ai/budget', () => ({
  chatTokenEstimate: () => 100, reserveAi: async () => ({}), settleAi: async () => {}, failAi: async () => {},
}));

import { runAiCommentJob, scheduleAiCommentSweeps, resetAiCommentScheduleForTests } from './ai-comments';
import {
  AiCommentError, decideAiComment, getAiCommentSettings, listAiComments, updateAiCommentSettings,
} from './ai-comments-queue';
import { InstagramError } from './errors';

const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const adminUser = randomUUID(), agentUser = randomUUID(), ownerUserB = randomUUID();
const actor = (role: 'admin' | 'agent') => ({ accountId: accountA, userId: role === 'admin' ? adminUser : agentUser, role });
const actorB = { accountId: accountB, userId: ownerUserB, role: 'owner' as const };
const SCOPES = ['instagram_business_basic', 'instagram_business_manage_messages', 'instagram_business_manage_comments'];
const digits = () => `${Date.now()}${Math.floor(Math.random() * 1e6)}`.slice(0, 18);

let owner: pg.Client;
let igA = '';

const answer = (over: Record<string, unknown> = {}) => m.generate.mockResolvedValue({
  text: JSON.stringify({ sentiment: 'positive', intent: 'praise', reply: 'Thank you so much!', ...over }), usage: null, handoff: false, noAnswer: false,
});

/** A comment event of workspace A; `over` sets columns the candidate query filters on. */
async function seedEvent(over: { flowRun?: boolean; publicReply?: string; status?: string; blocked?: boolean; ageHours?: number } = {}): Promise<string> {
  const from = digits();
  if (over.blocked) {
    const contact = (await owner.query<{ id: string }>("INSERT INTO contacts(account_id,user_id,phone,name,blocked_at) VALUES($1,$2,'','Blocked',now()) RETURNING id",
      [accountA, adminUser])).rows[0].id;
    await owner.query('INSERT INTO contact_channel_identities(account_id,contact_id,instagram_account_id,external_id) VALUES($1,$2,$3,$4)', [accountA, contact, igA, from]);
  }
  let runId: string | null = null;
  if (over.flowRun) {
    const flow = (await owner.query<{ id: string }>(`INSERT INTO flows(account_id,user_id,name,trigger_type,trigger_config,channel_scope)
      VALUES($1,$2,'F','ig_comment','{"post_scope":"any"}','instagram') RETURNING id`, [accountA, adminUser])).rows[0].id;
    runId = (await owner.query<{ id: string }>("INSERT INTO flow_runs(account_id,flow_id,user_id,status) VALUES($1,$2,$3,'active') RETURNING id", [accountA, flow, adminUser])).rows[0].id;
  }
  return (await owner.query<{ id: string }>(`INSERT INTO instagram_comment_events(account_id,instagram_account_id,comment_id,media_id,from_igsid,flow_run_id,public_reply_id,private_reply_status,received_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8, now() - make_interval(hours => $9)) RETURNING id`,
  [accountA, igA, digits(), digits(), from, runId, over.publicReply ?? null, over.status ?? 'none', over.ageHours ?? 0])).rows[0].id;
}

const queue = async (eventId: string) => (await owner.query<{ id: string; status: string; auto_approved: boolean; public_reply_id: string | null; reply_text: string; error_code: string | null; decided_by: string | null }>(
  'SELECT id, status, auto_approved, public_reply_id, reply_text, error_code, decided_by FROM instagram_ai_comment_queue WHERE comment_event_id=$1', [eventId])).rows[0];

async function setSettings(sql: string, values: unknown[] = []): Promise<void> {
  await owner.query(`UPDATE ai_configs SET ${sql} WHERE account_id='${accountA}'`, values);
}

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Instagram AI comment replies on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    vi.stubEnv('INSTAGRAM_ENABLED', 'true');
    vi.stubEnv('INSTAGRAM_APP_ID', '1234567890');
    vi.stubEnv('INSTAGRAM_APP_SECRET', 'test-only-ig-secret');
    vi.stubEnv('INSTAGRAM_WEBHOOK_VERIFY_TOKEN', 'test-only-verify');
    vi.stubEnv('APP_URL', 'https://app.example.test');
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string; role: string }[]>`SELECT current_database() AS name, current_user AS role`;
    if (!/test/i.test(app[0].name) || app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'AI comments test', 'test-only-hash' FROM unnest($1::uuid[]) x",
      [[adminUser, agentUser, ownerUserB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'AI comments A',$2),($3,'AI comments B',$4)", [accountA, adminUser, accountB, ownerUserB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'agent'),($4,$5,'owner')",
      [accountA, adminUser, agentUser, accountB, ownerUserB]);
    const ig = (account: string, user: string) => owner.query<{ id: string }>(`INSERT INTO instagram_accounts(account_id,ig_user_id,username,access_token_enc,connected_by_user_id,scopes)
      VALUES($1,$2,'aicomments',$3,$4,$5) RETURNING id`, [account, digits(), encrypt('test-only-token'), user, SCOPES]).then((r) => r.rows[0].id);
    igA = await ig(accountA, adminUser);
    await ig(accountB, ownerUserB);
    await owner.query("INSERT INTO ai_configs(account_id,provider,model,api_key,is_active) VALUES($1,'openai','m','enc',true),($2,'openai','m','enc',false)", [accountA, accountB]);
  });

  afterAll(async () => {
    if (owner) {
      // The live Instagram accounts and their tokens must not reach later suites.
      await owner.query('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[adminUser, agentUser, ownerUserB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await setSettings('instagram_ai_comments_enabled=true, instagram_ai_comments_auto_approve=false, instagram_ai_comments_daily_cap=50');
    await owner.query('DELETE FROM instagram_ai_comment_queue WHERE account_id=$1', [accountA]);
    await owner.query('DELETE FROM outbound_intents WHERE account_id=$1', [accountA]);
    // Earlier tests' events must not be candidates again.
    await owner.query("UPDATE instagram_comment_events SET private_reply_status='rejected' WHERE account_id=$1", [accountA]);
    m.getComment.mockResolvedValue({ id: '1', text: 'Love this!', hidden: false, username: 'fan', mediaId: '1', timestamp: null });
    m.replyToComment.mockResolvedValue({ replyId: '17900000000000009' });
    answer();
  });

  describe('worker schedule', () => {
    it('lists workspaces with AI comment work, only to the worker', async () => {
      const listed = async () => (await getWorkerPrisma().$queryRaw<{ account_id: string }[]>`SELECT account_id::text AS account_id FROM crm_instagram_ai_comment_accounts()`)
        .map((r) => r.account_id);
      expect(await listed()).toContain(accountA);
      // B has an inactive AI setup and nothing approved: not listed.
      expect(await listed()).not.toContain(accountB);
      await setSettings('instagram_ai_comments_enabled=false');
      expect(await listed()).not.toContain(accountA);
      // An approved reply keeps its workspace listed even with the switch off.
      const event = await seedEvent();
      await owner.query(`INSERT INTO instagram_ai_comment_queue(account_id,instagram_account_id,comment_event_id,comment_id,sentiment,reply_text)
        VALUES($1,$2,$3,$4,'positive','Thanks')`, [accountA, igA, event, digits()]);
      await owner.query("UPDATE instagram_ai_comment_queue SET status='approved', decided_at=now() WHERE comment_event_id=$1", [event]);
      expect(await listed()).toContain(accountA);
      await expect(getPrisma().$queryRaw`SELECT * FROM crm_instagram_ai_comment_accounts()`).rejects.toThrow(/permission denied/);
    });

    it('queues one job per listed workspace per five minutes', async () => {
      resetAiCommentScheduleForTests();
      await owner.query('DELETE FROM jobs WHERE tenant_id=$1', [accountA]);
      await scheduleAiCommentSweeps(Date.now(), true);
      await scheduleAiCommentSweeps(Date.now(), true);
      const jobs = await owner.query("SELECT type FROM jobs WHERE tenant_id=$1 AND type='instagram.ai_comments'", [accountA]);
      expect(jobs.rowCount).toBe(1);
    });
  });

  describe('drafting', () => {
    it('drafts a pending reply, never posts it, and stores no comment text', async () => {
      const event = await seedEvent();
      const summary = await runAiCommentJob(accountA);
      expect(summary).toMatchObject({ drafted: 1, autoApproved: 0, posted: 0 });
      expect(await queue(event)).toMatchObject({ status: 'pending', auto_approved: false, reply_text: 'Thank you so much!' });
      expect(m.replyToComment).not.toHaveBeenCalled();
      // Running again drafts nothing new for the same comment (one row per comment).
      expect((await runAiCommentJob(accountA)).drafted).toBe(0);
      expect(m.generate).toHaveBeenCalledTimes(1);
    });

    it('leaves alone comments a flow, a reply, a queued DM or a blocked contact owns, and stale ones', async () => {
      const owned = [
        await seedEvent({ flowRun: true }), await seedEvent({ publicReply: '17900000000000001' }),
        await seedEvent({ status: 'queued' }), await seedEvent({ blocked: true }), await seedEvent({ ageHours: 30 }),
      ];
      await runAiCommentJob(accountA);
      expect(m.generate).not.toHaveBeenCalled();
      for (const id of owned) expect(await queue(id)).toBeUndefined();
    });

    it('records an unavailable comment as skipped (expired with a code), so it is not read again', async () => {
      m.getComment.mockResolvedValue({ id: '1', text: 'x', hidden: true, username: null, mediaId: null, timestamp: null });
      const event = await seedEvent();
      expect((await runAiCommentJob(accountA)).skipped).toBe(1);
      expect(await queue(event)).toMatchObject({ status: 'expired', error_code: 'comment_unavailable' });
      m.getComment.mockClear();
      await runAiCommentJob(accountA);
      expect(m.getComment).not.toHaveBeenCalled();
    });

    it('holds the daily cap, counting drafts and not skipped comments', async () => {
      await setSettings('instagram_ai_comments_daily_cap=1');
      const first = await seedEvent();
      const second = await seedEvent();
      await runAiCommentJob(accountA);
      const drafted = [await queue(first), await queue(second)].filter(Boolean);
      expect(drafted).toHaveLength(1);
      m.generate.mockClear();
      await runAiCommentJob(accountA);
      expect(m.generate).not.toHaveBeenCalled();
    });

    it('drafts nothing while the switch is off', async () => {
      await setSettings('instagram_ai_comments_enabled=false');
      await seedEvent();
      await runAiCommentJob(accountA);
      expect(m.getComment).not.toHaveBeenCalled();
    });
  });

  describe('approval and posting', () => {
    it('posts an approved reply exactly once and records the reply id', async () => {
      const event = await seedEvent();
      await runAiCommentJob(accountA);
      const row = await queue(event);
      expect(await decideAiComment(actor('admin'), row.id, { decision: 'approve', replyText: 'Edited thanks!' })).toBe('approved');
      // The post is queued in the approval's own transaction.
      const job = await owner.query("SELECT 1 FROM jobs WHERE tenant_id=$1 AND dedupe_key=$2", [accountA, `igai:approve:${accountA}:${row.id}`]);
      expect(job.rowCount).toBe(1);
      expect(await queue(event)).toMatchObject({ status: 'approved', decided_by: adminUser, reply_text: 'Edited thanks!' });

      expect((await runAiCommentJob(accountA)).posted).toBe(1);
      expect(m.replyToComment).toHaveBeenCalledTimes(1);
      expect(m.replyToComment.mock.calls[0][2]).toBe('Edited thanks!');
      expect(await queue(event)).toMatchObject({ status: 'sent', public_reply_id: '17900000000000009' });
      const evt = await owner.query('SELECT public_reply_id FROM instagram_comment_events WHERE id=$1', [event]);
      expect(evt.rows[0].public_reply_id).toBe('17900000000000009');
      // A second run never posts again.
      await runAiCommentJob(accountA);
      expect(m.replyToComment).toHaveBeenCalledTimes(1);
    });

    it('refuses a second decision, an agent, another workspace, and a rejected draft is never posted', async () => {
      const event = await seedEvent();
      await runAiCommentJob(accountA);
      const row = await queue(event);
      await expect(decideAiComment(actor('agent'), row.id, { decision: 'approve' })).rejects.toMatchObject({ code: 'forbidden' });
      await expect(decideAiComment(actorB, row.id, { decision: 'approve' })).rejects.toBeInstanceOf(InstagramError);
      expect(await queue(event)).toMatchObject({ status: 'pending', decided_by: null });
      expect(await decideAiComment(actor('admin'), row.id, { decision: 'reject' })).toBe('rejected');
      await expect(decideAiComment(actor('admin'), row.id, { decision: 'approve' })).rejects.toBeInstanceOf(AiCommentError);
      await runAiCommentJob(accountA);
      expect(m.replyToComment).not.toHaveBeenCalled();
    });

    it('records an ambiguous send as unknown and does not post it again', async () => {
      const event = await seedEvent();
      await runAiCommentJob(accountA);
      const row = await queue(event);
      await decideAiComment(actor('admin'), row.id, { decision: 'approve' });
      m.replyToComment.mockRejectedValue(Object.assign(new Error('timeout'), { name: 'AbortError' }));
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await runAiCommentJob(accountA);
      await runAiCommentJob(accountA);
      expect(m.replyToComment).toHaveBeenCalledTimes(1);
      expect((await queue(event)).status).toBe('unknown');
    });

    it('auto-approves and posts a positive draft only when auto-approve is on, and keeps a complaint waiting', async () => {
      await setSettings('instagram_ai_comments_auto_approve=true');
      const happy = await seedEvent();
      await runAiCommentJob(accountA);
      expect(await queue(happy)).toMatchObject({ status: 'sent', auto_approved: true });
      expect(m.replyToComment).toHaveBeenCalledTimes(1);

      answer({ sentiment: 'negative', intent: 'complaint', reply: 'Sorry about that, please send us a DM.' });
      const angry = await seedEvent();
      await runAiCommentJob(accountA);
      expect(await queue(angry)).toMatchObject({ status: 'pending', auto_approved: false });
      expect(m.replyToComment).toHaveBeenCalledTimes(1);
    });
  });

  describe('queue and settings', () => {
    it('lists waiting drafts with the live comment, only for the caller’s workspace', async () => {
      await seedEvent();
      await runAiCommentJob(accountA);
      const items = await listAiComments(actor('agent'), 'pending');
      expect(items.find((i) => i.reply === 'Thank you so much!')?.comment).toEqual({ available: true, text: 'Love this!', username: 'fan' });
      expect(await listAiComments(actorB, 'pending')).toEqual([]);
      m.getComment.mockRejectedValue(new Error('gone'));
      expect((await listAiComments(actor('agent'), 'pending'))[0].comment).toEqual({ available: false, text: null, username: null });
    });

    it('keeps skipped comments out of the history', async () => {
      m.getComment.mockResolvedValue({ id: '1', text: 'x', hidden: true, username: null, mediaId: null, timestamp: null });
      const event = await seedEvent();
      await runAiCommentJob(accountA);
      expect(await queue(event)).toMatchObject({ status: 'expired' });
      expect((await listAiComments(actor('admin'), 'history')).some((i) => i.errorCode === 'comment_unavailable')).toBe(false);
    });

    it('lets only an admin change the switches, and drafting needs a working AI setup', async () => {
      await expect(updateAiCommentSettings(actor('agent'), { enabled: false })).rejects.toMatchObject({ code: 'forbidden' });
      expect((await updateAiCommentSettings(actor('admin'), { autoApprove: true, dailyCap: 20 }))).toMatchObject({ autoApprove: true, dailyCap: 20, enabled: true });
      await expect(updateAiCommentSettings(actor('admin'), { dailyCap: 501 })).rejects.toBeInstanceOf(InstagramError);
      expect(await getAiCommentSettings(actor('agent'))).toMatchObject({ configured: true, aiActive: true });
      // Workspace B's AI setup is inactive: it cannot switch drafting on, and A's settings are untouched.
      await expect(updateAiCommentSettings(actorB, { enabled: true })).rejects.toMatchObject({ code: 'ai_not_configured' });
      expect((await getAiCommentSettings(actor('admin'))).dailyCap).toBe(20);
    });
  });
});
