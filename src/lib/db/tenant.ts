import { Prisma, type PrismaClient } from "@prisma/client";
import { getPrisma } from "./prisma";
import { isDryRun } from "@/lib/runtime/dry-run-guard";

export type TenantContext = {
  accountId: string;
  userId?: string;
  role?: "owner" | "admin" | "agent" | "viewer";
};
export type TenantTransaction = Prisma.TransactionClient;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A tenant setting is local to this transaction, never retained on pooled connections. */
export async function withTenant<T>(context: TenantContext, operation: (tx: TenantTransaction) => Promise<T>,
  db: PrismaClient = getPrisma(), options: { timeoutMs?: number } = {}): Promise<T> {
  if (!uuid.test(context.accountId) || (context.userId && !uuid.test(context.userId))) {
    throw new Error("Invalid tenant identity");
  }
  const readOnly = isDryRun();
  return db.$transaction(async (tx) => {
    // A flow dry run (withDryRun) may read but never write: the first statement
    // makes the whole transaction read-only, so any write raises SQLSTATE 25006.
    if (readOnly) await tx.$executeRaw(Prisma.sql`SET TRANSACTION READ ONLY`);
    await tx.$queryRaw(Prisma.sql`SELECT set_config('app.account_id', ${context.accountId}, true),
      set_config('app.user_id', ${context.userId || ""}, true),
      set_config('app.account_role', ${context.role || ""}, true)`);
    return operation(tx);
  }, { maxWait: 10_000, timeout: options.timeoutMs ?? 30_000 });
}

export const withTenantTransaction = withTenant;
