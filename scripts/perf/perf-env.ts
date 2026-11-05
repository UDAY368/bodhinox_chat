// Database environment for the pilot-volume performance scripts (scripts/perf/seed.ts, measure.ts).
// Local Docker only: the URLs come from .env.test.docker (written by scripts/test-db-local.cjs setup),
// pointed at a separate database `bodhinox_perf` on the same container. Every *DATABASE_URL* the shell
// carries is dropped first (like test-db-local.cjs isolatedEnv), and any non-loopback host, other port
// or other database name is refused, so these scripts can never reach a shared or production database.
import fs from 'node:fs';
import path from 'node:path';

export const PERF_DATABASE = 'bodhinox_perf';
const ENV_FILE = '.env.test.docker';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const PORT = '55432';
/** The keys the app and tooling read for connections; all of them are set, nothing is inherited. */
const KEYS = ['MIGRATION_DATABASE_URL', 'DATABASE_URL', 'AUTH_DATABASE_URL', 'WORKER_DATABASE_URL', 'PLATFORM_DATABASE_URL'] as const;
export type PerfKey = (typeof KEYS)[number];

export class PerfEnvError extends Error {
  constructor(message: string) { super(message); this.name = 'PerfEnvError'; }
}

/** Throws unless `value` is a loopback PostgreSQL URL on the Docker test port and the perf database. */
export function assertLocalPerfUrl(key: string, value: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new PerfEnvError(`${key} is not a URL`); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new PerfEnvError(`${key} must be PostgreSQL`);
  // Name the variable only: never the URL, host or password.
  if (!LOCAL_HOSTS.has(url.hostname.toLowerCase())) throw new PerfEnvError(`${key} must point at the local Docker database (loopback host)`);
  if (url.port !== PORT) throw new PerfEnvError(`${key} must use the local Docker port ${PORT}`);
  if (url.pathname !== `/${PERF_DATABASE}`) throw new PerfEnvError(`${key} must name the ${PERF_DATABASE} database`);
}

/** Parses .env.test.docker (KEY=JSON-string lines). */
export function readDockerEnv(root: string): Record<string, string> {
  const file = path.join(root, ENV_FILE);
  if (!fs.existsSync(file)) throw new PerfEnvError(`${ENV_FILE} is missing: run node scripts/test-db-local.cjs setup first`);
  return Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
    const i = line.indexOf('=');
    return [line.slice(0, i), JSON.parse(line.slice(i + 1)) as string];
  }));
}

/** The Docker URLs rewritten to the perf database, each checked local. */
export function perfDatabaseUrls(docker: Record<string, string>): Record<PerfKey, string> {
  const out = {} as Record<PerfKey, string>;
  for (const key of KEYS) {
    const value = docker[key];
    if (!value) throw new PerfEnvError(`${key} is missing from ${ENV_FILE}`);
    const url = new URL(value);
    url.pathname = `/${PERF_DATABASE}`;
    out[key] = url.toString();
    assertLocalPerfUrl(key, out[key]);
  }
  return out;
}

/**
 * `source` with every database variable removed and the perf URLs set, plus dummy test secrets
 * (the same values vitest uses) so nothing reads a real key. Synthetic data only.
 */
export function isolatedPerfEnv(source: Record<string, string | undefined>, urls: Record<PerfKey, string>): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = { ...source };
  for (const key of Object.keys(env)) if (key.toUpperCase().includes('DATABASE_URL')) delete env[key];
  delete env.ALLOW_REMOTE_TEST_DB;
  return {
    ...env, ...urls,
    // A path that does not exist, so no module's dotenv call loads another environment file.
    DATABASE_ENV_FILE: '.env.perf.none',
    NODE_ENV: 'development',
    ENCRYPTION_KEY: '0000000000000000000000000000000000000000000000000000000000000000',
    META_APP_SECRET: 'test-meta-app-secret',
    DB_POOL_SIZE: '4',
  };
}

/** Replaces this process's database environment in place (before any app module is imported). */
export function applyPerfEnv(root: string): Record<PerfKey, string> {
  const urls = perfDatabaseUrls(readDockerEnv(root));
  const env = isolatedPerfEnv(process.env, urls);
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  return urls;
}
