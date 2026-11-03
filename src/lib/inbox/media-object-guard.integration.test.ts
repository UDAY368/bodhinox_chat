import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { mediaObjectUrl } from '@/lib/storage/client';
import { assertDirectObjectChange } from './media-library';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;

const accountA = randomUUID(), accountB = randomUUID();
const adminA = randomUUID(), agentA = randomUUID(), agent2A = randomUUID(), ownerB = randomUUID();
const asAdmin: TenantContext = { accountId: accountA, userId: adminA, role: 'admin' };
const asAgent: TenantContext = { accountId: accountA, userId: agentA, role: 'agent' };
const asAgent2: TenantContext = { accountId: accountA, userId: agent2A, role: 'agent' };
const asB: TenantContext = { accountId: accountB, userId: ownerB, role: 'owner' };
const seed = String(Date.now()).slice(-9);
let owner: pg.Client;

const key = (name: string, folder = 'uploads', account = accountA) => `account-${account}/${folder}/${seed}-${name}`;
async function media(objectKey: string, uploader: string, opts: { account?: string; inLibrary?: boolean; retain?: boolean } = {}) {
  await owner.query(
    `INSERT INTO media_objects(account_id,uploaded_by,bucket,object_key,content_type,byte_size,in_library,retain_until)
     VALUES($1,$2,'chat-media',$3,'image/png',100,$4,CASE WHEN $5 THEN now() + interval '1 day' END)`,
    [opts.account ?? accountA, uploader, objectKey, opts.inLibrary ?? false, opts.retain ?? false]);
}
async function outcome(context: TenantContext, objectKey: string): Promise<string> {
  try {
    await withTenant(context, (tx) => assertDirectObjectChange(tx, context.accountId, 'chat-media', objectKey, { userId: context.userId, role: context.role }));
    return 'allowed';
  } catch (error) {
    return `${(error as { status?: number }).status}:${(error as { code?: string }).code}`;
  }
}

describe.skipIf(!ownerUrl || !appUrl)('direct media object guard on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Guard test', 'test-only-hash' FROM unnest($1::uuid[]) x",
      [[adminA, agentA, agent2A, ownerB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Guard A',$2),($3,'Guard B',$4)", [accountA, adminA, accountB, ownerB]);
    await owner.query(`INSERT INTO account_memberships(account_id,user_id,role) VALUES ($1,$2,'admin'),($1,$3,'agent'),($1,$4,'agent'),($5,$6,'owner')`,
      [accountA, adminA, agentA, agent2A, accountB, ownerB]);
  });

  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[adminA, agentA, agent2A, ownerB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('refuses the library and inbound folders for everyone, even with no row', async () => {
    for (const folder of ['library', 'inbound']) {
      expect(await outcome(asAdmin, key('x.png', folder))).toBe('403:forbidden');
      expect(await outcome(asAgent, key('x.png', folder))).toBe('403:forbidden');
    }
  });

  it('refuses a library item stored outside the library folder', async () => {
    const k = key('promoted.png');
    await media(k, agentA, { inLibrary: true });
    expect(await outcome(asAgent, k)).toBe('403:forbidden');
    expect(await outcome(asAdmin, k)).toBe('403:forbidden');
  });

  it("lets only an admin or the uploader change another member's file", async () => {
    const k = key('mine.png');
    await media(k, agentA);
    expect(await outcome(asAgent2, k)).toBe('403:forbidden');
    expect(await outcome(asAgent, k)).toBe('allowed');
    expect(await outcome(asAdmin, k)).toBe('allowed');
    const system = key('system.png');
    await media(system, adminA);
    await owner.query('UPDATE media_objects SET uploaded_by=NULL WHERE account_id=$1 AND object_key=$2', [accountA, system]);
    expect(await outcome(asAgent, system)).toBe('403:forbidden');
  });

  it('refuses retained and referenced files, even for the uploader', async () => {
    const retained = key('retained.png');
    await media(retained, agentA, { retain: true });
    expect(await outcome(asAgent, retained)).toBe('409:retained');
    const header = key('header.png');
    await media(header, agentA);
    await owner.query("INSERT INTO message_templates(account_id,user_id,name,body_text,header_media_url) VALUES($1,$2,$3,'Hi',$4)",
      [accountA, adminA, `guard_${seed}`, mediaObjectUrl('chat-media', header)]);
    expect(await outcome(asAgent, header)).toBe('409:in_use');
    expect(await outcome(asAdmin, header)).toBe('409:in_use');
  });

  it("allows unknown keys, and never sees another workspace's row", async () => {
    expect(await outcome(asAgent, key('never-stored.png'))).toBe('allowed');
    const foreign = key('theirs.png', 'uploads', accountB);
    await media(foreign, ownerB, { account: accountB, inLibrary: true });
    // Workspace A looking up B's key finds nothing (account filter and RLS); B's own rules still apply to B.
    expect(await outcome(asAgent, foreign)).toBe('allowed');
    expect(await outcome(asB, foreign)).toBe('403:forbidden');
  });
});
