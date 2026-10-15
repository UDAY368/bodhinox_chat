import { config } from "dotenv";
import { getAuthPrisma, disconnectDatabases } from "../src/lib/db/prisma";
import { withTenant } from "../src/lib/db/tenant";

config({ path: process.env.DATABASE_ENV_FILE || ".env.local", quiet: true });

async function main() {
  const [accountId, userId] = process.argv.slice(2);
  if (!accountId || !userId) throw new Error("Usage: db-seed-defaults.ts ACCOUNT_UUID EXISTING_OWNER_USER_UUID");
  const membership = await getAuthPrisma().account_memberships.findUnique({
    where: { account_id_user_id: { account_id: accountId, user_id: userId } },
  });
  if (membership?.role !== "owner") throw new Error("An existing owner membership is required; create users through the auth signup flow");
  await withTenant({ accountId, userId, role: "owner" }, async (tx) => {
    // Lock the account to serialize idempotent initialization without a demo seed.
    await tx.$queryRaw`SELECT id FROM accounts WHERE id=${accountId}::uuid FOR UPDATE`;
    if (await tx.pipelines.count({ where: { account_id: accountId } })) return;
    const pipeline = await tx.pipelines.create({ data: { account_id: accountId, user_id: userId, name: "Sales" } });
    for (const [position, name] of ["New", "Qualified", "Proposal", "Won"].entries()) {
      await tx.pipeline_stages.create({ data: { account_id: accountId, pipeline_id: pipeline.id, name, position } });
    }
  });
  console.log("Tenant defaults initialized safely; rerunning preserves existing pipelines.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error && /Usage:|membership is required/.test(error.message) ? error.message : "Tenant initialization failed; verify tenant identity and runtime role grants.");
  process.exitCode = 1;
}).finally(disconnectDatabases);
