// Stage 2 (2E) on a real PostgreSQL: conversation starters and "Convert to
// flow". Instagram's Graph API is mocked: no request ever leaves the test.
//   starters:
//   - admins only; at most 4; each linked to a live Instagram flow of the same
//     workspace (a WhatsApp, archived or other workspace's flow is refused)
//   - stored only after Meta accepts, with ib:<flow id> payloads
//   - a Meta failure stores nothing; a save that lost a race stores nothing
//   - another workspace's account is not found; members read, B reads none of A's
//   - iceBreakerFlowTx accepts only this account's current starters
//   conversion:
//   - one transaction: draft ig_comment flow + nodes, rule switched off, audit
//   - a failure inside the transaction leaves no flow and the rule active
//   - admins only; another workspace's rule is not found
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { encrypt } from '@/lib/whatsapp/encryption';
import { MetaApiError } from '@/lib/whatsapp/meta-api';

const graph = vi.hoisted(() => ({ setIceBreakers: vi.fn() }));
vi.mock('@/lib/instagram/graph', async (original) => ({ ...(await original<typeof import('@/lib/instagram/graph')>()), ...graph }));
const audit = vi.hoisted(() => ({ fail: false }));
vi.mock('@/lib/payments/ledger', async (original) => {
  const real = await original<typeof import('@/lib/payments/ledger')>();
  return {
    ...real,
    auditTx: async (...args: Parameters<typeof real.auditTx>) => {
      if (audit.fail) throw new Error('audit failed (test)');
      return real.auditTx(...args);
    },
  };
});

import { convertCommentRuleToFlow } from './comment-rule-convert';
import { InstagramError } from './errors';
import { getConversationStarters, iceBreakerFlowTx, setConversationStarters } from './ice-breakers';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const DM = ['instagram_business_basic', 'instagram_business_manage_messages', 'instagram_business_manage_comments'];
const accountA = randomUUID(), accountB = randomUUID();
const ownerA = randomUUID(), adminA = randomUUID(), agentA = randomUUID(), ownerB = randomUUID();
const seed = String(Date.now()).slice(-9);
let owner: pg.Client;
let igA = '', igB = '', igFlowA = '', igFlowA2 = '', waFlowA = '', archivedFlowA = '', igFlowB = '', ruleA = '', ruleB = '';

const actor = (role: 'owner' | 'admin' | 'agent', accountId = accountA) =>
  ({ accountId, userId: accountId === accountB ? ownerB : role === 'agent' ? agentA : adminA, role });
const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof InstagramError ? e.code : String(e)));
const storedOf = async (id: string) => (await owner.query(
  'SELECT ice_breakers, profile_synced_at FROM instagram_accounts WHERE id=$1', [id])).rows[0];

async function addAccount(accountId: string, userId: string, igUserId: string): Promise<string> {
  return (await owner.query(
    `INSERT INTO instagram_accounts(account_id,ig_user_id,username,access_token_enc,scopes,connected_by_user_id,token_expires_at,token_refreshed_at)
     VALUES($1,$2,'shop',$3,$4,$5,now()+interval '50 days',now()) RETURNING id`,
    [accountId, igUserId, encrypt('test-only-ig-token'), DM, userId])).rows[0].id;
}
async function addFlow(accountId: string, userId: string, scope: string, status = 'draft'): Promise<string> {
  return (await owner.query(`INSERT INTO flows(account_id,user_id,name,trigger_type,channel_scope,status)
    VALUES($1,$2,'Flow','manual',$3,$4) RETURNING id`, [accountId, userId, scope, status])).rows[0].id;
}

function enable() {
  vi.stubEnv('INSTAGRAM_ENABLED', 'true');
  vi.stubEnv('INSTAGRAM_APP_ID', '1234567890');
  vi.stubEnv('INSTAGRAM_APP_SECRET', 'test-only-ig-secret');
  vi.stubEnv('INSTAGRAM_WEBHOOK_VERIFY_TOKEN', 'test-only-verify');
  vi.stubEnv('APP_URL', 'https://app.example.test');
}

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Instagram tools (2E) on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string; role: string }[]>`SELECT current_database() AS name, current_user AS role`;
    if (!/test/i.test(app[0].name) || app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    const users = [ownerA, adminA, agentA, ownerB];
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'IG tools', 'test-only-hash' FROM unnest($1::uuid[]) x", [users]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'IG tools A',$2),($3,'IG tools B',$4)", [accountA, ownerA, accountB, ownerB]);
    await owner.query(`INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'agent'),($5,$6,'owner')`,
      [accountA, ownerA, adminA, agentA, accountB, ownerB]);
    igA = await addAccount(accountA, ownerA, `91${seed}`);
    igB = await addAccount(accountB, ownerB, `92${seed}`);
    igFlowA = await addFlow(accountA, ownerA, 'instagram');
    igFlowA2 = await addFlow(accountA, ownerA, 'instagram', 'active');
    waFlowA = await addFlow(accountA, ownerA, 'whatsapp');
    archivedFlowA = await addFlow(accountA, ownerA, 'instagram', 'archived');
    igFlowB = await addFlow(accountB, ownerB, 'instagram');
    ruleA = (await owner.query(`INSERT INTO instagram_comment_rules(account_id,instagram_account_id,media_id,keywords,reply_text,active)
      VALUES($1,$2,'17890001',ARRAY['price','link'],'Here is the link',true) RETURNING id`, [accountA, igA])).rows[0].id;
    ruleB = (await owner.query(`INSERT INTO instagram_comment_rules(account_id,instagram_account_id,reply_text)
      VALUES($1,$2,'hi') RETURNING id`, [accountB, igB])).rows[0].id;
  });
  beforeEach(() => {
    vi.unstubAllEnvs();
    enable();
    graph.setIceBreakers.mockReset();
    graph.setIceBreakers.mockResolvedValue(undefined);
    audit.fail = false;
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    if (owner) {
      const accounts = [accountA, accountB];
      await owner.query('DELETE FROM flows WHERE account_id=ANY($1::uuid[])', [accounts]);
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [accounts]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[ownerA, adminA, agentA, ownerB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  describe('conversation starters', () => {
    it('starts unmanaged: nothing set by Bodhinox yet', async () => {
      expect(await getConversationStarters(actor('agent'), igA))
        .toEqual({ instagramAccountId: igA, managed: false, syncedAt: null, starters: [] });
    });

    it('an admin sets them on Meta first, then they are stored', async () => {
      const view = await setConversationStarters(actor('admin'), igA, [
        { question: 'Opening hours?', flowId: igFlowA }, { question: 'Prices?', flowId: igFlowA2 },
      ]);
      expect(graph.setIceBreakers).toHaveBeenCalledTimes(1);
      const [igUserId, token, items] = graph.setIceBreakers.mock.calls[0];
      expect([igUserId, token]).toEqual([`91${seed}`, 'test-only-ig-token']);
      expect(items).toEqual([{ question: 'Opening hours?', payload: `ib:${igFlowA}` }, { question: 'Prices?', payload: `ib:${igFlowA2}` }]);
      const row = await storedOf(igA);
      expect(row.ice_breakers).toEqual([{ question: 'Opening hours?', flow_id: igFlowA }, { question: 'Prices?', flow_id: igFlowA2 }]);
      expect(row.profile_synced_at).not.toBeNull();
      expect(view.managed).toBe(true);
      expect(view.starters.map((s) => [s.flowId, s.flowUsable])).toEqual([[igFlowA, true], [igFlowA2, true]]);
      expect((await owner.query("SELECT metadata FROM audit_logs WHERE account_id=$1 AND action='instagram.ice_breakers.update'", [accountA]))
        .rows.map((r) => r.metadata)).toEqual([{ starters: 2 }]);
    });

    it('refuses a non-admin, more than 4, and any flow that is not a live Instagram flow of this workspace, before Meta', async () => {
      expect(await codeOf(setConversationStarters(actor('agent'), igA, [{ question: 'Q', flowId: igFlowA }]))).toBe('forbidden');
      const five = Array.from({ length: 5 }, (_, i) => ({ question: `Q${i}`, flowId: igFlowA }));
      expect(await codeOf(setConversationStarters(actor('admin'), igA, five))).toBe('invalid_request');
      for (const flowId of [waFlowA, archivedFlowA, igFlowB, randomUUID()]) {
        expect(await codeOf(setConversationStarters(actor('admin'), igA, [{ question: 'Q', flowId }]))).toBe('invalid_request');
      }
      expect(graph.setIceBreakers).not.toHaveBeenCalled();
    });

    it('stores nothing when Meta refuses or throttles', async () => {
      const before = await storedOf(igA);
      graph.setIceBreakers.mockRejectedValueOnce(new MetaApiError('Meta API error: 500', { httpStatus: 500 }));
      expect(await codeOf(setConversationStarters(actor('admin'), igA, [{ question: 'New?', flowId: igFlowA }]))).toBe('meta_error');
      graph.setIceBreakers.mockRejectedValueOnce(new MetaApiError('Meta API error: 401', { httpStatus: 401, code: 190 }));
      expect(await codeOf(setConversationStarters(actor('admin'), igA, [{ question: 'New?', flowId: igFlowA }])))
        .toBe('instagram_token_invalid');
      expect(await storedOf(igA)).toEqual(before);
    });

    it('a save that another save overtook stores nothing and asks to retry', async () => {
      const before = await storedOf(igA);
      graph.setIceBreakers.mockImplementationOnce(async () => {
        // Another admin's save lands while this one is talking to Meta.
        await owner.query("UPDATE instagram_accounts SET profile_synced_at=now()+interval '1 second' WHERE id=$1", [igA]);
      });
      expect(await codeOf(setConversationStarters(actor('admin'), igA, [{ question: 'Raced?', flowId: igFlowA }]))).toBe('rate_limited');
      expect((await storedOf(igA)).ice_breakers).toEqual(before.ice_breakers);
    });

    it('an empty list removes them on Meta and stores an empty list', async () => {
      await setConversationStarters(actor('admin'), igA, []);
      expect(graph.setIceBreakers.mock.calls[0][2]).toEqual([]);
      expect((await storedOf(igA)).ice_breakers).toEqual([]);
      await setConversationStarters(actor('admin'), igA, [{ question: 'Opening hours?', flowId: igFlowA }]);
    });

    it('keeps other workspaces out: their account is not found and B reads none of A’s', async () => {
      expect(await codeOf(getConversationStarters(actor('admin'), igB))).toBe('not_found');
      expect(await codeOf(setConversationStarters(actor('admin'), igB, [{ question: 'Q', flowId: igFlowA }]))).toBe('not_found');
      expect(await codeOf(getConversationStarters(actor('owner', accountB), igA))).toBe('not_found');
      const seen = await withTenant({ accountId: accountB, userId: ownerB, role: 'owner' },
        (tx) => tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM instagram_accounts WHERE ice_breakers IS NOT NULL`);
      expect(seen[0].n).toBe(0);
      expect(graph.setIceBreakers).not.toHaveBeenCalled();
    });

    it('shows a starter whose flow was archived as not usable', async () => {
      await owner.query("UPDATE flows SET status='archived' WHERE id=$1", [igFlowA]);
      try {
        const view = await getConversationStarters(actor('agent'), igA);
        expect(view.starters).toEqual([expect.objectContaining({ flowId: igFlowA, flowUsable: false })]);
      } finally {
        await owner.query("UPDATE flows SET status='draft' WHERE id=$1", [igFlowA]);
      }
    });

    it('iceBreakerFlowTx accepts only this account’s current starters', async () => {
      const check = (accountId: string, ig: string, flowId: string) =>
        withTenant({ accountId, role: 'owner' }, (tx) => iceBreakerFlowTx(tx, accountId, ig, flowId));
      expect(await check(accountA, igA, igFlowA)).toBe(true);
      expect(await check(accountA, igA, igFlowA2)).toBe(false);
      expect(await check(accountB, igA, igFlowA)).toBe(false);
      expect(await check(accountA, igA, 'not-a-uuid')).toBe(false);
    });
  });

  describe('convert a comment rule to a flow', () => {
    it('refuses a non-admin and another workspace’s rule', async () => {
      expect(await codeOf(convertCommentRuleToFlow(actor('agent'), igA, ruleA))).toBe('forbidden');
      expect(await codeOf(convertCommentRuleToFlow(actor('admin'), igB, ruleB))).toBe('not_found');
      expect(await codeOf(convertCommentRuleToFlow(actor('admin'), igA, ruleB))).toBe('not_found');
      expect((await owner.query('SELECT active FROM instagram_comment_rules WHERE id=$1', [ruleB])).rows[0].active).toBe(true);
    });

    it('rolls back everything when the transaction fails', async () => {
      const flowsBefore = (await owner.query("SELECT count(*)::int AS n FROM flows WHERE account_id=$1 AND trigger_type='ig_comment'", [accountA])).rows[0].n;
      audit.fail = true;
      expect(await codeOf(convertCommentRuleToFlow(actor('admin'), igA, ruleA))).toMatch(/audit failed/);
      expect((await owner.query("SELECT count(*)::int AS n FROM flows WHERE account_id=$1 AND trigger_type='ig_comment'", [accountA])).rows[0].n)
        .toBe(flowsBefore);
      expect((await owner.query('SELECT active FROM instagram_comment_rules WHERE id=$1', [ruleA])).rows[0].active).toBe(true);
    });

    it('creates the equivalent draft Instagram flow and switches the rule off in one transaction', async () => {
      const { flowId } = await convertCommentRuleToFlow(actor('admin'), igA, ruleA);
      const flow = (await owner.query(`SELECT account_id::text, user_id::text, status, trigger_type, trigger_config, entry_node_id, channel_scope
        FROM flows WHERE id=$1`, [flowId])).rows[0];
      expect(flow).toMatchObject({
        account_id: accountA, user_id: adminA, status: 'draft', trigger_type: 'ig_comment', entry_node_id: 'start', channel_scope: 'instagram',
      });
      expect(flow.trigger_config).toEqual({
        instagram_account_id: igA, post_scope: 'specific', media_ids: ['17890001'], include_keywords: ['price', 'link'], include_mode: 'contains',
      });
      const nodes = (await owner.query('SELECT account_id::text, node_key, node_type, config FROM flow_nodes WHERE flow_id=$1 ORDER BY position_y',
        [flowId])).rows;
      expect(nodes.map((n) => [n.account_id, n.node_key, n.node_type])).toEqual([
        [accountA, 'start', 'start'], [accountA, 'private_reply', 'ig_private_reply'], [accountA, 'end', 'end'],
      ]);
      expect(nodes[1].config).toEqual({ text: 'Here is the link', next_node_key: 'end' });
      expect((await owner.query('SELECT active FROM instagram_comment_rules WHERE id=$1', [ruleA])).rows[0].active).toBe(false);
      expect((await owner.query("SELECT metadata FROM audit_logs WHERE account_id=$1 AND action='instagram.comment_rule.convert' AND resource_id=$2",
        [accountA, ruleA])).rows.map((r) => r.metadata)).toEqual([{ instagram_account_id: igA, flow_id: flowId }]);
      // Workspace B never sees the new flow.
      const seenByB = await withTenant({ accountId: accountB, userId: ownerB, role: 'owner' },
        (tx) => tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM flows WHERE id=${flowId}::uuid`);
      expect(seenByB[0].n).toBe(0);
    });
  });
});
