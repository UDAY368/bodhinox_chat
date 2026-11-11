// Stage 2 (2D) on a real PostgreSQL: the flow builder's post picker
// (listPickerMedia). Instagram's Graph API is mocked: no request leaves the test.
//   - an agent reads the posts of its own workspace's account, with that account's own token
//   - another workspace's account id is not_found before any token is loaded or Instagram called
//   - a viewer is refused; a disconnected account is refused; nothing is written
//   - Meta failures become fixed codes; everything is refused while Instagram is off
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { encrypt } from '@/lib/whatsapp/encryption';
import { MetaApiError } from '@/lib/whatsapp/meta-api';

const graph = vi.hoisted(() => ({ listMediaPage: vi.fn() }));
vi.mock('@/lib/instagram/graph', async (original) => ({ ...(await original<typeof import('@/lib/instagram/graph')>()), ...graph }));

import { listPickerMedia } from './media-picker';
import { InstagramError } from './errors';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

// Only the comment scope is missing: the picker needs no more than basic access.
const BASIC = ['instagram_business_basic', 'instagram_business_manage_messages'];
const accountA = randomUUID(), accountB = randomUUID();
const ownerA = randomUUID(), agentA = randomUUID(), viewerA = randomUUID(), ownerB = randomUUID();
const users = [ownerA, agentA, viewerA, ownerB];
const seed = String(Date.now()).slice(-9);
let owner: pg.Client;
let igA = '', igGone = '', igB = '';

const actor = (role: 'owner' | 'agent' | 'viewer', userId = role === 'agent' ? agentA : role === 'viewer' ? viewerA : ownerA) =>
  ({ accountId: accountA, userId, role });
const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof InstagramError ? e.code : String(e)));
const post = { id: '17890001', caption: 'Sale', mediaType: 'IMAGE', previewUrl: null, permalink: null, timestamp: null, isReel: false };

function enable() {
  vi.stubEnv('INSTAGRAM_ENABLED', 'true');
  vi.stubEnv('INSTAGRAM_APP_ID', '1234567890');
  vi.stubEnv('INSTAGRAM_APP_SECRET', 'test-only-ig-secret');
  vi.stubEnv('INSTAGRAM_WEBHOOK_VERIFY_TOKEN', 'test-only-verify');
  vi.stubEnv('APP_URL', 'https://app.example.test');
}

async function addAccount(accountId: string, userId: string, igUserId: string, token: string | null, status = 'active'): Promise<string> {
  return (await owner.query(
    `INSERT INTO instagram_accounts(account_id,ig_user_id,username,access_token_enc,scopes,status,connected_by_user_id,token_expires_at)
     VALUES($1,$2,'shop',$3,$4,$5,$6,now()+interval '50 days') RETURNING id`,
    [accountId, igUserId, token === null ? null : encrypt(token), BASIC, status, userId])).rows[0].id;
}

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Instagram post picker on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string; role: string }[]>`SELECT current_database() AS name, current_user AS role`;
    if (!/test/i.test(app[0].name) || app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'IG media test', 'test-only-hash' FROM unnest($1::uuid[]) x", [users]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'IG media A',$2),($3,'IG media B',$4)", [accountA, ownerA, accountB, ownerB]);
    await owner.query(`INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'agent'),($1,$4,'viewer'),($5,$6,'owner')`,
      [accountA, ownerA, agentA, viewerA, accountB, ownerB]);
    igA = await addAccount(accountA, ownerA, `91${seed}`, 'test-only-token-a');
    igGone = await addAccount(accountA, ownerA, `92${seed}`, null, 'disconnected');
    igB = await addAccount(accountB, ownerB, `93${seed}`, 'test-only-token-b');
  });
  beforeEach(() => {
    vi.unstubAllEnvs();
    enable();
    graph.listMediaPage.mockReset();
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [users]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('an agent reads its own account’s posts with that account’s own token', async () => {
    graph.listMediaPage.mockResolvedValueOnce({ media: [post], next: 'QVFIUnext' });
    expect(await listPickerMedia(actor('agent'), igA)).toEqual({ media: [post], next: 'QVFIUnext' });
    expect(graph.listMediaPage).toHaveBeenCalledExactlyOnceWith(`91${seed}`, 'test-only-token-a', undefined);
    // The next page is read with the same account's token and the cursor.
    graph.listMediaPage.mockResolvedValueOnce({ media: [], next: null });
    await listPickerMedia(actor('agent'), igA, 'QVFIUnext');
    expect(graph.listMediaPage).toHaveBeenLastCalledWith(`91${seed}`, 'test-only-token-a', 'QVFIUnext');
  });

  it('refuses another workspace’s account, a viewer and a disconnected account before any Instagram call', async () => {
    expect(await codeOf(listPickerMedia(actor('owner'), igB))).toBe('not_found');
    expect(await codeOf(listPickerMedia(actor('agent'), randomUUID()))).toBe('not_found');
    expect(await codeOf(listPickerMedia(actor('agent'), 'not-a-uuid'))).toBe('not_found');
    expect(await codeOf(listPickerMedia(actor('viewer'), igA))).toBe('forbidden');
    expect(await codeOf(listPickerMedia(actor('agent'), igGone))).toBe('instagram_account_disconnected');
    expect(graph.listMediaPage).not.toHaveBeenCalled();
  });

  it('turns Meta failures into fixed codes and writes nothing', async () => {
    graph.listMediaPage.mockRejectedValueOnce(new MetaApiError('Meta API error: 401', { code: 190, httpStatus: 401 }));
    expect(await codeOf(listPickerMedia(actor('agent'), igA))).toBe('instagram_token_invalid');
    graph.listMediaPage.mockRejectedValueOnce(new MetaApiError('Meta API error: 500', { httpStatus: 500 }));
    expect(await codeOf(listPickerMedia(actor('agent'), igA))).toBe('meta_error');
    const row = (await owner.query('SELECT status, last_error_code FROM instagram_accounts WHERE id=$1', [igA])).rows[0];
    expect(row).toEqual({ status: 'active', last_error_code: null });
  });

  it('refuses everything while Instagram is off', async () => {
    vi.stubEnv('INSTAGRAM_ENABLED', 'false');
    expect(await codeOf(listPickerMedia(actor('agent'), igA))).toBe('instagram_not_enabled');
    expect(graph.listMediaPage).not.toHaveBeenCalled();
  });
});
