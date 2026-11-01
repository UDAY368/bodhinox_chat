import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import type { TenantContext } from '@/lib/db/tenant';
import { createCampaign } from '@/lib/broadcasts/create-campaign';
import { deleteAttribute, listAttributes, saveAttribute, workspaceValues } from '@/lib/workspace/attributes';
import { AudienceFilterError } from './filter';
import { exportContactsCsv } from './export';
import { changeListMembers, createList, deleteList, listContacts, listLists } from './lists';
import { previewAudience } from './segments';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const admin = randomUUID(), agent = randomUUID(), viewer = randomUUID(), outsider = randomUUID();
const asha = randomUUID(), bilal = randomUUID(), chen = randomUUID(), foreignContact = randomUUID(), templateId = randomUUID();
const a: TenantContext = { accountId: accountA, userId: agent, role: 'agent' };
const adminA: TenantContext = { accountId: accountA, userId: admin, role: 'admin' };
const viewerA: TenantContext = { accountId: accountA, userId: viewer, role: 'viewer' };
const b: TenantContext = { accountId: accountB, userId: outsider, role: 'owner' };
let owner: pg.Client;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('static lists, workspace attributes and tag categories on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string; role: string }[]>`SELECT current_database() AS name, current_user AS role`;
    if (!/test/i.test(app[0].name) || app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await getWorkerPrisma().$queryRaw`SELECT 1`;
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'List test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[admin, agent, viewer, outsider]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Lists A',$2),($3,'Lists B',$4)", [accountA, admin, accountB, outsider]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'agent'),($1,$4,'viewer'),($5,$6,'owner')", [accountA, admin, agent, viewer, accountB, outsider]);
    await owner.query(`INSERT INTO contacts(id,account_id,user_id,name,phone,opted_out_at,blocked_at) VALUES
      ($1,$5,$6,'Asha','14155550201',NULL,NULL),
      ($2,$5,$6,'Bilal','14155550202',now(),NULL),
      ($3,$5,$6,'Chen','14155550203',NULL,now()),
      ($4,$7,$8,'Foreign','14155550204',NULL,NULL)`, [asha, bilal, chen, foreignContact, accountA, agent, accountB, outsider]);
    await owner.query("INSERT INTO message_templates(id,account_id,user_id,name,body_text,status) VALUES($1,$2,$3,'list_template','Hi','APPROVED')", [templateId, accountA, agent]);
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id = ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[admin, agent, viewer, outsider]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('creates a list, adds only this workspace\'s contacts, pages, removes and deletes', async () => {
    const list = await createList(a, { name: 'Event' });
    await expect(createList(a, { name: 'Event' })).rejects.toBeInstanceOf(AudienceFilterError);
    // The foreign contact is silently skipped; re-adding is idempotent.
    expect(await changeListMembers(a, list.id, { add: [asha, bilal, chen, foreignContact] })).toEqual({ added: 3, removed: 0 });
    expect(await changeListMembers(a, list.id, { add: [asha] })).toEqual({ added: 0, removed: 0 });
    expect((await listLists(a)).map((l) => [l.name, l.member_count])).toEqual([['Event', 3]]);
    expect((await listContacts(a, list.id, { offset: 0, limit: 25, search: 'bil' }))?.contacts.map((c) => c.id)).toEqual([bilal]);
    expect(await previewAudience(a, { filter: { conditions: [{ field: 'list', op: 'in_any', listIds: [list.id] }] } })).toEqual({ total: 3, sendable: 1 });
    expect(await changeListMembers(a, list.id, { remove: [chen] })).toEqual({ added: 0, removed: 1 });
    expect((await listContacts(a, list.id, { offset: 0, limit: 25 }))?.total).toBe(2);
    expect(await deleteList(a, list.id)).toBe(true);
    expect((await owner.query('SELECT count(*)::int AS n FROM contacts WHERE account_id=$1', [accountA])).rows[0].n).toBe(3);
  });

  it('isolates lists per workspace and refuses viewers', async () => {
    const list = await createList(a, { name: 'Private' });
    expect(await listLists(b)).toEqual([]);
    expect(await listContacts(b, list.id, { offset: 0, limit: 25 })).toBeNull();
    expect(await changeListMembers(b, list.id, { add: [foreignContact] })).toBeNull();
    expect(await deleteList(b, list.id)).toBe(false);
    await expect(previewAudience(b, { filter: { conditions: [{ field: 'list', op: 'in_any', listIds: [list.id] }] } }))
      .rejects.toBeInstanceOf(AudienceFilterError);
    await expect(createList(viewerA, { name: 'Viewer' })).rejects.toThrow();
    // RLS hides the row from a viewer's write lock, so it reads as not found and nothing changes.
    expect(await changeListMembers(viewerA, list.id, { add: [asha] })).toBeNull();
    expect((await listLists(a))[0].member_count).toBe(0);
    await deleteList(a, list.id);
  });

  it('sends a list campaign only to marketable members and exports the list', async () => {
    const list = await createList(a, { name: 'Campaign' });
    await changeListMembers(a, list.id, { add: [asha, bilal, chen] });
    const result = await createCampaign(a, { name: 'List campaign', templateId, audience: { type: 'list', listId: list.id }, variables: {} });
    expect((await owner.query('SELECT contact_id FROM broadcast_recipients WHERE broadcast_id=$1', [result.id])).rows).toEqual([{ contact_id: asha }]);
    await expect(createCampaign(b, { name: 'Forged', templateId: randomUUID(), audience: { type: 'list', listId: list.id }, variables: {} }))
      .rejects.toBeTruthy();
    const { rows, csv } = await exportContactsCsv(adminA, { listId: list.id });
    expect(rows).toBe(3);
    expect(csv).toContain('Chen');
    await expect(exportContactsCsv({ ...b, role: 'owner' }, { listId: list.id })).rejects.toBeInstanceOf(AudienceFilterError);
    await deleteList(a, list.id);
  });

  it('stores secret attributes encrypted, never lists their value and lets only admins write', async () => {
    await saveAttribute(adminA, { key: 'support_email', value: 'help@example.invalid' });
    await saveAttribute(adminA, { key: 'crm_token', value: 'tok-123', is_secret: true });
    expect(await listAttributes(a)).toEqual([
      expect.objectContaining({ key: 'crm_token', value: null, is_secret: true }),
      expect.objectContaining({ key: 'support_email', value: 'help@example.invalid', is_secret: false }),
    ]);
    const stored = (await owner.query("SELECT value, value_encrypted FROM workspace_attributes WHERE account_id=$1 AND key='crm_token'", [accountA])).rows[0];
    expect(stored.value).toBeNull();
    expect(stored.value_encrypted).not.toContain('tok-123');
    expect(await workspaceValues(accountA)).toEqual({ support_email: 'help@example.invalid' });
    expect(await workspaceValues(accountA, { secrets: true })).toEqual({ support_email: 'help@example.invalid', crm_token: 'tok-123' });
    expect(await workspaceValues(accountB, { secrets: true })).toEqual({});
    expect(await listAttributes(b)).toEqual([]);
    await expect(saveAttribute(a, { key: 'agent_key', value: 'x' })).rejects.toThrow();
    await expect(saveAttribute(adminA, { key: 'Bad Key', value: 'x' })).rejects.toThrow(/lowercase/);
    // Turning a secret back into a plain value replaces the ciphertext.
    await saveAttribute(adminA, { key: 'crm_token', value: 'public' });
    expect((await owner.query("SELECT value, value_encrypted FROM workspace_attributes WHERE account_id=$1 AND key='crm_token'", [accountA])).rows[0])
      .toEqual({ value: 'public', value_encrypted: null });
    expect(await deleteAttribute(b, 'crm_token')).toBe(false);
    expect(await deleteAttribute(adminA, 'crm_token')).toBe(true);
  });

  it('keeps tag categories within 40 characters', async () => {
    await owner.query("INSERT INTO tags(account_id,user_id,name,category) VALUES($1,$2,'Lead','Funnel')", [accountA, admin]);
    await expect(owner.query("INSERT INTO tags(account_id,user_id,name,category) VALUES($1,$2,'Long',repeat('x',41))", [accountA, admin])).rejects.toThrow();
  });
});
