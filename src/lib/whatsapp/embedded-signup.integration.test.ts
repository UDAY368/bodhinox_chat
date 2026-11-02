import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import type { TenantContext } from '@/lib/db/tenant';
import { decrypt, encrypt } from '@/lib/whatsapp/encryption';

// Meta is mocked; the database (RLS, triggers, unique keys) is real.
const meta = vi.hoisted(() => ({
  exchange: vi.fn(),
  verify: vi.fn(),
  list: vi.fn(),
  subscribe: vi.fn(),
  register: vi.fn(),
}));
vi.mock('@/lib/whatsapp/meta-api', async (orig) => ({
  MetaApiError: (await orig<typeof import('./meta-api')>()).MetaApiError,
  exchangeEmbeddedSignupCode: meta.exchange,
  verifyPhoneNumber: meta.verify,
  listWabaPhoneNumbers: meta.list,
  subscribeWabaToApp: meta.subscribe,
  registerPhoneNumber: meta.register,
}));

import { connectEmbeddedSignup, retryEmbeddedSignupRegistration } from './embedded-signup-connect';
import { MetaApiError } from './meta-api';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const adminA = randomUUID(), ownerB = randomUUID();
const asA = { accountId: accountA, userId: adminA, role: 'admin' } satisfies TenantContext;
const asB = { accountId: accountB, userId: ownerB, role: 'owner' } satisfies TenantContext;
const seed = String(Date.now()).slice(-9);
const phone1 = `61${seed}`, phone2 = `62${seed}`, wabaA = `91${seed}`;
let owner: pg.Client;

const rowsOf = async (accountId: string) =>
  (await owner.query(
    'SELECT id,phone_number_id,waba_id,access_token,display_name,status,is_default,registered_at,subscribed_apps_at,user_id FROM whatsapp_config WHERE account_id=$1 ORDER BY created_at',
    [accountId],
  )).rows;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Embedded Signup on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string; role: string }[]>`SELECT current_database() AS name, current_user AS role`;
    if (!/test/i.test(app[0].name) || app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await getWorkerPrisma().$queryRaw`SELECT 1`;
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Signup test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[adminA, ownerB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Signup A',$2),($3,'Signup B',$4)", [accountA, adminA, accountB, ownerB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($3,$4,'owner')", [accountA, adminA, accountB, ownerB]);
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[adminA, ownerB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_META_APP_ID = '1234';
    process.env.NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID = '5678';
    process.env.META_APP_SECRET = 'test-only-secret';
    meta.exchange.mockResolvedValue({ accessToken: 'test-only-token-1' });
    meta.verify.mockImplementation(async ({ phoneNumberId }: { phoneNumberId: string }) => ({ id: phoneNumberId, display_phone_number: '+1', verified_name: `Biz ${phoneNumberId}` }));
    meta.list.mockImplementation(async () => [{ id: phone1 }, { id: phone2 }]);
    meta.subscribe.mockResolvedValue(undefined);
    meta.register.mockResolvedValue({ success: true, alreadyRegistered: false });
  });

  it('checkpoints the first number as default, then finishes on retry without a second row', async () => {
    meta.register.mockRejectedValueOnce(new MetaApiError('try later', { httpStatus: 500, code: 1 }));
    const first = await connectEmbeddedSignup(asA, { code: 'c1', waba_id: wabaA, phone_number_id: phone1 });
    expect(first).toMatchObject({ ok: false, code: 'registerFailed' });
    let rows = await rowsOf(accountA);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ phone_number_id: phone1, waba_id: wabaA, status: 'disconnected', is_default: true, display_name: `Biz ${phone1}`, user_id: adminA, registered_at: null });
    expect(rows[0].subscribed_apps_at).not.toBeNull();
    expect(rows[0].access_token).not.toContain('test-only-token');
    expect(decrypt(rows[0].access_token)).toBe('test-only-token-1');

    meta.exchange.mockResolvedValueOnce({ accessToken: 'test-only-token-2' });
    const second = await connectEmbeddedSignup(asA, { code: 'c2', waba_id: wabaA, phone_number_id: phone1 });
    expect(second).toMatchObject({ ok: true, created: false, number: { status: 'connected', is_default: true } });
    rows = await rowsOf(accountA);
    expect(rows).toHaveLength(1);
    expect(decrypt(rows[0].access_token)).toBe('test-only-token-2');
    expect(rows[0].registered_at).not.toBeNull();
    expect(meta.subscribe).toHaveBeenCalledTimes(1);
  });

  it('adds a second number to the same workspace as non-default', async () => {
    const result = await connectEmbeddedSignup(asA, { code: 'c3', waba_id: wabaA, phone_number_id: phone2 });
    expect(result).toMatchObject({ ok: true, created: true, number: { phone_number_id: phone2, is_default: false } });
    expect((await rowsOf(accountA)).map((r) => r.is_default)).toEqual([true, false]);
  });

  it("refuses another workspace's number without touching its row", async () => {
    const before = await rowsOf(accountA);
    const result = await connectEmbeddedSignup(asB, { code: 'c4', waba_id: wabaA, phone_number_id: phone1 });
    expect(result).toMatchObject({ ok: false, status: 409, code: 'numberLinkedElsewhere' });
    expect(await rowsOf(accountB)).toEqual([]);
    expect(await rowsOf(accountA)).toEqual(before);
    expect(meta.subscribe).not.toHaveBeenCalled();
  });

  it('keeps an existing manual connection and only refreshes its token', async () => {
    const phone3 = `63${seed}`;
    await owner.query(
      `INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,waba_id,access_token,status,registered_at,subscribed_apps_at,connected_at)
       VALUES($1,$2,$3,$4,$5,'connected',now(),now(),now())`,
      [accountB, ownerB, phone3, wabaA, encrypt('test-only-manual')],
    );
    meta.list.mockResolvedValue([{ id: phone3 }]);
    const result = await connectEmbeddedSignup(asB, { code: 'c5', waba_id: wabaA, phone_number_id: phone3 });
    expect(result).toMatchObject({ ok: true, created: false, pin: null, number: { status: 'connected', is_default: true } });
    expect(meta.register).not.toHaveBeenCalled();
    expect(meta.subscribe).not.toHaveBeenCalled();
    expect(decrypt((await rowsOf(accountB))[0].access_token)).toBe('test-only-token-1');
  });

  it("registers with the admin's existing PIN and does not echo it back", async () => {
    const phone4 = `64${seed}`;
    meta.list.mockResolvedValue([{ id: phone4 }]);
    const result = await connectEmbeddedSignup(asB, { code: 'c6', waba_id: wabaA, phone_number_id: phone4 }, { pin: '004321' });
    expect(result).toMatchObject({ ok: true, created: true, pin: null, number: { phone_number_id: phone4, status: 'connected' } });
    expect(meta.register).toHaveBeenCalledWith(expect.objectContaining({ phoneNumberId: phone4, pin: '004321' }));
  });

  it('answers pinMismatch with the row, then finishes with the stored token and the right PIN (no new code)', async () => {
    const phone5 = `65${seed}`;
    meta.list.mockResolvedValue([{ id: phone5 }]);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    meta.register.mockRejectedValueOnce(new MetaApiError('PIN mismatch', { httpStatus: 400, code: 133005 }));
    const first = await connectEmbeddedSignup(asB, { code: 'c7', waba_id: wabaA, phone_number_id: phone5 });
    expect(first).toMatchObject({ ok: false, status: 400, code: 'pinMismatch', step: 'register' });
    expect(first.ok ? null : first.pin).toBeUndefined();
    const configId = first.ok ? '' : first.config_id!;
    const saved = (await rowsOf(accountB)).find((r) => r.phone_number_id === phone5);
    expect(saved).toMatchObject({ id: configId, status: 'disconnected', registered_at: null });
    expect(saved!.subscribed_apps_at).not.toBeNull();

    // Another workspace cannot use the row id.
    expect(await retryEmbeddedSignupRegistration(asA, { config_id: configId, pin: '135790' })).toMatchObject({ ok: false, status: 404, code: 'notFound' });

    // Meta locks PIN attempts: a distinct code, still retryable.
    meta.register.mockRejectedValueOnce(new MetaApiError('locked', { httpStatus: 400, code: 133008 }));
    expect(await retryEmbeddedSignupRegistration(asB, { config_id: configId, pin: '111111' })).toMatchObject({ ok: false, code: 'pinLocked', config_id: configId });

    const exchangesBefore = meta.exchange.mock.calls.length;
    const retried = await retryEmbeddedSignupRegistration(asB, { config_id: configId, pin: '135790' });
    expect(retried).toMatchObject({ ok: true, created: false, pin: null, number: { id: configId, status: 'connected' } });
    expect(meta.exchange.mock.calls.length).toBe(exchangesBefore);
    expect(meta.subscribe).toHaveBeenCalledTimes(1);
    expect(meta.register).toHaveBeenLastCalledWith({ phoneNumberId: phone5, accessToken: 'test-only-token-1', pin: '135790' });
    const done = (await rowsOf(accountB)).find((r) => r.id === configId);
    expect(done!.registered_at).not.toBeNull();

    // Idempotent once registered: no further Meta call.
    const registers = meta.register.mock.calls.length;
    expect(await retryEmbeddedSignupRegistration(asB, { config_id: configId, pin: '135790' })).toMatchObject({ ok: true, pin: null });
    expect(meta.register.mock.calls.length).toBe(registers);

    // Neither PIN nor token reached the logs.
    const logged = JSON.stringify(errors.mock.calls);
    expect(logged).not.toMatch(/135790|111111|test-only-token/);
    errors.mockRestore();
  });
});
