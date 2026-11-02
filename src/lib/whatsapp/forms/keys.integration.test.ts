import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import type { TenantContext } from '@/lib/db/tenant';
import { encrypt } from '@/lib/whatsapp/encryption';
import { claimFormsKeyRotation, promoteFormsKey, releaseFormsKeyRotation } from './keys';
import { formsPrivateKeys } from './session-store';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const account = randomUUID(), admin = randomUUID(), agent = randomUUID();
const asAdmin: TenantContext = { accountId: account, userId: admin, role: 'admin' };
const asAgent: TenantContext = { accountId: account, userId: agent, role: 'agent' };
const phone = String(Date.now()).slice(-9) + '7';
const phoneB = String(Date.now()).slice(-9) + '8';
let numberA = '', numberB = '';
let owner: pg.Client;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('WhatsApp forms key rotation on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string; role: string }[]>`SELECT current_database() AS name, current_user AS role`;
    if (!/test/i.test(app[0].name) || app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Forms key test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[admin, agent]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Forms key',$2)", [account, admin]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'agent')", [account, admin, agent]);
    numberA = (await owner.query("INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,access_token,status,is_default) VALUES($1,$2,$3,'test-only-encrypted-token','connected',true) RETURNING id", [account, admin, phone])).rows[0].id;
    numberB = (await owner.query("INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,access_token,status) VALUES($1,$2,$3,'test-only-encrypted-token','connected') RETURNING id", [account, admin, phoneB])).rows[0].id;
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id = $1::uuid', [account]);
      await owner.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[admin, agent]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('lets one of two concurrent rotations claim the account, and only the claimed key is promoted', async () => {
    const [a, b] = [encrypt('test-only-key-a'), encrypt('test-only-key-b')];
    const claims = await Promise.all([claimFormsKeyRotation(asAdmin, numberA, a), claimFormsKeyRotation(asAdmin, numberA, b)]);
    expect(claims.map((c) => c.kind).sort()).toEqual(['busy', 'claimed']);
    const winner = claims[0].kind === 'claimed' ? a : b;
    const loser = winner === a ? b : a;
    expect(await promoteFormsKey(asAdmin, numberA, { publicKeyPem: 'test-only-public', pendingKeyEnc: loser, phoneNumberId: phone, uploadedAt: new Date() })).toBe(false);
    expect(await promoteFormsKey(asAdmin, numberA, { publicKeyPem: 'test-only-public', pendingKeyEnc: winner, phoneNumberId: phone, uploadedAt: new Date() })).toBe(true);
    expect(await formsPrivateKeys(account)).toEqual([winner === a ? 'test-only-key-a' : 'test-only-key-b']);
    expect((await claimFormsKeyRotation(asAdmin, numberA, encrypt('test-only-key-c'))).kind).toBe('claimed');
  });

  it('keeps an unpromoted key usable by the endpoint and frees the lease on release', async () => {
    await owner.query('UPDATE whatsapp_config SET forms_key_rotation_started_at = NULL, forms_pending_private_key_enc = NULL WHERE account_id = $1', [account]);
    const pending = encrypt('test-only-key-pending');
    expect((await claimFormsKeyRotation(asAdmin, numberA, pending)).kind).toBe('claimed');
    expect((await claimFormsKeyRotation(asAdmin, numberA, encrypt('test-only-other'))).kind).toBe('busy');
    expect((await formsPrivateKeys(account)).at(-1)).toBe('test-only-key-pending');
    await releaseFormsKeyRotation(asAdmin, numberA, pending);
    expect((await formsPrivateKeys(account)).at(-1)).toBe('test-only-key-pending');
    expect((await claimFormsKeyRotation(asAdmin, numberA, encrypt('test-only-key-next'))).kind).toBe('claimed');
  });

  it('lets an expired lease be taken over, and refuses agents', async () => {
    await owner.query("UPDATE whatsapp_config SET forms_key_rotation_started_at = now() - interval '10 minutes' WHERE account_id = $1", [account]);
    expect((await claimFormsKeyRotation(asAdmin, numberA, encrypt('test-only-key-late'))).kind).toBe('claimed');
    await owner.query('UPDATE whatsapp_config SET forms_key_rotation_started_at = NULL WHERE account_id = $1', [account]);
    const byAgent = await claimFormsKeyRotation(asAgent, numberA, encrypt('test-only-agent')).catch(() => null);
    expect(byAgent?.kind).not.toBe('claimed');
    expect((await owner.query('SELECT forms_key_rotation_started_at FROM whatsapp_config WHERE account_id = $1', [account])).rows[0].forms_key_rotation_started_at).toBeNull();
  });
  it("keeps one key per number, leases each number separately, and gives the endpoint every number's keys", async () => {
    await owner.query('UPDATE whatsapp_config SET forms_key_rotation_started_at = NULL, forms_pending_private_key_enc = NULL, forms_private_key_enc = NULL WHERE account_id = $1', [account]);
    const [keyA, keyB] = [encrypt('test-only-number-a'), encrypt('test-only-number-b')];
    // A live rotation on one number does not block the other.
    expect((await claimFormsKeyRotation(asAdmin, numberA, keyA)).kind).toBe('claimed');
    const claimB = await claimFormsKeyRotation(asAdmin, numberB, keyB);
    expect(claimB).toMatchObject({ kind: 'claimed', phoneNumberId: phoneB });
    // Promoting against the wrong number changes nothing.
    expect(await promoteFormsKey(asAdmin, numberA, { publicKeyPem: 'test-only-public-b', pendingKeyEnc: keyB, phoneNumberId: phoneB, uploadedAt: new Date() })).toBe(false);
    expect(await promoteFormsKey(asAdmin, numberB, { publicKeyPem: 'test-only-public-b', pendingKeyEnc: keyB, phoneNumberId: phoneB, uploadedAt: new Date() })).toBe(true);
    expect(await promoteFormsKey(asAdmin, numberA, { publicKeyPem: 'test-only-public-a', pendingKeyEnc: keyA, phoneNumberId: phone, uploadedAt: new Date() })).toBe(true);
    const rows = (await owner.query('SELECT id, forms_public_key FROM whatsapp_config WHERE account_id = $1', [account])).rows as { id: string; forms_public_key: string }[];
    expect(Object.fromEntries(rows.map((r) => [r.id, r.forms_public_key]))).toEqual({ [numberA]: 'test-only-public-a', [numberB]: 'test-only-public-b' });
    // The default number's key first; a form sent from either number can be opened.
    expect(await formsPrivateKeys(account)).toEqual(['test-only-number-a', 'test-only-number-b']);
    // A number id from outside the workspace is not found under RLS.
    expect((await claimFormsKeyRotation(asAdmin, randomUUID(), encrypt('test-only-stray'))).kind).toBe('notConnected');
  });
});
