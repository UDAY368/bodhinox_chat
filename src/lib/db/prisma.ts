import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

type DatabaseKind = "app" | "auth" | "worker" | "migration";
const state = globalThis as typeof globalThis & { bodhinoxPrisma?: Partial<Record<DatabaseKind, PrismaClient>> };

function databaseUrl(kind: DatabaseKind): string {
  const variables = { app: "DATABASE_URL", auth: "AUTH_DATABASE_URL", worker: "WORKER_DATABASE_URL", migration: "MIGRATION_DATABASE_URL" } as const;
  const key = variables[kind];
  const value = process.env[key] || (process.env.NODE_ENV !== "production" ? process.env.DATABASE_URL : undefined);
  if (!value) throw new Error(`Missing required configuration: ${key}`);
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${key} must be a valid PostgreSQL connection URL`); }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error(`${key} must use PostgreSQL`);
  const expectedRole = { app: "bodhinox_app", auth: "bodhinox_auth", worker: "bodhinox_worker" } as const;
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

export async function disconnectDatabases(): Promise<void> {
  await Promise.all(Object.values(state.bodhinoxPrisma || {}).map((db) => db?.$disconnect()));
  state.bodhinoxPrisma = {};
}
