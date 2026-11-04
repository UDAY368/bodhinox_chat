import { randomBytes, randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import { generate, generateSecret } from 'otplib';
import { disconnectDatabases, getAuthPrisma, getPrisma } from '@/lib/db/prisma';
import { hashPassword } from './password';
import { decryptMfaSecret, encryptMfaSecret, enrollMfa, getMfaStatus, hasOwnPassword, verifyMfaEnrollment } from './mfa';
import { login, resetPassword } from './service';
import { hashToken } from './csrf';
import { hashInviteToken } from './invitations';
import type { AuthContext } from './session';
import { verifyAccessToken } from './jwt';
import {
  completeGooglePendingMfa,
  getGoogleLink,
  linkGoogleIdentity,
  signInWithGoogle,
  unlinkGoogleIdentity,
} from './google-oidc';
import {
  listDeviceSessions,
  recordSessionDevice,
  revokeDeviceSession,
  revokeOtherDeviceSessions,
} from './device-sessions';

config({ path: '.env.test', quiet: true });
const connectionString = process.env.TEST_AUTH_DATABASE_URL;
const password = 'A-long-test-password-42';
const users: string[] = [];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

async function passwordUser(): Promise<{ id: string; accountId: string; email: string }> {
  const id = randomUUID(),
    accountId = randomUUID(),
    email = `${id}@example.invalid`;
  users.push(id);
  const encoded = await hashPassword(password);
  await getAuthPrisma().$transaction(async (tx) => {
    await tx.$executeRaw`INSERT INTO auth_users(id,email,full_name,password_hash,email_verified_at) VALUES(${id}::uuid,${email},'Google test',${encoded},NOW())`;
    await tx.$executeRaw`INSERT INTO accounts(id,name,owner_user_id) VALUES(${accountId}::uuid,'Google test workspace',${id}::uuid)`;
    await tx.$executeRaw`INSERT INTO account_memberships(id,account_id,user_id,role) VALUES(${randomUUID()}::uuid,${accountId}::uuid,${id}::uuid,'owner')`;
  });
  return { id, accountId, email };
}
async function sessionFor(userId: string, accountId: string, userAgent: string | null = null): Promise<string> {
  const id = randomUUID();
  await getAuthPrisma().$executeRaw`INSERT INTO auth_sessions(id,user_id,account_id,csrf_hash,expires_at,user_agent)
    VALUES(${id}::uuid,${userId}::uuid,${accountId}::uuid,${'a'.repeat(64)},NOW()+INTERVAL '1 day',${userAgent})`;
  return id;
}
const subject = () => `g-${randomUUID()}`;

describe.skipIf(!connectionString)('Google sign-in and device sessions on a real database', () => {
  beforeAll(async () => {
    process.env.AUTH_DATABASE_URL = connectionString;
    process.env.APP_URL = 'https://auth.integration.test';
    process.env.AUTH_JWT_ISSUER = 'https://auth.integration.test';
    process.env.AUTH_JWT_AUDIENCE = 'auth-integration';
    process.env.AUTH_JWT_KID = 'google-integration-key';
    process.env.AUTH_MFA_ENCRYPTION_KEY = randomBytes(32).toString('hex');
    const keys = await generateKeyPair('RS256', { extractable: true });
    process.env.AUTH_JWT_PRIVATE_KEY = await exportPKCS8(keys.privateKey);
    process.env.AUTH_JWT_PUBLIC_KEY = await exportSPKI(keys.publicKey);
    const identity = await getAuthPrisma().$queryRaw<{ database: string; role: string }[]>`
      SELECT current_database() AS database,current_user AS role`;
    if (!/test/i.test(identity[0].database) || identity[0].role !== 'bodhinox_auth')
      throw new Error('Requires a separately named test database and bodhinox_auth credentials');
  }, 30000);
  afterAll(async () => {
    if (!connectionString) return;
    await getAuthPrisma().$transaction(async (tx) => {
      for (const id of users) {
        await tx.$executeRaw`DELETE FROM accounts WHERE owner_user_id=${id}::uuid`;
        await tx.$executeRaw`DELETE FROM auth_users WHERE id=${id}::uuid`;
      }
    });
    await disconnectDatabases();
  }, 30000);

  it('creates a verified user and workspace for a new Google account, then signs the same subject in again', async () => {
    const identity = { subject: subject(), email: `${randomUUID()}@example.invalid`, name: 'New Googler' };
    const first = await signInWithGoogle(identity, UA);
    expect(first).toMatchObject({ kind: 'session', created: true });
    const claims = await verifyAccessToken((first as { session: { accessToken: string } }).session.accessToken);
    users.push(claims.sub);
    const rows = await getAuthPrisma().$queryRaw<{ email_verified_at: Date | null; role: string; user_agent: string | null }[]>`
      SELECT u.email_verified_at,m.role,s.user_agent FROM auth_users u
      JOIN account_memberships m ON m.user_id=u.id JOIN auth_sessions s ON s.user_id=u.id WHERE u.id=${claims.sub}::uuid`;
    expect(rows[0].email_verified_at).not.toBeNull();
    expect(rows[0].role).toBe('owner');
    expect(rows[0].user_agent).toBe(UA);
    const again = await signInWithGoogle({ ...identity, email: `changed-${identity.email}` }, null);
    expect(again).toMatchObject({ kind: 'session', created: false });
    expect(await getGoogleLink(claims.sub)).toMatchObject({ email: `changed-${identity.email}` });
  });

  it('joins the invited workspace for a new Google identity started from an invitation link', async () => {
    const owner = await passwordUser();
    const inviteId = randomUUID(),
      token = randomBytes(32).toString('base64url');
    await getAuthPrisma().$executeRaw`INSERT INTO account_invitations(id,account_id,token_hash,role,created_by_user_id,expires_at)
      VALUES(${inviteId}::uuid,${owner.accountId}::uuid,${hashInviteToken(token)},'viewer',${owner.id}::uuid,NOW()+INTERVAL '1 day')`;
    const identity = { subject: subject(), email: `${randomUUID()}@example.invalid`, name: 'Invited Googler' };
    const result = await signInWithGoogle(identity, UA, token);
    expect(result).toMatchObject({ kind: 'session', created: true, joinedInvite: true });
    const claims = await verifyAccessToken((result as { session: { accessToken: string } }).session.accessToken);
    users.push(claims.sub);
    const rows = await getAuthPrisma().$queryRaw<{ account_id: string; role: string }[]>`
      SELECT account_id,role FROM account_memberships WHERE user_id=${claims.sub}::uuid`;
    expect(rows).toEqual([{ account_id: owner.accountId, role: 'viewer' }]);
    expect(await getAuthPrisma().$queryRaw<unknown[]>`SELECT id FROM accounts WHERE owner_user_id=${claims.sub}::uuid`).toHaveLength(0);
    const sessions = await getAuthPrisma().$queryRaw<{ account_id: string }[]>`
      SELECT account_id FROM auth_sessions WHERE user_id=${claims.sub}::uuid`;
    expect(sessions).toEqual([{ account_id: owner.accountId }]);
    // The link is now used: another new Google identity is refused and nothing is created.
    const late = { subject: subject(), email: `${randomUUID()}@example.invalid`, name: 'Late' };
    await expect(signInWithGoogle(late, UA, token)).rejects.toMatchObject({ code: 'google_invite_unavailable' });
    expect(await getAuthPrisma().$queryRaw<unknown[]>`SELECT id FROM auth_users WHERE email=${late.email}`).toHaveLength(0);
  });

  it('never links on an email match, even for a verified user', async () => {
    const user = await passwordUser();
    await expect(signInWithGoogle({ subject: subject(), email: user.email, name: '' }, null)).rejects.toMatchObject({
      code: 'google_link_required',
    });
    expect(await getGoogleLink(user.id)).toBeNull();
  });

  it('links from a signed-in session, rejects a subject owned by someone else, and unlinks only with the password', async () => {
    const owner = await passwordUser();
    const other = await passwordUser();
    const sub = subject();
    const context = { userId: owner.id, accountId: owner.accountId, sessionId: await sessionFor(owner.id, owner.accountId) };
    await linkGoogleIdentity(context, { subject: sub, email: 'me@gmail.example', name: '' });
    await linkGoogleIdentity(context, { subject: sub, email: 'me@gmail.example', name: '' });
    await expect(linkGoogleIdentity(context, { subject: subject(), email: 'x@gmail.example', name: '' })).rejects.toMatchObject({ code: 'google_already_linked' });
    const otherContext = { userId: other.id, accountId: other.accountId, sessionId: await sessionFor(other.id, other.accountId) };
    await expect(linkGoogleIdentity(otherContext, { subject: sub, email: 'me@gmail.example', name: '' })).rejects.toMatchObject({ code: 'google_in_use' });
    const signedIn = await signInWithGoogle({ subject: sub, email: 'me@gmail.example', name: '' }, null);
    expect(signedIn.kind).toBe('session');
    await expect(unlinkGoogleIdentity(context, 'wrong-password')).rejects.toMatchObject({ code: 'current_password_invalid' });
    expect(await unlinkGoogleIdentity(context, password)).toBe(true);
    expect(await getGoogleLink(owner.id)).toBeNull();
  });

  it('keeps two-step verification: a linked MFA user needs a valid code before a session exists', async () => {
    const user = await passwordUser();
    const sub = subject();
    const secret = generateSecret();
    await getAuthPrisma().$executeRaw`INSERT INTO auth_mfa_factors(id,user_id,secret_encrypted,recovery_hashes,verified_at)
      VALUES(${randomUUID()}::uuid,${user.id}::uuid,${encryptMfaSecret(secret)},ARRAY[]::text[],NOW())`;
    const context = { userId: user.id, accountId: user.accountId, sessionId: await sessionFor(user.id, user.accountId) };
    await linkGoogleIdentity(context, { subject: sub, email: 'mfa@gmail.example', name: '' });
    const before = await getAuthPrisma().$queryRaw<{ n: bigint }[]>`SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id=${user.id}::uuid`;
    const result = await signInWithGoogle({ subject: sub, email: 'mfa@gmail.example', name: '' }, null);
    expect(result).toEqual({ kind: 'mfa', userId: user.id });
    const after = await getAuthPrisma().$queryRaw<{ n: bigint }[]>`SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id=${user.id}::uuid`;
    expect(after[0].n).toBe(before[0].n);
    const pending = { userId: user.id, next: '/dashboard', invite: null, jti: randomUUID() };
    await expect(completeGooglePendingMfa(pending, '000000', null)).rejects.toMatchObject({ code: 'mfa_invalid' });
    await expect(completeGooglePendingMfa(null, '000000', null)).rejects.toMatchObject({ code: 'google_expired' });
    const factor = await getAuthPrisma().$queryRaw<{ secret_encrypted: string }[]>`SELECT secret_encrypted FROM auth_mfa_factors WHERE user_id=${user.id}::uuid`;
    const session = await completeGooglePendingMfa(pending, await generate({ secret: decryptMfaSecret(factor[0].secret_encrypted) }), UA);
    const claims = await verifyAccessToken(session.accessToken);
    const rows = await getAuthPrisma().$queryRaw<{ mfa_verified_at: Date | null }[]>`SELECT mfa_verified_at FROM auth_sessions WHERE id=${claims.sid}::uuid`;
    expect(rows[0].mfa_verified_at).not.toBeNull();
  });

  it('refuses disabled users even when the Google subject is linked', async () => {
    const user = await passwordUser();
    const sub = subject();
    const context = { userId: user.id, accountId: user.accountId, sessionId: await sessionFor(user.id, user.accountId) };
    await linkGoogleIdentity(context, { subject: sub, email: 'off@gmail.example', name: '' });
    await getAuthPrisma().$executeRaw`UPDATE auth_users SET disabled_at=NOW() WHERE id=${user.id}::uuid`;
    await expect(signInWithGoogle({ subject: sub, email: 'off@gmail.example', name: '' }, null)).rejects.toMatchObject({ code: 'google_failed' });
  });

  it('lists and revokes only the caller’s own sessions', async () => {
    const user = await passwordUser();
    const stranger = await passwordUser();
    const current = await sessionFor(user.id, user.accountId);
    const phone = await sessionFor(user.id, user.accountId, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Mobile/15E148 Safari/604.1');
    const laptop = await sessionFor(user.id, user.accountId);
    const foreign = await sessionFor(stranger.id, stranger.accountId);
    await recordSessionDevice(current, UA);
    await recordSessionDevice(current, 'ignored once set');
    const context = { userId: user.id, sessionId: current };
    const listed = await listDeviceSessions(context);
    expect(listed.map((s) => s.id).sort()).toEqual([current, phone, laptop].sort());
    expect(listed.find((s) => s.id === current)).toMatchObject({ current: true, browser: 'Chrome', os: 'Windows', location: null });
    expect(listed.find((s) => s.id === phone)).toMatchObject({ current: false, os: 'iOS', device: 'mobile' });
    await expect(revokeDeviceSession(context, current)).rejects.toMatchObject({ code: 'current_session' });
    expect(await revokeDeviceSession(context, foreign)).toBe(false);
    expect(await revokeDeviceSession(context, phone)).toBe(true);
    expect(await revokeOtherDeviceSessions(context)).toBe(1);
    expect((await listDeviceSessions(context)).map((s) => s.id)).toEqual([current]);
    expect((await listDeviceSessions({ userId: stranger.id, sessionId: foreign })).map((s) => s.id)).toEqual([foreign]);
  });

  const contextFor = async (accessToken: string): Promise<AuthContext> => {
    const claims = await verifyAccessToken(accessToken);
    return {
      userId: claims.sub,
      accountId: claims.tenant_id,
      role: 'owner',
      sessionId: claims.sid,
      expiresAt: Date.now() + 60_000,
      user: { id: claims.sub, email: 'owner@example.invalid', user_metadata: { full_name: 'Owner' } },
    };
  };

  it('lets a Google-only account confirm two-step setup with a sign-in from the last 10 minutes', async () => {
    const identity = { subject: subject(), email: `${randomUUID()}@example.invalid`, name: 'Google only' };
    const first = await signInWithGoogle(identity, UA);
    if (first.kind !== 'session') throw new Error('expected a session');
    const context = await contextFor(first.session.accessToken);
    users.push(context.userId);
    expect(await hasOwnPassword(context)).toBe(false);
    // An old Google session is not proof: sign in again.
    await getAuthPrisma().$executeRaw`UPDATE auth_sessions SET created_at=NOW()-INTERVAL '11 minutes' WHERE id=${context.sessionId}::uuid`;
    await expect(enrollMfa(context, undefined)).rejects.toMatchObject({ code: 'google_reauth_required' });
    // A revoked session is not proof either.
    const second = await signInWithGoogle(identity, UA);
    if (second.kind !== 'session') throw new Error('expected a session');
    const fresh = await contextFor(second.session.accessToken);
    await getAuthPrisma().$executeRaw`UPDATE auth_sessions SET revoked_at=NOW() WHERE id=${fresh.sessionId}::uuid`;
    await expect(enrollMfa(fresh, undefined)).rejects.toMatchObject({ code: 'google_reauth_required' });
    // A fresh Google session works without a password; a guessed password changes nothing.
    const third = await signInWithGoogle(identity, UA);
    if (third.kind !== 'session') throw new Error('expected a session');
    const current = await contextFor(third.session.accessToken);
    const { secret } = await enrollMfa(current, 'not-a-password');
    expect(await getMfaStatus(current)).toBe(false);
    const codes = await verifyMfaEnrollment(current, await generate({ secret }));
    expect(codes).toHaveLength(10);
    expect(await getMfaStatus(current)).toBe(true);
    // Every other MFA rule stays: enrolling again is refused, and the next Google sign-in needs a code.
    await expect(enrollMfa(current, undefined)).rejects.toMatchObject({ status: 409 });
    expect(await signInWithGoogle(identity, UA)).toEqual({ kind: 'mfa', userId: current.userId });
  });

  it('keeps the password requirement for accounts that have a password, even on a fresh Google sign-in', async () => {
    const user = await passwordUser();
    const sub = subject();
    const linkContext = { userId: user.id, accountId: user.accountId, sessionId: await sessionFor(user.id, user.accountId) };
    await linkGoogleIdentity(linkContext, { subject: sub, email: 'pw@gmail.example', name: '' });
    const signedIn = await signInWithGoogle({ subject: sub, email: 'pw@gmail.example', name: '' }, UA);
    if (signedIn.kind !== 'session') throw new Error('expected a session');
    const context = await contextFor(signedIn.session.accessToken);
    expect(await hasOwnPassword(context)).toBe(true);
    await expect(enrollMfa(context, undefined)).rejects.toMatchObject({ code: 'current_password_invalid' });
    await expect(enrollMfa(context, 'wrong-password')).rejects.toMatchObject({ code: 'current_password_invalid' });
    await expect(enrollMfa(context, password)).resolves.toHaveProperty('secret');
  });

  it('a Google account that sets a password through reset needs that password for setup again', async () => {
    const identity = { subject: subject(), email: `${randomUUID()}@example.invalid`, name: 'Later password' };
    const first = await signInWithGoogle(identity, UA);
    if (first.kind !== 'session') throw new Error('expected a session');
    const context = await contextFor(first.session.accessToken);
    users.push(context.userId);
    const token = `reset-${randomUUID()}`;
    await getAuthPrisma().$executeRaw`INSERT INTO auth_verifications(id,user_id,purpose,token_hash,expires_at)
      VALUES(${randomUUID()}::uuid,${context.userId}::uuid,'reset',${hashToken(token)},NOW()+INTERVAL '1 hour')`;
    await resetPassword(token, password);
    expect(await hasOwnPassword(context)).toBe(true);
    const again = await signInWithGoogle(identity, UA);
    if (again.kind !== 'session') throw new Error('expected a session');
    await expect(enrollMfa(await contextFor(again.session.accessToken), undefined)).rejects.toMatchObject({
      code: 'current_password_invalid',
    });
  });

  it('records the device for a password sign-in and shows it in the sessions list', async () => {
    const user = await passwordUser();
    const issued = await login({ email: user.email, password }, { userAgent: UA });
    const claims = await verifyAccessToken(issued.accessToken);
    expect(issued.sessionId).toBe(claims.sid);
    const rows = await getAuthPrisma().$queryRaw<{ user_agent: string | null; sign_in_method: string | null }[]>`
      SELECT user_agent,sign_in_method FROM auth_sessions WHERE id=${issued.sessionId}::uuid`;
    expect(rows[0]).toEqual({ user_agent: UA, sign_in_method: 'password' });
    const listed = await listDeviceSessions({ userId: user.id, sessionId: issued.sessionId });
    expect(listed.find((s) => s.id === issued.sessionId)).toMatchObject({
      current: true,
      browser: 'Chrome',
      os: 'Windows',
      device: 'desktop',
    });
    // A password session is never proof for the Google-only rule.
    await getAuthPrisma().$executeRaw`UPDATE auth_users SET password_set=false WHERE id=${user.id}::uuid`;
    await expect(enrollMfa(await contextFor(issued.accessToken), undefined)).rejects.toMatchObject({
      code: 'google_reauth_required',
    });
  });

  it.skipIf(!process.env.TEST_APP_DATABASE_URL)('keeps auth_identities away from the app role', async () => {
    process.env.DATABASE_URL = process.env.TEST_APP_DATABASE_URL;
    await expect(getPrisma().$queryRaw`SELECT 1 FROM auth_identities LIMIT 1`).rejects.toThrow();
  });
});
