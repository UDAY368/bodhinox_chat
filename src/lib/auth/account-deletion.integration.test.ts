// Phase 14 identity features on a real PostgreSQL with the constrained
// bodhinox_auth role: MFA step-up (current session only, replay-protected),
// "delete my account" (re-authentication, refusals, anonymisation, deletion
// request for sole workspaces, nothing tenant-side deleted), terms storage on
// signup and the NEW_WORKSPACE_PLAN hook.
import { randomBytes, randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const mail = vi.hoisted(() => ({ send: vi.fn().mockResolvedValue({ accepted: ['integration'] }) }));
vi.mock('nodemailer', () => ({ default: { createTransport: () => ({ sendMail: mail.send, close: vi.fn() }) } }));
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import { generate } from 'otplib';
import { disconnectDatabases, getAuthPrisma } from '@/lib/db/prisma';
import { cookieNames } from './cookies';
import { hashPassword } from './password';
import { requireSession, resolveSession } from './session';
import { lockOpenInvitation, login, signup } from './service';
import { generateInviteToken } from './invitations';
import pg from 'pg';
import { enrollMfa, stepUpMfa, verifyMfaEnrollment } from './mfa';
import { deleteMyAccount, deletedEmail } from './account-deletion';

config({ path: '.env.test', quiet: true });
const connectionString = process.env.TEST_AUTH_DATABASE_URL;
const password = 'A-long-test-password-42';
const users: string[] = [];
const accounts: string[] = [];

function request(accessToken: string): Request {
  return new Request('https://auth.integration.test/api/auth', {
    method: 'POST',
    headers: { origin: 'https://auth.integration.test', cookie: `${cookieNames().access}=${accessToken}` },
  });
}
/** A verified user owning one workspace; `members` adds that many other members to it. */
async function identity(members = 0): Promise<{ id: string; email: string; account: string }> {
  const id = randomUUID(), account = randomUUID(), email = `${id}@example.invalid`;
  users.push(id);
  accounts.push(account);
  const encoded = await hashPassword(password);
  await getAuthPrisma().$transaction(async (tx) => {
    await tx.$executeRaw`INSERT INTO auth_users(id,email,full_name,password_hash,email_verified_at) VALUES(${id}::uuid,${email},'P14 identity',${encoded},NOW())`;
    await tx.$executeRaw`INSERT INTO accounts(id,name,owner_user_id) VALUES(${account}::uuid,'P14 identity workspace',${id}::uuid)`;
    await tx.$executeRaw`INSERT INTO account_memberships(id,account_id,user_id,role) VALUES(${randomUUID()}::uuid,${account}::uuid,${id}::uuid,'owner')`;
    await tx.$executeRaw`INSERT INTO profiles(id,user_id,full_name,email,account_id,account_role) VALUES(${randomUUID()}::uuid,${id}::uuid,'P14 identity',${email},${account}::uuid,'owner')`;
    for (let i = 0; i < members; i++) {
      const other = randomUUID();
      users.push(other);
      await tx.$executeRaw`INSERT INTO auth_users(id,email,full_name,password_hash,email_verified_at) VALUES(${other}::uuid,${`${other}@example.invalid`},'Member',${encoded},NOW())`;
      await tx.$executeRaw`INSERT INTO account_memberships(id,account_id,user_id,role) VALUES(${randomUUID()}::uuid,${account}::uuid,${other}::uuid,'agent')`;
    }
  });
  return { id, email, account };
}

describe.skipIf(!connectionString)('Phase 14 identity: MFA step-up and account deletion', () => {
  beforeAll(async () => {
    process.env.AUTH_DATABASE_URL = connectionString;
    process.env.APP_URL = 'https://auth.integration.test';
    process.env.SMTP_URL = 'smtp://auth.integration.invalid';
    process.env.AUTH_EMAIL_FROM = 'integration@example.invalid';
    process.env.AUTH_JWT_ISSUER = 'https://auth.integration.test';
    process.env.AUTH_JWT_AUDIENCE = 'auth-integration';
    process.env.AUTH_JWT_KID = 'ephemeral-integration-key';
    process.env.AUTH_MFA_ENCRYPTION_KEY = randomBytes(32).toString('hex');
    const keys = await generateKeyPair('RS256', { extractable: true });
    process.env.AUTH_JWT_PRIVATE_KEY = await exportPKCS8(keys.privateKey);
    process.env.AUTH_JWT_PUBLIC_KEY = await exportSPKI(keys.publicKey);
    const who = await getAuthPrisma().$queryRaw<{ database: string; role: string }[]>`SELECT current_database() AS database,current_user AS role`;
    if (!/test/i.test(who[0].database) || who[0].role !== 'bodhinox_auth')
      throw new Error('Requires a separately named test database and constrained bodhinox_auth credentials');
  }, 30000);
  beforeEach(() => {
    delete process.env.TERMS_VERSION;
    delete process.env.NEW_WORKSPACE_PLAN;
  });
  afterAll(async () => {
    if (connectionString) {
      await getAuthPrisma().$transaction(async (tx) => {
        for (const id of accounts) await tx.$executeRaw`DELETE FROM accounts WHERE id=${id}::uuid`;
        for (const id of users) {
          await tx.$executeRaw`DELETE FROM accounts WHERE owner_user_id=${id}::uuid`;
          await tx.$executeRaw`DELETE FROM auth_users WHERE id=${id}::uuid`;
        }
      });
      await disconnectDatabases();
    }
  }, 30000);

  it('steps up MFA on the current session only and refuses a replayed code', async () => {
    const user = await identity();
    const first = await login({ email: user.email, password });
    const context = await requireSession(request(first.accessToken));
    const { secret } = await enrollMfa(context, password);
    await verifyMfaEnrollment(context, await generate({ secret }));
    await expect(stepUpMfa(context, 'not-a-code')).rejects.toMatchObject({ code: 'mfa_invalid' });
    // A second signed-in device (signing in with MFA marks it verified), then both go stale.
    await getAuthPrisma().$executeRaw`UPDATE auth_mfa_factors SET last_used_step=NULL WHERE user_id=${user.id}::uuid`;
    const second = await login({ email: user.email, password, mfaCode: await generate({ secret }) });
    const secondContext = await requireSession(request(second.accessToken));
    await getAuthPrisma().$executeRaw`UPDATE auth_sessions SET mfa_verified_at=NOW()-INTERVAL '20 hours' WHERE user_id=${user.id}::uuid`;
    await getAuthPrisma().$executeRaw`UPDATE auth_mfa_factors SET last_used_step=NULL WHERE user_id=${user.id}::uuid`;
    const code = await generate({ secret });
    const at = await stepUpMfa(context, code);
    expect(Date.now() - at.getTime()).toBeLessThan(60_000);
    // The same code cannot be used twice, even on another session.
    await expect(stepUpMfa(secondContext, code)).rejects.toMatchObject({ code: 'mfa_invalid' });
    const fresh = await getAuthPrisma().$queryRaw<{ id: string }[]>`
      SELECT id FROM auth_sessions WHERE user_id=${user.id}::uuid AND revoked_at IS NULL AND mfa_verified_at > NOW()-INTERVAL '1 minute'`;
    expect(fresh.map((s) => s.id)).toEqual([context.sessionId]);
  }, 30000);

  it('refuses a step-up for a user without MFA', async () => {
    const user = await identity();
    const session = await login({ email: user.email, password });
    const context = await requireSession(request(session.accessToken));
    await expect(stepUpMfa(context, '123456')).rejects.toMatchObject({ code: 'mfa_not_enabled' });
  }, 30000);

  it('refuses deletion with a wrong password, or while owning a workspace with other members', async () => {
    const user = await identity(1);
    const context = await requireSession(request((await login({ email: user.email, password })).accessToken));
    await expect(deleteMyAccount(context, { password: 'wrong-password-123!' })).rejects.toMatchObject({ code: 'current_password_invalid' });
    await expect(deleteMyAccount(context, { password })).rejects.toMatchObject({ status: 409, code: 'owns_shared_workspace' });
    const still = await getAuthPrisma().$queryRaw<{ email: string; deleted_at: Date | null }[]>`SELECT email, deleted_at FROM auth_users WHERE id=${user.id}::uuid`;
    expect(still[0]).toEqual({ email: user.email, deleted_at: null });
  }, 30000);

  it('deletes an account: anonymised, signed out everywhere, sole workspace closing, other memberships ended, nothing deleted', async () => {
    const user = await identity();
    const shared = await identity(0);
    await getAuthPrisma().$executeRaw`INSERT INTO account_memberships(id,account_id,user_id,role) VALUES(${randomUUID()}::uuid,${shared.account}::uuid,${user.id}::uuid,'agent')`;
    const session = await login({ email: user.email, password });
    const context = await requireSession(request(session.accessToken));
    const result = await deleteMyAccount(context, { password });
    expect(result).toEqual({ closedWorkspaces: 1, leftWorkspaces: 1, revokedApiKeys: 0 });
    expect(await resolveSession(request(session.accessToken))).toBeNull();
    const row = await getAuthPrisma().$queryRaw<{ email: string; full_name: string; password_set: boolean; disabled: boolean; deleted: boolean }[]>`
      SELECT email, full_name, password_set, disabled_at IS NOT NULL AS disabled, deleted_at IS NOT NULL AS deleted FROM auth_users WHERE id=${user.id}::uuid`;
    expect(row[0]).toEqual({ email: deletedEmail(user.id), full_name: '', password_set: false, disabled: true, deleted: true });
    await expect(login({ email: user.email, password })).rejects.toMatchObject({ status: 401 });
    // The owned workspace still exists, now closing with a 30-day grace; the other workspace keeps its data.
    const owned = await getAuthPrisma().$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM accounts WHERE id=${user.account}::uuid`;
    expect(owned[0].n).toBe(1);
    const memberships = await getAuthPrisma().$queryRaw<{ account_id: string; role: string }[]>`
      SELECT account_id, role FROM account_memberships WHERE user_id=${user.id}::uuid`;
    expect(memberships).toEqual([{ account_id: user.account, role: 'owner' }]);
    await expect(deleteMyAccount(context, { password })).rejects.toMatchObject({ status: 401 });
  }, 30000);

  it.skipIf(!process.env.TEST_DATABASE_URL)('closes an admin-suspended sole workspace as purge-due, keeps the hold, and ends its invitations', async () => {
    const owner = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await owner.connect();
    try {
      const user = await identity();
      const open = generateInviteToken();
      await getAuthPrisma().$executeRaw`INSERT INTO account_invitations(id,account_id,token_hash,role,created_by_user_id,expires_at)
        VALUES(${randomUUID()}::uuid,${user.account}::uuid,${open.hash},'agent',${user.id}::uuid,NOW()+INTERVAL '7 days')`;
      await owner.query(`INSERT INTO account_lifecycle(account_id,status,block_manual,suspended_at,suspend_reason,suspended_by_email)
        VALUES($1,'admin_suspended',true,now(),'Abuse report under review','ops@example.invalid')`, [user.account]);
      const context = await requireSession(request((await login({ email: user.email, password })).accessToken));
      expect(await deleteMyAccount(context, { password })).toMatchObject({ closedWorkspaces: 1 });
      const lifecycle = (await owner.query(`SELECT status, block_manual, suspend_reason, purge_after > now() + interval '29 days' AS grace
        FROM account_lifecycle WHERE account_id=$1`, [user.account])).rows[0];
      expect(lifecycle).toEqual({ status: 'closing', block_manual: true, suspend_reason: 'Abuse report under review', grace: true });
      expect((await owner.query("SELECT count(*)::int AS n FROM audit_logs WHERE account_id=$1 AND action='workspace.deletion_requested'", [user.account])).rows[0].n).toBe(1);
      // The open invitation ended with the owner; a newer one cannot join the closing workspace either.
      expect((await owner.query('SELECT expires_at <= now() AS ended FROM account_invitations WHERE token_hash=$1', [open.hash])).rows[0].ended).toBe(true);
      await expect(getAuthPrisma().$transaction((tx) => lockOpenInvitation(tx, open.token))).rejects.toMatchObject({ code: 'invite_unavailable' });
      const late = generateInviteToken();
      await getAuthPrisma().$executeRaw`INSERT INTO account_invitations(id,account_id,token_hash,role,created_by_user_id,expires_at)
        VALUES(${randomUUID()}::uuid,${user.account}::uuid,${late.hash},'agent',${user.id}::uuid,NOW()+INTERVAL '7 days')`;
      await expect(getAuthPrisma().$transaction((tx) => lockOpenInvitation(tx, late.token))).rejects.toMatchObject({ code: 'invite_unavailable' });
    } finally {
      await owner.end();
    }
  }, 30000);

  it('stores the accepted terms version only while TERMS_VERSION is set, and refuses signup without it', async () => {
    process.env.TERMS_VERSION = '2026-11-draft';
    const email = `${randomUUID()}@example.invalid`;
    await expect(signup({ email, password, fullName: 'Terms' })).rejects.toMatchObject({ code: 'terms_required' });
    await signup({ email, password, fullName: 'Terms', termsVersion: '2026-11-draft' });
    const rows = await getAuthPrisma().$queryRaw<{ id: string; terms_version: string | null; accepted: boolean }[]>`
      SELECT id, terms_version, terms_accepted_at IS NOT NULL AS accepted FROM auth_users WHERE email=${email}`;
    users.push(rows[0].id);
    expect(rows[0]).toMatchObject({ terms_version: '2026-11-draft', accepted: true });
    delete process.env.TERMS_VERSION;
    const plain = `${randomUUID()}@example.invalid`;
    await signup({ email: plain, password, fullName: 'No terms' });
    const none = await getAuthPrisma().$queryRaw<{ id: string; terms_version: string | null }[]>`SELECT id, terms_version FROM auth_users WHERE email=${plain}`;
    users.push(none[0].id);
    expect(none[0].terms_version).toBeNull();
  }, 30000);

  it('gives a new signup workspace NEW_WORKSPACE_PLAN, or the lowest plan (free) when unset, and never touches an existing workspace', async () => {
    const plan = async (email: string) => {
      const rows = await getAuthPrisma().$queryRaw<{ id: string; account: string }[]>`
        SELECT u.id, a.id AS account FROM auth_users u JOIN accounts a ON a.owner_user_id=u.id WHERE u.email=${email}`;
      users.push(rows[0].id);
      return rows[0].account;
    };
    const unset = `${randomUUID()}@example.invalid`;
    await signup({ email: unset, password, fullName: 'Default plan' });
    const unsetAccount = await plan(unset);
    process.env.NEW_WORKSPACE_PLAN = 'basic';
    const set = `${randomUUID()}@example.invalid`;
    await signup({ email: set, password, fullName: 'Basic plan' });
    const setAccount = await plan(set);
    // The auth role cannot read subscriptions; the definer reports whether a row exists by refusing a second one.
    const again = async (account: string) => (await getAuthPrisma().$queryRaw<{ ok: boolean }[]>`
      SELECT billing_assign_initial_plan(${account}::uuid, 'pro') AS ok`)[0].ok;
    expect(await again(setAccount)).toBe(false);
    expect(await again(unsetAccount)).toBe(false); // unset no longer means "no row = enterprise"
    const owner = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await owner.connect();
    try {
      const plans = async (account: string) => (await owner.query('SELECT plan_id, status FROM account_subscriptions WHERE account_id=$1', [account])).rows;
      expect(await plans(unsetAccount)).toEqual([{ plan_id: 'free', status: 'active' }]);
      expect(await plans(setAccount)).toEqual([{ plan_id: 'basic', status: 'active' }]);
      // An existing workspace (older than an hour, no subscription row) is never given a plan, so it keeps resolving as before.
      const old = randomUUID(), oldOwner = randomUUID();
      await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Old','test-only-hash')", [oldOwner, `${oldOwner}@example.invalid`]);
      users.push(oldOwner);
      await owner.query("INSERT INTO accounts(id,name,owner_user_id,created_at) VALUES($1,'Old workspace',$2,now() - interval '2 days')", [old, oldOwner]);
      try {
        expect((await getAuthPrisma().$queryRaw<{ ok: boolean }[]>`SELECT billing_assign_initial_plan(${old}::uuid, NULL) AS ok`)[0].ok).toBe(false);
        expect(await plans(old)).toEqual([]);
      } finally {
        await owner.query('DELETE FROM accounts WHERE id=$1', [old]);
      }
    } finally {
      await owner.end();
    }
  }, 30000);
});

