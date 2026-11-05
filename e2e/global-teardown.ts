import fs from 'node:fs';
import { FIXTURES_FILE, fixtures } from './fixtures';
import { testDatabase } from './global-setup';

/** Removes this run's workspaces (cascading their data) and users. */
export default async function globalTeardown() {
  await new Promise<void>((resolve) => {
    const smtp = (globalThis as { e2eSmtp?: import('node:net').Server }).e2eSmtp;
    if (!smtp) return resolve();
    smtp.close(() => resolve());
    // An idle client connection must not hold the run open.
    setTimeout(resolve, 2_000).unref();
  });
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
