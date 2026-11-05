// Test-run database guard: under vitest, every database connection must go to a local
// PostgreSQL (127.0.0.1 / localhost / ::1) unless ALLOW_REMOTE_TEST_DB=1 is set, which only the
// documented remote-test-database scripts (npm run test:db / test:all) do. It stops a test file
// that loads .env.test (or a stray shell variable) from reaching a remote or production database.
// Messages name the variable only, never the URL, host or credentials.

export type Env = Record<string, string | undefined>;

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function remoteTestDatabaseAllowed(env: Env = process.env): boolean {
  return env.ALLOW_REMOTE_TEST_DB === "1";
}

/** True while running under vitest (or any NODE_ENV=test process). */
export function testDatabaseGuardActive(env: Env = process.env): boolean {
  return env.VITEST === "true" || env.NODE_ENV === "test";
}

export function isLocalDatabaseHost(host: string | undefined | null): boolean {
  if (!host) return false;
  return LOCAL_HOSTS.has(host.trim().toLowerCase());
}

/** Host of a PostgreSQL URL, or null when the value is not a URL. */
export function databaseUrlHost(value: string): string | null {
  try {
    const url = new URL(value);
    // An empty host in a postgres URL means libpq's default, which pg resolves to localhost.
    return url.hostname || "localhost";
  } catch {
    return null;
  }
}

export class RemoteTestDatabaseError extends Error {
  constructor(name: string) {
    super(`${name} points at a non-local database during a test run. Tests only use the local Docker database `
      + `(node scripts/test-db-local.cjs run). Set ALLOW_REMOTE_TEST_DB=1 only through npm run test:db / test:all.`);
    this.name = "RemoteTestDatabaseError";
  }
}

/** Throws unless value is empty or a URL whose host is local (or remote use is explicitly allowed). */
export function assertLocalTestDatabaseUrl(name: string, value: string | undefined, env: Env = process.env): void {
  if (!value?.trim() || remoteTestDatabaseAllowed(env)) return;
  const host = databaseUrlHost(value.trim());
  // A non-URL value cannot be connected to by pg/Prisma as a URL; prisma.ts rejects it separately.
  if (host === null) return;
  if (!isLocalDatabaseHost(host)) throw new RemoteTestDatabaseError(name);
}

/** Checks every variable whose name contains DATABASE_URL. */
export function assertLocalTestDatabaseEnv(env: Env = process.env): void {
  if (remoteTestDatabaseAllowed(env)) return;
  for (const [name, value] of Object.entries(env)) {
    if (name.includes("DATABASE_URL")) assertLocalTestDatabaseUrl(name, value, env);
  }
}

/** Throws for a non-local connection host (used where pg opens a socket). */
export function assertLocalTestDatabaseHost(host: string | undefined, env: Env = process.env): void {
  if (remoteTestDatabaseAllowed(env)) return;
  // Unix-socket paths are local by definition.
  if (host?.startsWith("/")) return;
  if (!isLocalDatabaseHost(host ?? "localhost")) throw new RemoteTestDatabaseError("database connection host");
}
