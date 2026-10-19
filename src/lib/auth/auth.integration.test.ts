import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { randomBytes } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
const mail = vi.hoisted(() => ({
  send: vi.fn().mockResolvedValue({ accepted: ['integration'] }),
}));
vi.mock('nodemailer', () => ({
  default: { createTransport: () => ({ sendMail: mail.send }) },
}));
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import { generate } from 'otplib';
import { getAuthPrisma, disconnectDatabases } from '@/lib/db/prisma';
import { cookieNames } from './cookies';
import { hashToken, randomToken } from './csrf';
import { hashPassword, verifyPassword } from './password';
import {
  assertMutation,
  requireSession,
  resolveEnrollmentSession,
  resolveSession,
} from './session';
import {
  confirmEmailChange,
  login,
  requestEmailChange,
  resetPassword,
  revokeSessions,
  rotateRefreshToken,
  signup,
  switchTenant,
  updatePassword,
  verifyEmailToken,
} from './service';
import { handleAuthGet, handleAuthPost } from './http';
import { enrollMfa, verifyMfaEnrollment } from './mfa';

config({ path: '.env.test', quiet: true });
const connectionString = process.env.TEST_AUTH_DATABASE_URL;
const userId = randomUUID(),
  accountId = randomUUID(),
  email = `${userId}@example.invalid`;
const password = 'A-long-test-password-42';
const additionalUsers: string[] = [];
const additionalAccounts: string[] = [];
function request(accessToken?: string, csrfToken?: string): Request {
  return new Request('https://auth.integration.test/api/auth', {
    method: 'POST',
    headers: {
      origin: 'https://auth.integration.test',
      ...(accessToken
        ? { cookie: `${cookieNames().access}=${accessToken}` }
        : {}),
      ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
    },
  });
}
async function additionalIdentity(): Promise<{ id: string; email: string }> {
  const id = randomUUID(),
    tenant = randomUUID(),
    address = `${id}@example.invalid`;
  additionalUsers.push(id);
  const encoded = await hashPassword(password);
  await getAuthPrisma().$transaction(async (tx) => {
    await tx.$executeRaw`INSERT INTO auth_users(id,email,full_name,password_hash,email_verified_at) VALUES(${id}::uuid,${address},'Email-change test',${encoded},NOW())`;
    await tx.$executeRaw`INSERT INTO accounts(id,name,owner_user_id) VALUES(${tenant}::uuid,'Email-change workspace',${id}::uuid)`;
    await tx.$executeRaw`INSERT INTO account_memberships(id,user_id,account_id,role) VALUES(${randomUUID()}::uuid,${id}::uuid,${tenant}::uuid,'owner')`;
    await tx.$executeRaw`INSERT INTO profiles(id,user_id,full_name,email,account_id,account_role) VALUES(${randomUUID()}::uuid,${id}::uuid,'Email-change test',${address},${tenant}::uuid,'owner')`;
  });
  return { id, email: address };
}
function emailedChangeToken(to: string): string {
  const delivered = mail.send.mock.calls.findLast(
    (call) => (call[0] as { to: string }).to === to
  )?.[0] as { text: string };
  return new URL(delivered.text.match(/https:\/\/\S+/)![0]).searchParams.get(
    'token'
  )!;
}
describe.skipIf(!connectionString)(
  'real database JWT authentication and MFA',
  () => {
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
      const identity = await getAuthPrisma().$queryRaw<
        { database: string; role: string }[]
      >`SELECT current_database() AS database,current_user AS role`;
      if (
        !/test/i.test(identity[0].database) ||
        identity[0].role !== 'bodhinox_auth'
      )
        throw new Error(
          'Auth integration requires a separately named test database and constrained bodhinox_auth credentials'
        );
      const encoded = await hashPassword(password);
      await getAuthPrisma().$transaction(async (tx) => {
        await tx.$executeRaw`INSERT INTO auth_users(id,email,full_name,password_hash,email_verified_at) VALUES(${userId}::uuid,${email},'Auth integration',${encoded},NOW())`;
        await tx.$executeRaw`INSERT INTO accounts(id,name,owner_user_id) VALUES(${accountId}::uuid,'Auth integration workspace',${userId}::uuid)`;
        await tx.$executeRaw`INSERT INTO account_memberships(id,account_id,user_id,role) VALUES(${randomUUID()}::uuid,${accountId}::uuid,${userId}::uuid,'owner')`;
        await tx.$executeRaw`INSERT INTO profiles(id,user_id,full_name,email,account_id,account_role) VALUES(${randomUUID()}::uuid,${userId}::uuid,'Auth integration',${email},${accountId}::uuid,'owner')`;
      });
    }, 30000);
    beforeEach(async () => {
      await getAuthPrisma()
        .$executeRaw`DELETE FROM auth_rate_limits WHERE key=${hashToken(`login:${email}`)}`;
    }, 30000);
    afterAll(async () => {
      if (connectionString) {
        await getAuthPrisma().$transaction(async (tx) => {
          for (const id of additionalAccounts)
            await tx.$executeRaw`DELETE FROM accounts WHERE id=${id}::uuid`;
          await tx.$executeRaw`DELETE FROM accounts WHERE id=${accountId}::uuid`;
          await tx.$executeRaw`DELETE FROM auth_users WHERE id=${userId}::uuid`;
          for (const id of additionalUsers) {
            await tx.$executeRaw`DELETE FROM accounts WHERE owner_user_id=${id}::uuid`;
            await tx.$executeRaw`DELETE FROM auth_users WHERE id=${id}::uuid`;
          }
        });
        await disconnectDatabases();
      }
    }, 30000);
    it('bootstraps a workspace atomically and verifies its emailed one-time proof', async () => {
      const newEmail = `${randomUUID()}@example.invalid`;
      await signup({ email: newEmail, password, fullName: 'New owner' });
      const records = await getAuthPrisma().$queryRaw<
        { id: string }[]
      >`SELECT id FROM auth_users WHERE email=${newEmail}`;
      additionalUsers.push(records[0].id);
      await expect(login({ email: newEmail, password })).rejects.toMatchObject({
        code: 'email_unverified',
      });
      const delivered = mail.send.mock.calls.at(-1)?.[0] as { text: string };
      const token = new URL(
        delivered.text.split(': ')[1].split('\n')[0]
      ).searchParams.get('token')!;
      await verifyEmailToken(token);
      await expect(verifyEmailToken(token)).rejects.toThrow();
      const issued = await login({ email: newEmail, password });
      const context = await requireSession(request(issued.accessToken));
      expect(context.role).toBe('owner');
    }, 30000);
    it('retries a failed invitation signup email without changing credentials or losing the invitation', async () => {
      const newEmail = `${randomUUID()}@example.invalid`;
      const next = `/join/${randomToken()}`;
      const validPassword = 'Abcdef1!';
      mail.send.mockRejectedValueOnce(new Error('Test delivery failure'));
      await expect(signup({ email: newEmail, password: validPassword, fullName: 'Invited test member', next })).rejects.toThrow();
      const identities = await getAuthPrisma().$queryRaw<{ id: string }[]>`SELECT id FROM auth_users WHERE email=${newEmail}`;
      additionalUsers.push(identities[0].id);
      await signup({ email: newEmail, password: 'Different1!', fullName: 'Retry', next });
      const delivered = mail.send.mock.calls.at(-1)?.[0] as { text: string };
      const link = new URL(delivered.text.split(': ')[1].split('\n')[0]);
      expect(link.searchParams.get('next')).toBe(next);
      await verifyEmailToken(link.searchParams.get('token')!);
      await expect(login({ email: newEmail, password: validPassword })).resolves.toHaveProperty('accessToken');
      await expect(login({ email: newEmail, password: 'Different1!' })).rejects.toMatchObject({ code: 'unauthorized' });
    }, 30000);
    it('resolves membership roles live and immediately rejects logout-issued JWTs', async () => {
      const issued = await login({ email, password });
      const context = await requireSession(request(issued.accessToken));
      expect(context).toMatchObject({ userId, accountId, role: 'owner' });
      await getAuthPrisma()
        .$executeRaw`UPDATE account_memberships SET role='viewer' WHERE user_id=${userId}::uuid AND account_id=${accountId}::uuid`;
      expect((await requireSession(request(issued.accessToken))).role).toBe(
        'viewer'
      );
      await getAuthPrisma()
        .$executeRaw`UPDATE account_memberships SET role='owner' WHERE user_id=${userId}::uuid AND account_id=${accountId}::uuid`;
      await revokeSessions(context);
      expect(await resolveSession(request(issued.accessToken))).toBeNull();
    }, 30000);
    it('stores only hashed refresh secrets and revokes the family after replay', async () => {
      const issued = await login({ email, password });
      const rows = await getAuthPrisma().$queryRaw<
        { token_hash: string }[]
      >`SELECT token_hash FROM auth_refresh_tokens WHERE token_hash=${hashToken(issued.refreshToken)}`;
      expect(rows[0].token_hash).not.toBe(issued.refreshToken);
      const rotated = await rotateRefreshToken(
        issued.refreshToken,
        request(undefined, issued.csrfToken)
      );
      expect(rotated.expiresAt).toEqual(issued.expiresAt);
      await expect(
        rotateRefreshToken(
          issued.refreshToken,
          request(undefined, issued.csrfToken)
        )
      ).rejects.toThrow();
      expect(await resolveSession(request(rotated.accessToken))).toBeNull();
    }, 30000);
    it('serializes concurrent refresh attempts and commits replay revocation', async () => {
      const issued = await login({ email, password });
      const attempts = await Promise.allSettled([
        rotateRefreshToken(
          issued.refreshToken,
          request(undefined, issued.csrfToken)
        ),
        rotateRefreshToken(
          issued.refreshToken,
          request(undefined, issued.csrfToken)
        ),
      ]);
      expect(
        attempts.filter((result) => result.status === 'fulfilled')
      ).toHaveLength(1);
      expect(
        attempts.filter((result) => result.status === 'rejected')
      ).toHaveLength(1);
      const success = attempts.find((result) => result.status === 'fulfilled');
      if (success?.status === 'fulfilled')
        expect(
          await resolveSession(request(success.value.accessToken))
        ).toBeNull();
    }, 30000);
    it('rejects revoked membership using previously valid access and refresh tokens', async () => {
      const issued = await login({ email, password });
      await getAuthPrisma()
        .$executeRaw`DELETE FROM account_memberships WHERE user_id=${userId}::uuid AND account_id=${accountId}::uuid`;
      expect(await resolveSession(request(issued.accessToken))).toBeNull();
      await expect(
        rotateRefreshToken(
          issued.refreshToken,
          request(undefined, issued.csrfToken)
        )
      ).rejects.toThrow();
      await getAuthPrisma()
        .$executeRaw`INSERT INTO account_memberships(id,user_id,account_id,role) VALUES(${randomUUID()}::uuid,${userId}::uuid,${accountId}::uuid,'owner')`;
    }, 30000);
    it('invalidates every session on password changes and permits a reset proof only once', async () => {
      const first = await login({ email, password }),
        second = await login({ email, password });
      await updatePassword(
        await requireSession(request(first.accessToken)),
        'Changed-test-password-42',
        password
      );
      expect(await resolveSession(request(first.accessToken))).toBeNull();
      expect(await resolveSession(request(second.accessToken))).toBeNull();
      const token = randomToken();
      await getAuthPrisma()
        .$executeRaw`INSERT INTO auth_verifications(id,user_id,purpose,token_hash,expires_at) VALUES(${randomUUID()}::uuid,${userId}::uuid,'reset',${hashToken(token)},${new Date(Date.now() + 60000)})`;
      await resetPassword(token, password);
      await expect(
        resetPassword(token, 'Another-test-password-42')
      ).rejects.toThrow();
      const rows = await getAuthPrisma().$queryRaw<
        { password_hash: string }[]
      >`SELECT password_hash FROM auth_users WHERE id=${userId}::uuid`;
      expect(await verifyPassword(rows[0].password_hash, password)).toBe(true);
    }, 30000);
    it('issues native tokens only in declared HTTPS mode and accepts bearer sessions without browser cookies', async () => {
      const response = await handleAuthPost(
        new Request('https://auth.integration.test/api/auth/token-login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ clientMode: 'token', email, password }),
        }),
        'token-login'
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('set-cookie')).toBeNull();
      const tokens = await response.json();
      expect(tokens.access_token).toBeTruthy();
      expect(tokens.refresh_token).toBeTruthy();
      const incoming = new Request(
        'https://auth.integration.test/api/contacts',
        { headers: { authorization: `Bearer ${tokens.access_token}` } }
      );
      const context = await requireSession(incoming);
      expect(context.userId).toBe(userId);
      await expect(assertMutation(incoming, context)).resolves.toBeUndefined();
      expect(
        await resolveSession(
          new Request(incoming, {
            headers: {
              authorization: `Bearer ${tokens.access_token}`,
              cookie: `${cookieNames().access}=${tokens.access_token}`,
            },
          })
        )
      ).toBeNull();
      const refreshed = await handleAuthPost(
        new Request('https://auth.integration.test/api/auth/token-refresh', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            clientMode: 'token',
            refreshToken: tokens.refresh_token,
            csrfToken: tokens.csrf_token,
          }),
        }),
        'token-refresh'
      );
      expect(refreshed.status).toBe(200);
      expect((await refreshed.json()).refresh_token).not.toBe(
        tokens.refresh_token
      );
    }, 30000);
    it('switches tenants only with membership and immediately rejects the old tenant JWT', async () => {
      const destination = randomUUID();
      additionalAccounts.push(destination);
      await getAuthPrisma()
        .$executeRaw`INSERT INTO accounts(id,name,owner_user_id) VALUES(${destination}::uuid,'Switch destination',${userId}::uuid)`;
      await getAuthPrisma()
        .$executeRaw`INSERT INTO account_memberships(id,account_id,user_id,role) VALUES(${randomUUID()}::uuid,${destination}::uuid,${userId}::uuid,'owner')`;
      const issued = await login({ email, password, accountId });
      const context = await requireSession(request(issued.accessToken));
      await expect(switchTenant(context, randomUUID())).rejects.toMatchObject({
        status: 403,
      });
      const switched = await switchTenant(context, destination);
      expect(await resolveSession(request(issued.accessToken))).toBeNull();
      expect(
        (await requireSession(request(switched.accessToken))).accountId
      ).toBe(destination);
      const refreshed = await rotateRefreshToken(
        issued.refreshToken,
        request(undefined, issued.csrfToken)
      );
      expect(
        (await requireSession(request(refreshed.accessToken))).accountId
      ).toBe(destination);
    }, 30000);
    it('limits privileged production sessions to MFA enrollment until the factor is verified', async () => {
      const issued = await login({ email, password, accountId });
      vi.stubEnv('NODE_ENV', 'production');
      try {
        const incoming = request(issued.accessToken);
        expect(await resolveSession(incoming)).toBeNull();
        expect(await resolveEnrollmentSession(incoming)).not.toBeNull();
        const response = await handleAuthGet(incoming, 'session');
        expect((await response.json()).session.mfaRequired).toBe(true);
      } finally {
        vi.unstubAllEnvs();
      }
    }, 30000);
    it('keeps the current email until a reauthenticated new-address proof and revokes all sessions on confirmation', async () => {
      const identity = await additionalIdentity(),
        newEmail = `${randomUUID()}@example.invalid`;
      const issued = await login({ email: identity.email, password });
      const context = await requireSession(request(issued.accessToken));
      await expect(
        requestEmailChange(context, newEmail, 'wrong-current-password')
      ).rejects.toThrow();
      await requestEmailChange(context, newEmail, password);
      const before = await getAuthPrisma().$queryRaw<
        { email: string }[]
      >`SELECT email FROM auth_users WHERE id=${identity.id}::uuid`;
      expect(before[0].email).toBe(identity.email);
      const token = emailedChangeToken(newEmail);
      await confirmEmailChange(token);
      const updated = await getAuthPrisma().$queryRaw<
        { email: string }[]
      >`SELECT email FROM auth_users WHERE id=${identity.id}::uuid UNION ALL SELECT email FROM profiles WHERE user_id=${identity.id}::uuid`;
      expect(updated.map((row) => row.email)).toEqual([newEmail, newEmail]);
      expect(await resolveSession(request(issued.accessToken))).toBeNull();
      await expect(confirmEmailChange(token)).rejects.toThrow();
      const loggedIn = await login({ email: newEmail, password });
      expect(
        await resolveSession(request(loggedIn.accessToken))
      ).not.toBeNull();
    }, 30000);
    it('cancels previously authorized pending email changes when the password changes', async () => {
      const identity = await additionalIdentity(),
        newEmail = `${randomUUID()}@example.invalid`;
      const issued = await login({ email: identity.email, password });
      const context = await requireSession(request(issued.accessToken));
      await requestEmailChange(context, newEmail, password);
      const token = emailedChangeToken(newEmail);
      await updatePassword(context, 'Changed-test-password-42', password);
      await expect(confirmEmailChange(token)).rejects.toThrow();
      const users = await getAuthPrisma().$queryRaw<
        { email: string }[]
      >`SELECT email FROM auth_users WHERE id=${identity.id}::uuid`;
      expect(users[0].email).toBe(identity.email);
    }, 30000);
    it('enrolls TOTP, revokes older sessions, and consumes recovery codes once', async () => {
      const existing = await login({ email, password }),
        current = await login({ email, password });
      const context = await requireSession(request(current.accessToken));
      const enrollment = await enrollMfa(context, password);
      const codes = await verifyMfaEnrollment(
        context,
        await generate({ secret: enrollment.secret })
      );
      expect(codes).toHaveLength(10);
      expect(await resolveSession(request(existing.accessToken))).toBeNull();
      expect(await resolveSession(request(current.accessToken))).not.toBeNull();
      await expect(login({ email, password })).rejects.toMatchObject({
        code: 'mfa_required',
      });
      const withRecovery = await login({ email, password, mfaCode: codes[0] });
      expect(
        await resolveSession(request(withRecovery.accessToken))
      ).not.toBeNull();
      await expect(
        login({ email, password, mfaCode: codes[0] })
      ).rejects.toMatchObject({ code: 'mfa_invalid' });
    }, 30000);
  }
);
