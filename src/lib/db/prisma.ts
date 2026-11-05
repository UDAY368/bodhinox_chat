import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { assertLocalTestDatabaseUrl, testDatabaseGuardActive } from "./test-db-guard";

type DatabaseKind = "app" | "auth" | "worker" | "migration" | "platform";
const state = globalThis as typeof globalThis & { bodhinoxPrisma?: Partial<Record<DatabaseKind, PrismaClient>> };

function databaseUrl(kind: DatabaseKind): string {
  const variables = { app: "DATABASE_URL", auth: "AUTH_DATABASE_URL", worker: "WORKER_DATABASE_URL", migration: "MIGRATION_DATABASE_URL",
    platform: "PLATFORM_DATABASE_URL" } as const;
  const key = variables[kind];
  // The platform console role never falls back to another connection, in any environment:
  // without PLATFORM_DATABASE_URL the console is off (404).
  const value = process.env[key] || (process.env.NODE_ENV !== "production" && kind !== "platform" ? process.env.DATABASE_URL : undefined);
  if (!value) throw new Error(`Missing required configuration: ${key}`);
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${key} must be a valid PostgreSQL connection URL`); }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error(`${key} must use PostgreSQL`);
  // Test runs only reach a local database unless ALLOW_REMOTE_TEST_DB=1 (npm run test:db / test:all).
  if (testDatabaseGuardActive()) assertLocalTestDatabaseUrl(key, value);
  const expectedRole = { app: "bodhinox_app", auth: "bodhinox_auth", worker: "bodhinox_worker", platform: "bodhinox_platform" } as const;
  if (process.env.NODE_ENV === "production" && kind !== "migration" && decodeURIComponent(url.username) !== expectedRole[kind]) {
    throw new Error(`${key} must use the constrained ${expectedRole[kind]} role`);
  }
  return value;
}

function client(kind: DatabaseKind): PrismaClient {
  state.bodhinoxPrisma ??= {};
  state.bodhinoxPrisma[kind] ??= new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl(kind), max: Number(process.env.DB_POOL_SIZE || "10"),
      connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000 }),
    // Repository error envelopes/loggers redact query content; never log raw SQL here.
    log: [],
  });
  return state.bodhinoxPrisma[kind]!;
}

export const getPrisma = (): PrismaClient => client("app");
export const getAuthPrisma = (): PrismaClient => client("auth");
export const getWorkerPrisma = (): PrismaClient => client("worker");
export const getMigrationPrisma = (): PrismaClient => client("migration");
/** Whether the platform console has its own database role configured (PLATFORM_DATABASE_URL). */
export const platformDatabaseConfigured = (): boolean => !!process.env.PLATFORM_DATABASE_URL?.trim();
/**
 * The platform console connection (bodhinox_platform: EXECUTE on crm_platform_* only, no table
 * grants). Throws when PLATFORM_DATABASE_URL is unset; callers check platformDatabaseConfigured().
 */
export const getPlatformPrisma = (): PrismaClient => client("platform");

export async function disconnectDatabases(): Promise<void> {
  await Promise.all(Object.values(state.bodhinoxPrisma || {}).map((db) => db?.$disconnect()));
  state.bodhinoxPrisma = {};
}
