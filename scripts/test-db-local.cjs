// A disposable local PostgreSQL for the real-database tests, built like CI's
// (pgvector/pgvector:pg18 in Docker, migrations, constrained role logins).
// Credentials are generated once into .env.test.docker (git-ignored); the
// shared .env.test and any remote test database are never touched.
//
//   node scripts/test-db-local.cjs setup   start the container, migrate, set role logins (app, auth, worker, platform)
//   node scripts/test-db-local.cjs run     setup, then run the database tests against it
//   node scripts/test-db-local.cjs stop    stop the container (data is thrown away)

const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');

const CONTAINER = 'bodhinox-test-db';
const PORT = 55432;
const DATABASE = 'bodhinox_test';
const ENV_FILE = '.env.test.docker';
// Every variable the database tooling or the tests read for connections.
const DB_KEYS = ['MIGRATION_DATABASE_URL', 'DATABASE_URL', 'AUTH_DATABASE_URL', 'WORKER_DATABASE_URL', 'PLATFORM_DATABASE_URL',
  'TEST_DATABASE_URL', 'TEST_APP_DATABASE_URL', 'TEST_AUTH_DATABASE_URL', 'TEST_WORKER_DATABASE_URL', 'TEST_PLATFORM_DATABASE_URL'];

const secret = () => crypto.randomBytes(32).toString('hex');
const url = (role, password) => `postgresql://${role}:${password}@127.0.0.1:${PORT}/${DATABASE}?sslmode=disable`;
const write = (values) => fs.writeFileSync(ENV_FILE, Object.entries(values).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('\n') + '\n');

function credentials() {
  if (fs.existsSync(ENV_FILE)) {
    const values = Object.fromEntries(fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/).filter(Boolean)
      .map((line) => { const i = line.indexOf('='); return [line.slice(0, i), JSON.parse(line.slice(i + 1))]; }));
    // A file written before the platform console role (Phase 14): add its login once.
    if (!values.PLATFORM_DATABASE_URL) {
      values.PLATFORM_DATABASE_URL = url('bodhinox_platform', secret());
      values.TEST_PLATFORM_DATABASE_URL = values.PLATFORM_DATABASE_URL;
      write(values);
    }
    return values;
  }
  const owner = url('postgres', secret());
  const values = {
    MIGRATION_DATABASE_URL: owner,
    DATABASE_URL: url('bodhinox_app', secret()),
    AUTH_DATABASE_URL: url('bodhinox_auth', secret()),
    WORKER_DATABASE_URL: url('bodhinox_worker', secret()),
    // Platform console role (Phase 14): EXECUTE on crm_platform_* functions only.
    PLATFORM_DATABASE_URL: url('bodhinox_platform', secret()),
  };
  Object.assign(values, { TEST_DATABASE_URL: owner, TEST_APP_DATABASE_URL: values.DATABASE_URL,
    TEST_AUTH_DATABASE_URL: values.AUTH_DATABASE_URL, TEST_WORKER_DATABASE_URL: values.WORKER_DATABASE_URL,
    TEST_PLATFORM_DATABASE_URL: values.PLATFORM_DATABASE_URL });
  write(values);
  return values;
}

/** The parent environment with every database variable replaced, so nothing can reach another database. */
function isolatedEnv(values) {
  const env = { ...process.env };
  for (const key of DB_KEYS) delete env[key];
  // A value left in the shell must never weaken the local-only test-database guard.
  delete env.ALLOW_REMOTE_TEST_DB;
  return { ...env, ...values, DATABASE_ENV_FILE: ENV_FILE };
}

function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Runs a package CLI with this Node directly: no shell, so arguments are never re-parsed. */
function node(args, env, required = true) {
  const result = spawnSync(process.execPath, args, { env, stdio: 'inherit' });
  if (required && result.status !== 0) throw new Error(`${args.join(' ')} failed`);
  return result.status ?? 1;
}

function setup() {
  const values = credentials();
  const ownerPassword = decodeURIComponent(new URL(values.MIGRATION_DATABASE_URL).password);
  const state = spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', CONTAINER], { encoding: 'utf8' });
  if (state.status !== 0) {
    spawnSync('docker', ['pull', '-q', 'pgvector/pgvector:pg18'], { stdio: 'ignore' });
    docker('run', '-d', '--name', CONTAINER, '-e', `POSTGRES_PASSWORD=${ownerPassword}`, '-e', `POSTGRES_DB=${DATABASE}`,
      '-p', `127.0.0.1:${PORT}:5432`, 'pgvector/pgvector:pg18');
  } else if (state.stdout.trim() !== 'true') {
    docker('start', CONTAINER);
  }
  for (let i = 0; ; i++) {
    if (spawnSync('docker', ['exec', CONTAINER, 'pg_isready', '-U', 'postgres', '-d', DATABASE]).status === 0) break;
    if (i > 60) throw new Error('Local test database did not start');
    execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},1000)']);
  }
  const env = isolatedEnv(values);
  for (const args of [['node_modules/prisma/build/index.js', 'migrate', 'deploy'], ['node_modules/tsx/dist/cli.mjs', 'scripts/db-bootstrap-roles.ts']]) {
    node(args, env);
  }
  return env;
}

const command = process.argv[2] ?? 'setup';
if (command === 'stop') {
  spawnSync('docker', ['rm', '-f', CONTAINER], { stdio: 'inherit' });
  fs.rmSync(ENV_FILE, { force: true });
} else {
  const env = setup();
  if (command === 'run') {
    process.exit(node(['node_modules/vitest/vitest.mjs', 'run', '--maxWorkers=1', 'integration.test', 'load.test', ...process.argv.slice(3)], env, false));
  }
  if (command === 'e2e') {
    // Browser tests against the same local database; extra arguments pick specs. One retry, as in CI:
    // the dev server can full-reload a page while it recompiles just-edited files.
    process.exit(node(['node_modules/@playwright/test/cli.js', 'test', '--retries=1', ...process.argv.slice(3)], env, false));
  }
}
