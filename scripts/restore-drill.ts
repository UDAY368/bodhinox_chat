// Restore drill (Phase 15): proves a database dump restores into a working Bodhinox database.
// Local Docker only: it starts its own container (bodhinox-restore-drill, 127.0.0.1 only), never
// reads .env.local or .env.test, and refuses any non-local connection. The dump file is the owner's
// (staging preferred; a production dump holds customer data, stays outside the repo and is deleted
// after). The report holds timings and row counts only. See docs/runbooks/backup-restore.md.
//
//   npx tsx scripts/restore-drill.ts --dump <file> [--port 55433] [--out <report.json>]
//   npx tsx scripts/restore-drill.ts --cleanup
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import {
  archiveCreatedAt, assertLocalDrillUrl, defaultReportPath, DRILL_CONTAINER, DRILL_COUNT_TABLES, DRILL_DATABASE,
  DRILL_IMAGE, DRILL_ROLES, drillResult, drillUrl, dumpFormat, parseRestoreDrillArgs, RESTORE_DRILL_USAGE,
  RestoreDrillArgsError, type RestoreDrillReport,
} from '../src/lib/ops/restore-drill-args';

// Every connection variable any tool reads (as scripts/test-db-local.cjs#isolatedEnv).
const DB_KEYS = ['MIGRATION_DATABASE_URL', 'DATABASE_URL', 'AUTH_DATABASE_URL', 'WORKER_DATABASE_URL', 'PLATFORM_DATABASE_URL',
  'TEST_DATABASE_URL', 'TEST_APP_DATABASE_URL', 'TEST_AUTH_DATABASE_URL', 'TEST_WORKER_DATABASE_URL', 'TEST_PLATFORM_DATABASE_URL'];
// A file that does not exist: prisma.config.ts and the role bootstrap then load no env file at all.
const NO_ENV_FILE = 'restore-drill/.env.none';

const seconds = (start: number) => Math.round((performance.now() - start) / 10) / 100;
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const containerExists = () => spawnSync('docker', ['inspect', DRILL_CONTAINER], { stdio: 'ignore' }).status === 0;
const secret = () => randomBytes(32).toString('hex');

function psql(sql: string): string {
  return docker('exec', DRILL_CONTAINER, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', DRILL_DATABASE, '-tAc', sql);
}

function isolatedEnv(values: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of DB_KEYS) delete env[key];
  for (const [key, value] of Object.entries(values)) assertLocalDrillUrl(key, value);
  return { ...env, ...values, DATABASE_ENV_FILE: NO_ENV_FILE };
}

function node(args: string[], env: NodeJS.ProcessEnv): number {
  // Output is discarded: tool errors can include connection strings.
  return spawnSync(process.execPath, args, { env, stdio: 'ignore' }).status ?? 1;
}

async function main() {
  const args = parseRestoreDrillArgs(process.argv.slice(2));
  if (args.cleanup) {
    spawnSync('docker', ['rm', '-f', DRILL_CONTAINER], { stdio: 'ignore' });
    console.log(`Removed ${DRILL_CONTAINER} (if it existed).`);
    return;
  }
  const dumpPath = path.resolve(args.dump!);
  if (!fs.statSync(dumpPath, { throwIfNoEntry: false })?.isFile()) throw new RestoreDrillArgsError('The dump file does not exist');
  if (containerExists()) throw new RestoreDrillArgsError(`${DRILL_CONTAINER} already exists; run with --cleanup first`);
  const fd = fs.openSync(dumpPath, 'r');
  const head = Buffer.alloc(5);
  fs.readSync(fd, head, 0, 5, 0);
  fs.closeSync(fd);
  const format = dumpFormat(head);
  const sizeBytes = fs.statSync(dumpPath).size;

  const total = performance.now();
  const ownerPassword = secret();
  const values: Record<string, string> = {
    MIGRATION_DATABASE_URL: drillUrl('postgres', ownerPassword, args.port),
    DATABASE_URL: drillUrl('bodhinox_app', secret(), args.port),
    AUTH_DATABASE_URL: drillUrl('bodhinox_auth', secret(), args.port),
    WORKER_DATABASE_URL: drillUrl('bodhinox_worker', secret(), args.port),
    PLATFORM_DATABASE_URL: drillUrl('bodhinox_platform', secret(), args.port),
  };
  const env = isolatedEnv(values);

  console.log('1/7 starting the local drill container');
  let step = performance.now();
  spawnSync('docker', ['pull', '-q', DRILL_IMAGE], { stdio: 'ignore' });
  docker('run', '-d', '--name', DRILL_CONTAINER, '-e', `POSTGRES_PASSWORD=${ownerPassword}`, '-e', `POSTGRES_DB=${DRILL_DATABASE}`,
    '-p', `127.0.0.1:${args.port}:5432`, DRILL_IMAGE);
  for (let i = 0; ; i++) {
    // pg_isready over TCP: the image's init phase only listens on the socket.
    if (spawnSync('docker', ['exec', DRILL_CONTAINER, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', DRILL_DATABASE]).status === 0) break;
    if (i > 90) throw new Error('The drill database did not start');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const containerS = seconds(step);
  const postgres = psql('SHOW server_version') || null;

  console.log('2/7 creating the NOLOGIN application roles');
  for (const role of DRILL_ROLES) {
    psql(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN
      CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS; END IF; END $$`);
  }

  console.log(`3/7 restoring the ${format}-format dump`);
  step = performance.now();
  docker('cp', dumpPath, `${DRILL_CONTAINER}:/tmp/drill.dump`);
  let createdAt: string | null = null;
  if (format === 'custom') {
    const listing = spawnSync('docker', ['exec', DRILL_CONTAINER, 'pg_restore', '--list', '/tmp/drill.dump'], { encoding: 'utf8' });
    createdAt = archiveCreatedAt(listing.stdout ?? '');
  }
  const restore = format === 'custom'
    ? spawnSync('docker', ['exec', DRILL_CONTAINER, 'pg_restore', '--no-owner', '-U', 'postgres', '-d', DRILL_DATABASE, '/tmp/drill.dump'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    : spawnSync('docker', ['exec', DRILL_CONTAINER, 'psql', '-q', '-U', 'postgres', '-d', DRILL_DATABASE, '-f', '/tmp/drill.dump'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const restoreS = seconds(step);
  // Count error lines only; their text can quote dump content and is never printed or stored.
  const errorLines = (restore.stderr ?? '').split(/\r?\n/).filter((line) => /error/i.test(line)).length;
  spawnSync('docker', ['exec', DRILL_CONTAINER, 'rm', '-f', '/tmp/drill.dump'], { stdio: 'ignore' });

  console.log('4/7 applying role logins (db:roles)');
  step = performance.now();
  const rolesStatus = node(['node_modules/tsx/dist/cli.mjs', 'scripts/db-bootstrap-roles.ts'], env);
  const rolesS = seconds(step);
  if (rolesStatus !== 0) console.log('    role bootstrap failed');

  console.log('5/7 prisma migrate status and preflight');
  const migrate = node(['node_modules/prisma/build/index.js', 'migrate', 'status'], env);
  const preflight = node(['node_modules/tsx/dist/cli.mjs', 'scripts/db-preflight.ts'], env);

  console.log('6/7 counting rows');
  const owner = new pg.Client({ connectionString: values.MIGRATION_DATABASE_URL });
  await owner.connect();
  const counts: Record<string, number | null> = {};
  let accountId: string | null = null;
  try {
    for (const table of DRILL_COUNT_TABLES) {
      try { counts[table] = Number((await owner.query(`SELECT count(*)::bigint AS n FROM "${table}"`)).rows[0].n); }
      catch { counts[table] = null; }
    }
    if (counts.accounts) accountId = (await owner.query('SELECT id FROM accounts ORDER BY created_at LIMIT 1')).rows[0]?.id ?? null;
  } finally { await owner.end(); }

  console.log('7/7 one tenant-scoped read as the application role (withTenant)');
  let tenantRead: RestoreDrillReport['tenantRead'] = 'no-accounts';
  if (accountId) {
    Object.assign(process.env, env);
    try {
      const { withTenant } = await import('../src/lib/db/tenant');
      const { disconnectDatabases } = await import('../src/lib/db/prisma');
      try {
        await withTenant({ accountId }, (tx) => tx.$queryRaw`SELECT count(*) FROM contacts`);
        tenantRead = 'pass';
      } finally { await disconnectDatabases(); }
    } catch { tenantRead = 'fail'; }
  }

  const ranAt = new Date();
  const partial: Omit<RestoreDrillReport, 'result'> = {
    drill: 'restore',
    ranAt: ranAt.toISOString(),
    environment: { target: 'local-docker', image: DRILL_IMAGE, postgres },
    dump: { file: path.basename(dumpPath), format, sizeBytes, createdAt,
      ageHours: createdAt ? Math.round((ranAt.getTime() - Date.parse(createdAt)) / 360_000) / 10 : null },
    timings: { containerS, restoreS, rolesS, totalS: seconds(total) },
    restore: { exitCode: restore.status ?? 1, errorLines },
    migrateStatus: migrate === 0 ? 'up-to-date' : migrate === 1 ? 'behind-or-diverged' : 'error',
    preflight: preflight === 0 ? 'pass' : 'fail',
    counts,
    tenantRead: rolesStatus === 0 ? tenantRead : 'fail',
  };
  const report: RestoreDrillReport = { ...partial, result: drillResult(partial) };
  const out = path.resolve(args.out ?? defaultReportPath(ranAt));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(`Drill ${report.result}: restore ${restoreS}s, total ${report.timings.totalS}s. Report: ${path.relative(process.cwd(), out)}`);
  console.log(`The container ${DRILL_CONTAINER} is kept for inspection; remove it with --cleanup.`);
  if (report.result !== 'pass') process.exitCode = 1;
}

main().catch((error: unknown) => {
  // Docker, pg and tool errors can carry connection strings: print only our own messages.
  if (error instanceof RestoreDrillArgsError) console.error(`${error.message}\n${RESTORE_DRILL_USAGE}`);
  else if (error instanceof Error && /^(The drill database|.* must point at the local)/.test(error.message)) console.error(error.message);
  else console.error('Restore drill failed. Check Docker is running and the dump file is a pg_dump archive or SQL file.');
  process.exitCode = 1;
});
