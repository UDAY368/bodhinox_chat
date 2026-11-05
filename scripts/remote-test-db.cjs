// Runs vitest with ALLOW_REMOTE_TEST_DB=1, the only way past the local-only test database guard
// (src/lib/db/test-db-guard.ts). Used by npm run test:db / test:all, the documented commands for the
// remote test database in .env.test. Everything else (test:all:local, CI) stays local-only.
//   node scripts/remote-test-db.cjs <vitest arguments...>
const { spawnSync } = require('node:child_process');

// Only .env.test may supply database URLs on this path: drop every *DATABASE_URL* variable the shell
// carries (an exported production DATABASE_URL, `railway run`, a stray TEST_*_DATABASE_URL), the way
// scripts/test-db-local.cjs isolatedEnv does, before the guard is relaxed.
function remoteEnv(source) {
  const env = { ...source };
  for (const key of Object.keys(env)) if (key.toUpperCase().includes('DATABASE_URL')) delete env[key];
  return { ...env, ALLOW_REMOTE_TEST_DB: '1' };
}

module.exports = { remoteEnv };

if (require.main === module) {
  const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', ...process.argv.slice(2)], {
    env: remoteEnv(process.env),
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}
