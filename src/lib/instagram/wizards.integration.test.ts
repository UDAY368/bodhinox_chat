// The Instagram quick-automation wizards on PostgreSQL (Stage 2): a wizard
// draft is a normal draft Instagram flow plus its steps, written in one
// transaction under the caller's tenant. RLS keeps it in the caller's
// workspace, refuses viewers and another workspace's id, and a failed step
// insert leaves no half-made flow behind.
//
// Connection settings come only from the environment (TEST_DATABASE_URL,
// TEST_APP_DATABASE_URL, TEST_WORKER_DATABASE_URL), as test-db-local.cjs sets
// them; the suite is skipped without them and refuses a non-test database.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { buildWizardFlow, createWizardFlow, parseWizardInput, type WizardFlowDraft } from './wizards';

const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const A = randomUUID(), B = randomUUID();
const agentA = randomUUID(), viewerA = randomUUID(), ownerB = randomUUID();
const asAgentA: TenantContext = { accountId: A, userId: agentA, role: 'agent' };
const asViewerA: TenantContext = { accountId: A, userId: viewerA, role: 'viewer' };
const asOwnerB: TenantContext = { accountId: B, userId: ownerB, role: 'owner' };

let db: pg.Client;
const q = (sql: string, params: unknown[] = []) => db.query(sql, params);
const flowCount = async (account: string) => (await q('SELECT count(*)::int AS n FROM flows WHERE account_id=$1', [account])).rows[0].n as number;

const draft: WizardFlowDraft = buildWizardFlow(parseWizardInput({
  wizard: 'grow_followers',
  keywords: ['freebie'],
  public_replies: ['Check your DMs'],
  message: 'Your freebie is ready.',
  reward_url: 'https://shop.example.com/freebie',
}));

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Instagram wizards on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await q('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await q("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'IG wizards', 'test-only-hash' FROM unnest($1::uuid[]) x",
      [[agentA, viewerA, ownerB]]);
    await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'IG wizards A',$2),($3,'IG wizards B',$4)", [A, agentA, B, ownerB]);
    await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'agent'),($1,$3,'viewer'),($4,$5,'owner')",
      [A, agentA, viewerA, B, ownerB]);
  });

  afterAll(async () => {
    if (db) {
      await q('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[A, B]]).catch(() => undefined);
      await q('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[agentA, viewerA, ownerB]]).catch(() => undefined);
      await db.end();
    }
    await disconnectDatabases();
  });

  it("saves a draft Instagram flow and its steps in the agent's workspace", async () => {
    const flow = await withTenant(asAgentA, (tx) => createWizardFlow(tx, { accountId: A, userId: agentA }, draft));
    expect(flow).toMatchObject({ name: draft.name, status: 'draft', channel_scope: 'instagram' });

    const row = (await q('SELECT account_id, user_id, status, channel_scope, trigger_type, trigger_config, entry_node_id, published_version_id FROM flows WHERE id=$1',
      [flow.id])).rows[0];
    expect(row).toEqual({
      account_id: A, user_id: agentA, status: 'draft', channel_scope: 'instagram', trigger_type: 'ig_comment',
      trigger_config: draft.trigger_config, entry_node_id: 'start', published_version_id: null,
    });
    const nodes = (await q('SELECT account_id, node_key, node_type, config FROM flow_nodes WHERE flow_id=$1 ORDER BY node_key', [flow.id])).rows;
    expect(nodes.map((n) => n.account_id)).toEqual(draft.nodes.map(() => A));
    expect(nodes.map((n) => [n.node_key, n.node_type, n.config])).toEqual(
      [...draft.nodes].sort((x, y) => x.node_key.localeCompare(y.node_key)).map((n) => [n.node_key, n.node_type, n.config]));

    // Another workspace never sees it.
    const seenByB = await withTenant(asOwnerB, (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id::text FROM flows WHERE id=${flow.id}::uuid`);
    expect(seenByB).toEqual([]);
  });

  it('refuses a viewer, and writes nothing', async () => {
    const before = await flowCount(A);
    await expect(withTenant(asViewerA, (tx) => createWizardFlow(tx, { accountId: A, userId: viewerA }, draft))).rejects.toThrow();
    expect(await flowCount(A)).toBe(before);
  });

  it("never writes into another workspace, even when asked to by its id", async () => {
    const before = await flowCount(B);
    await expect(withTenant(asAgentA, (tx) => createWizardFlow(tx, { accountId: B, userId: agentA }, draft))).rejects.toThrow();
    expect(await flowCount(B)).toBe(before);
  });

  it('leaves no half-made flow when a step cannot be saved', async () => {
    const before = await flowCount(A);
    const broken: WizardFlowDraft = { ...draft, nodes: [...draft.nodes, { node_key: 'bad', node_type: 'not_a_step' as never, config: {} }] };
    await expect(withTenant(asAgentA, (tx) => createWizardFlow(tx, { accountId: A, userId: agentA }, broken))).rejects.toThrow();
    expect(await flowCount(A)).toBe(before);
  });
});
