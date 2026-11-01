import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hash, argon2id } from 'argon2';
import { config } from 'dotenv';
import pg from 'pg';
import { FIXTURES_FILE, type Fixtures, type Role, type SeededUser } from './fixtures';

/** Owner connection to the isolated test database; refuses anything else. */
export async function testDatabase(): Promise<pg.Client> {
  config({ path: '.env.test', quiet: true });
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is required for end-to-end tests');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const { rows } = await client.query('SELECT current_database() AS name');
  if (!/test/i.test(rows[0].name)) {
    await client.end();
    throw new Error('End-to-end tests require an isolated test database');
  }
  return client;
}

export default async function globalSetup() {
  const db = await testDatabase();
  const runId = randomBytes(4).toString('hex');
  const newUser = (label: string): SeededUser => ({
    id: randomUUID(),
    email: `e2e-${runId}-${label}@example.invalid`,
    // Meets the password policy: upper, lower, digit, symbol, length.
    password: `Aa1!${randomBytes(12).toString('base64url')}`,
  });
  const roles: Role[] = ['owner', 'admin', 'agent', 'viewer'];
  const users = Object.fromEntries(roles.map((role) => [role, newUser(role)])) as Record<Role, SeededUser>;
  const outsider = newUser('outsider');
  const accountA = randomUUID(), accountB = randomUUID();
  const members: [string, SeededUser, Role][] = [
    ...roles.map((role) => [accountA, users[role], role] as [string, SeededUser, Role]),
    [accountB, outsider, 'owner'],
  ];

  try {
    await db.query('BEGIN');
    await db.query('SET LOCAL ROLE bodhinox_auth');
    for (const [, user] of members) {
      const passwordHash = await hash(user.password, { type: argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
      await db.query(
        'INSERT INTO auth_users(id,email,full_name,password_hash,email_verified_at) VALUES($1,$2,$3,$4,NOW())',
        [user.id, user.email, `E2E ${user.email.split('@')[0]}`, passwordHash],
      );
    }
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,$2,$3),($4,$5,$6)",
      [accountA, `E2E workspace ${runId}`, users.owner.id, accountB, `E2E other ${runId}`, outsider.id]);
    for (const [account, user, role] of members) {
      await db.query('INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,$3)', [account, user.id, role]);
      await db.query('INSERT INTO profiles(user_id,full_name,email,account_id,account_role) VALUES($1,$2,$3,$4,$5)',
        [user.id, `E2E ${role}`, user.email, account, role]);
    }
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    await db.end();
  }

  const data: Fixtures = { runId, accountA, accountB, users, outsider };
  fs.mkdirSync(path.dirname(FIXTURES_FILE), { recursive: true });
  fs.writeFileSync(FIXTURES_FILE, JSON.stringify(data, null, 2));
}
