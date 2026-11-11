// Stage 5 (5F) automation folders on a real PostgreSQL, through the same lib
// the routes call (flows/folders, flows/folders/[id], flows/[id]/folder): one
// list per channel, names unique without case, agents and above write, a
// viewer cannot, deleting a folder keeps its flows, a flow is only filed in a
// folder of its channel, and another workspace's folder or flow is 404.
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import type { TenantContext } from '@/lib/db/tenant';
import { createFolder, deleteFolder, listFolders, moveFlowToFolder, renameFolder } from './folders';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;

const A = randomUUID(), B = randomUUID(), agentA = randomUUID(), viewerA = randomUUID(), ownerB = randomUUID();
const igFlow = randomUUID(), waFlow = randomUUID(), legacyFlow = randomUUID(), flowB = randomUUID();
const agent: TenantContext = { accountId: A, userId: agentA, role: 'agent' };
const viewer: TenantContext = { accountId: A, userId: viewerA, role: 'viewer' };
const other: TenantContext = { accountId: B, userId: ownerB, role: 'owner' };
let db: pg.Client;
const q = (sql: string, params: unknown[] = []) => db.query(sql, params);

describe.skipIf(!ownerUrl || !appUrl)('automation folders on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await q('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await q("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Folders', 'test-only-hash' FROM unnest($1::uuid[]) x", [[agentA, viewerA, ownerB]]);
    await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Folders A',$2),($3,'Folders B',$4)", [A, agentA, B, ownerB]);
    await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'agent'),($1,$3,'viewer'),($4,$5,'owner')", [A, agentA, viewerA, B, ownerB]);
    await q(`INSERT INTO flows(id,account_id,user_id,name,trigger_type,channel_scope) VALUES
      ($1,$5,$6,'IG flow','keyword','instagram'),($2,$5,$6,'WA flow','keyword','whatsapp'),($3,$5,$6,'Legacy','keyword','any'),
      ($4,$7,$8,'B flow','keyword','instagram')`, [igFlow, waFlow, legacyFlow, flowB, A, agentA, B, ownerB]);
  });
  afterAll(async () => {
    if (db) {
      await q('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[A, B]]);
      await q('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[agentA, viewerA, ownerB]]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('keeps one list per channel, with names unique without case', async () => {
    const leads = await createFolder(agent, 'instagram', '  Leads  ');
    expect(leads).toMatchObject({ channel: 'instagram', name: 'Leads', flow_count: 0 });
    await expect(createFolder(agent, 'instagram', 'LEADS')).rejects.toMatchObject({ code: 'name_taken' });
    // The same name in the other channel's section is fine.
    await createFolder(agent, 'whatsapp', 'Leads');
    await expect(createFolder(agent, 'instagram', '')).rejects.toMatchObject({ code: 'invalid_name' });
    expect((await listFolders(agent, 'instagram')).map((f) => f.name)).toEqual(['Leads']);
    expect((await listFolders(viewer, 'whatsapp')).map((f) => f.name)).toEqual(['Leads']);
  });

  it('lets a viewer read but not write (RLS: agents and above)', async () => {
    await expect(createFolder(viewer, 'instagram', 'Viewer folder')).rejects.toThrow();
    const [folder] = await listFolders(viewer, 'instagram');
    await expect(renameFolder(viewer, folder.id, 'Renamed')).rejects.toMatchObject({ code: 'not_found' });
    await expect(deleteFolder(viewer, folder.id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await listFolders(agent, 'instagram'))[0].name).toBe('Leads');
  });

  it('files a flow only in a folder of its channel; a legacy flow fits either', async () => {
    const [ig] = await listFolders(agent, 'instagram');
    const [wa] = await listFolders(agent, 'whatsapp');
    await moveFlowToFolder(agent, igFlow, ig.id);
    await moveFlowToFolder(agent, legacyFlow, wa.id);
    await expect(moveFlowToFolder(agent, waFlow, ig.id)).rejects.toMatchObject({ code: 'wrong_channel' });
    expect((await listFolders(agent, 'instagram'))[0].flow_count).toBe(1);
    await moveFlowToFolder(agent, legacyFlow, null);
    expect((await q('SELECT folder_id FROM flows WHERE id=$1', [legacyFlow])).rows[0].folder_id).toBeNull();
  });

  it('renames, and deletes a folder while keeping its flows at the top level', async () => {
    const [ig] = await listFolders(agent, 'instagram');
    await renameFolder(agent, ig.id, 'Hot leads');
    expect((await listFolders(agent, 'instagram'))[0].name).toBe('Hot leads');
    await deleteFolder(agent, ig.id);
    expect(await listFolders(agent, 'instagram')).toEqual([]);
    const flow = (await q('SELECT id, folder_id FROM flows WHERE id=$1', [igFlow])).rows[0];
    expect(flow).toEqual({ id: igFlow, folder_id: null });
  });

  it('treats another workspace’s folders and flows as missing', async () => {
    const theirs = await createFolder(other, 'instagram', 'Theirs');
    const mine = await createFolder(agent, 'instagram', 'Mine');
    expect((await listFolders(agent, 'instagram')).map((f) => f.name)).toEqual(['Mine']);
    await expect(renameFolder(agent, theirs.id, 'Taken over')).rejects.toMatchObject({ code: 'not_found' });
    await expect(deleteFolder(agent, theirs.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(moveFlowToFolder(agent, igFlow, theirs.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(moveFlowToFolder(agent, flowB, mine.id)).rejects.toMatchObject({ code: 'flow_not_found' });
    expect((await q('SELECT name FROM flow_folders WHERE id=$1', [theirs.id])).rows[0].name).toBe('Theirs');
    expect((await q('SELECT folder_id FROM flows WHERE id=$1', [flowB])).rows[0].folder_id).toBeNull();
  });
});
