import fs from 'node:fs';
import { FIXTURES_FILE, fixtures } from './fixtures';
import { testDatabase } from './global-setup';

/** Removes this run's workspaces (cascading their data) and users. */
export default async function globalTeardown() {
  if (!fs.existsSync(FIXTURES_FILE)) return;
  const data = fixtures();
  const db = await testDatabase();
  try {
    await db.query('DELETE FROM jobs WHERE tenant_id = ANY($1::uuid[])', [[data.accountA, data.accountB]]);
    await db.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[data.accountA, data.accountB]]);
    const ids = [...Object.values(data.users), data.outsider].map((u) => u.id);
    await db.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [ids]);
  } finally {
    await db.end();
  }
  fs.rmSync(FIXTURES_FILE);
}
