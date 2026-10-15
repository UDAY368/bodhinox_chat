import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAuthPrisma, disconnectDatabases } from '@/lib/db/prisma';
import { signAccessToken } from '@/lib/auth/jwt';
import { resolveSession } from '@/lib/auth/session';
import { executeRpc } from './rpc';
import { peekInvitation } from './memberships';
import type { TenantContext } from '@/lib/data/types';
config({ path: '.env.test', quiet: true });
const authDatabase = process.env.TEST_AUTH_DATABASE_URL;
let fixturesCreated = false;
const users = [randomUUID(), randomUUID(), randomUUID()],
  accounts = [randomUUID(), randomUUID(), randomUUID()];
const owner: TenantContext = {
  accountId: accounts[0],
  userId: users[0],
  role: 'owner',
};
const guest: TenantContext = {
  accountId: accounts[1],
  userId: users[1],
  role: 'owner',
};
const target: TenantContext = {
  accountId: accounts[0],
  userId: users[2],
  role: 'owner',
};
const tokenHash = randomUUID().replaceAll('-', '').repeat(2);
async function session(
  userId: string,
  accountId: string
): Promise<{ id: string; token: string }> {
  const id = randomUUID();
  await getAuthPrisma().$executeRawUnsafe(
    "INSERT INTO auth_sessions(id,user_id,account_id,csrf_hash,expires_at) VALUES($1::uuid,$2::uuid,$3::uuid,'test-only-csrf',NOW()+interval '1 hour')",
    id,
    userId,
    accountId
  );
  return {
    id,
    token: await signAccessToken({ userId, accountId, sessionId: id }),
  };
}
const bearer = (token: string) =>
  new Request('https://membership.integration.test/api/account', {
    headers: { authorization: `Bearer ${token}` },
  });
describe.skipIf(!authDatabase)(
  'organization membership authority in PostgreSQL',
  () => {
    beforeAll(async () => {
      process.env.AUTH_DATABASE_URL = authDatabase;
      const db = await getAuthPrisma().$queryRawUnsafe<
        { name: string; role: string }[]
      >('SELECT current_database() AS name,current_user AS role');
      if (!/test/i.test(db[0].name) || db[0].role !== 'bodhinox_auth')
        throw new Error(
          'Requires isolated database and constrained authentication role'
        );
      const key = await generateKeyPair('RS256', { extractable: true });
      process.env.AUTH_JWT_PRIVATE_KEY = await exportPKCS8(key.privateKey);
      process.env.AUTH_JWT_PUBLIC_KEY = await exportSPKI(key.publicKey);
      process.env.AUTH_JWT_KID = 'membership-test';
      process.env.AUTH_JWT_ISSUER = 'https://membership.integration.test';
      process.env.AUTH_JWT_AUDIENCE = 'membership-test';
      await getAuthPrisma().$transaction(async (tx) => {
        for (let i = 0; i < users.length; i++) {
          await tx.$executeRawUnsafe(
            "INSERT INTO auth_users(id,email,full_name,password_hash,email_verified_at) VALUES($1::uuid,$2,'Membership integration','test-only-hash',NOW())",
            users[i],
            `${users[i]}@example.invalid`
          );
          await tx.$executeRawUnsafe(
            "INSERT INTO accounts(id,name,owner_user_id) VALUES($1::uuid,'Membership integration',$2::uuid)",
            accounts[i],
            users[i]
          );
          await tx.$executeRawUnsafe(
            "INSERT INTO account_memberships(account_id,user_id,role) VALUES($1::uuid,$2::uuid,'owner')",
            accounts[i],
            users[i]
          );
          await tx.$executeRawUnsafe(
            "INSERT INTO profiles(user_id,email,full_name,account_id,account_role) VALUES($1::uuid,$2,'Membership integration',$3::uuid,'owner')",
            users[i],
            `${users[i]}@example.invalid`,
            accounts[i]
          );
        }
        await tx.$executeRawUnsafe(
          "INSERT INTO account_invitations(account_id,token_hash,role,created_by_user_id,expires_at) VALUES($1::uuid,$2,'viewer',$3::uuid,NOW()+interval '1 hour')",
          accounts[0],
          tokenHash,
          users[0]
        );
      });
      fixturesCreated = true;
    }, 30000);
    afterAll(async () => {
      if (fixturesCreated) {
        for (const account of accounts)
          await getAuthPrisma().$executeRawUnsafe(
            'DELETE FROM accounts WHERE id=$1::uuid',
            account
          );
        for (const user of users)
          await getAuthPrisma().$executeRawUnsafe(
            'DELETE FROM auth_users WHERE id=$1::uuid',
            user
          );
      }
      await disconnectDatabases();
    }, 30000);
    it('redeems an invite once while preserving the existing organization', async () => {
      expect(await peekInvitation(tokenHash)).toMatchObject({
        ok: true,
        role: 'viewer',
      });
      const redeemed = await executeRpc(
        'redeem_invitation',
        { p_token_hash: tokenHash },
        guest
      );
      expect(redeemed).toMatchObject({ data: accounts[0], error: null });
      const memberships = await getAuthPrisma().$queryRawUnsafe<
        { account_id: string; role: string }[]
      >(
        'SELECT account_id,role FROM account_memberships WHERE user_id=$1::uuid ORDER BY role',
        users[1]
      );
      expect(memberships).toEqual(
        expect.arrayContaining([
          { account_id: accounts[0], role: 'viewer' },
          { account_id: accounts[1], role: 'owner' },
        ])
      );
      expect(
        (
          await executeRpc(
            'redeem_invitation',
            { p_token_hash: tokenHash },
            guest
          )
        ).error?.code
      ).toBe('22023');
      expect(await peekInvitation(tokenHash)).toMatchObject({
        ok: false,
        reason: 'used',
      });
    }, 30000);
    it('uses live membership authority and revokes tokens after a role change', async () => {
      const existing = await session(users[1], accounts[0]);
      expect((await resolveSession(bearer(existing.token)))?.role).toBe(
        'viewer'
      );
      const spoofed = await executeRpc(
        'set_member_role',
        { p_user_id: users[0], p_new_role: 'admin' },
        { ...owner, userId: users[1], role: 'owner' }
      );
      expect(spoofed.error?.code).toBe('42501');
      expect(
        (
          await executeRpc(
            'set_member_role',
            { p_user_id: users[1], p_new_role: 'agent' },
            owner
          )
        ).error
      ).toBeNull();
      expect(await resolveSession(bearer(existing.token))).toBeNull();
      const changed = await getAuthPrisma().$queryRawUnsafe<{ role: string }[]>(
        'SELECT role FROM account_memberships WHERE account_id=$1::uuid AND user_id=$2::uuid',
        accounts[0],
        users[1]
      );
      expect(changed[0].role).toBe('agent');
      const escalation = await executeRpc(
        'set_member_role',
        { p_user_id: users[1], p_new_role: 'owner' },
        owner
      );
      expect(escalation.error?.code).toBe('22023');
    }, 30000);
    it('protects the owner and removes only the selected organization membership', async () => {
      expect(
        (
          await executeRpc(
            'remove_account_member',
            { p_user_id: users[0] },
            owner
          )
        ).error?.code
      ).toBe('22023');
      const active = await session(users[1], accounts[0]);
      expect(
        (
          await executeRpc(
            'remove_account_member',
            { p_user_id: users[1] },
            owner
          )
        ).error
      ).toBeNull();
      expect(await resolveSession(bearer(active.token))).toBeNull();
      const memberships = await getAuthPrisma().$queryRawUnsafe<
        { account_id: string }[]
      >(
        'SELECT account_id FROM account_memberships WHERE user_id=$1::uuid',
        users[1]
      );
      expect(memberships).toEqual([{ account_id: accounts[1] }]);
    }, 30000);
    it('requires owner authority and transfers ownership atomically', async () => {
      expect(
        (
          await executeRpc(
            'transfer_account_ownership',
            { p_new_owner_user_id: users[2] },
            owner
          )
        ).error?.code
      ).toBe('22023');
      await getAuthPrisma().$executeRawUnsafe(
        "INSERT INTO account_memberships(account_id,user_id,role) VALUES($1::uuid,$2::uuid,'admin')",
        accounts[0],
        users[2]
      );
      expect(
        (
          await executeRpc(
            'transfer_account_ownership',
            { p_new_owner_user_id: users[0] },
            target
          )
        ).error?.code
      ).toBe('42501');
      const old = await session(users[0], accounts[0]),
        next = await session(users[2], accounts[0]);
      expect(
        (
          await executeRpc(
            'transfer_account_ownership',
            { p_new_owner_user_id: users[2] },
            owner
          )
        ).error
      ).toBeNull();
      const memberships = await getAuthPrisma().$queryRawUnsafe<
        { user_id: string; role: string }[]
      >(
        'SELECT user_id,role FROM account_memberships WHERE account_id=$1::uuid',
        accounts[0]
      );
      expect(memberships.filter((m) => m.role === 'owner')).toEqual([
        { user_id: users[2], role: 'owner' },
      ]);
      expect(memberships).toContainEqual({ user_id: users[0], role: 'admin' });
      const account = await getAuthPrisma().$queryRawUnsafe<
        { owner_user_id: string }[]
      >('SELECT owner_user_id FROM accounts WHERE id=$1::uuid', accounts[0]);
      expect(account[0].owner_user_id).toBe(users[2]);
      expect(await resolveSession(bearer(old.token))).toBeNull();
      expect(await resolveSession(bearer(next.token))).toBeNull();
    }, 30000);
  }
);
