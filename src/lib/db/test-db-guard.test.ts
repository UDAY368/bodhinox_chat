import { createRequire } from "node:module";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertLocalTestDatabaseEnv,
  assertLocalTestDatabaseHost,
  assertLocalTestDatabaseUrl,
  isLocalDatabaseHost,
  RemoteTestDatabaseError,
  testDatabaseGuardActive,
} from "./test-db-guard";

const REMOTE = "postgresql://bodhinox_app:s3cret-password@db.remote.example.net:5432/bodhinox_test";
const LOCAL = "postgresql://bodhinox_app:pw@127.0.0.1:55432/bodhinox_test?sslmode=disable";

describe("[OPS-03] local-only test database guard", () => {
  it("the remote runner drops every shell *DATABASE_URL* before relaxing the guard (only .env.test supplies them)", () => {
    const { remoteEnv } = createRequire(import.meta.url)("../../../scripts/remote-test-db.cjs") as
      { remoteEnv: (env: Record<string, string>) => Record<string, string> };
    const env = remoteEnv({ DATABASE_URL: REMOTE, TEST_APP_DATABASE_URL: REMOTE, worker_database_url: REMOTE,
      MIGRATION_DATABASE_URL: REMOTE, PATH: "/bin", NODE_ENV: "test" });
    expect(env).toEqual({ PATH: "/bin", NODE_ENV: "test", ALLOW_REMOTE_TEST_DB: "1" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("accepts only loopback hosts", () => {
    for (const host of ["127.0.0.1", "localhost", "LOCALHOST", "::1", "[::1]"]) expect(isLocalDatabaseHost(host)).toBe(true);
    for (const host of ["", "10.0.0.5", "db.remote.example.net", "127.0.0.1.nip.io", "localhost.example.com", undefined])
      expect(isLocalDatabaseHost(host)).toBe(false);
  });

  it("accepts local, empty and IPv6 loopback URLs", () => {
    expect(() => assertLocalTestDatabaseUrl("DATABASE_URL", LOCAL, {})).not.toThrow();
    expect(() => assertLocalTestDatabaseUrl("DATABASE_URL", "postgresql://u:p@localhost/db", {})).not.toThrow();
    expect(() => assertLocalTestDatabaseUrl("DATABASE_URL", "postgresql://u:p@[::1]:5432/db", {})).not.toThrow();
    expect(() => assertLocalTestDatabaseUrl("DATABASE_URL", "", {})).not.toThrow();
    expect(() => assertLocalTestDatabaseUrl("DATABASE_URL", undefined, {})).not.toThrow();
  });

  it("rejects a remote URL without leaking the URL, host or password", () => {
    let error: unknown;
    try { assertLocalTestDatabaseUrl("TEST_DATABASE_URL", REMOTE, {}); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(RemoteTestDatabaseError);
    const message = (error as Error).message;
    expect(message).toContain("TEST_DATABASE_URL");
    expect(message).not.toContain("remote.example");
    expect(message).not.toContain("s3cret");
  });

  it("checks every *DATABASE_URL* variable, including names it has never seen", () => {
    expect(() => assertLocalTestDatabaseEnv({ DATABASE_URL: LOCAL, TEST_WORKER_DATABASE_URL: LOCAL })).not.toThrow();
    expect(() => assertLocalTestDatabaseEnv({ DATABASE_URL: LOCAL, SOME_NEW_DATABASE_URL_X: REMOTE })).toThrow(/SOME_NEW_DATABASE_URL_X/);
    expect(() => assertLocalTestDatabaseEnv({ PLATFORM_DATABASE_URL: REMOTE })).toThrow(RemoteTestDatabaseError);
  });

  it("ALLOW_REMOTE_TEST_DB=1 (npm run test:db / test:all only) lets a remote URL through", () => {
    expect(() => assertLocalTestDatabaseEnv({ DATABASE_URL: REMOTE, ALLOW_REMOTE_TEST_DB: "1" })).not.toThrow();
    expect(() => assertLocalTestDatabaseEnv({ DATABASE_URL: REMOTE, ALLOW_REMOTE_TEST_DB: "true" })).toThrow();
    expect(() => assertLocalTestDatabaseHost("db.remote.example.net", { ALLOW_REMOTE_TEST_DB: "1" })).not.toThrow();
  });

  it("is active under vitest", () => {
    expect(testDatabaseGuardActive()).toBe(true);
    expect(testDatabaseGuardActive({ NODE_ENV: "production" })).toBe(false);
  });

  it("pg refuses to open a socket to a remote host (setup-file patch)", async () => {
    vi.stubEnv("ALLOW_REMOTE_TEST_DB", "");
    // 203.0.113.0/24 is TEST-NET-3: never routable, so even an unpatched client could not reach anything.
    const client = new pg.Client({ connectionString: "postgresql://u:p@203.0.113.10:5432/bodhinox_test", connectionTimeoutMillis: 2000 });
    await expect(client.connect()).rejects.toBeInstanceOf(RemoteTestDatabaseError);
  });

  it("prisma.ts refuses to build a client for a remote URL during tests", async () => {
    vi.stubEnv("ALLOW_REMOTE_TEST_DB", "");
    vi.stubEnv("WORKER_DATABASE_URL", REMOTE);
    const { getWorkerPrisma } = await import("./prisma");
    const state = globalThis as typeof globalThis & { bodhinoxPrisma?: Record<string, unknown> };
    const saved = state.bodhinoxPrisma?.worker;
    if (state.bodhinoxPrisma) delete state.bodhinoxPrisma.worker;
    try {
      expect(() => getWorkerPrisma()).toThrow(/WORKER_DATABASE_URL points at a non-local database/);
    } finally {
      if (saved && state.bodhinoxPrisma) state.bodhinoxPrisma.worker = saved;
    }
  });
});
