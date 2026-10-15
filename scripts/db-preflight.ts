import { config } from "dotenv";
import pg from "pg";

config({ path: process.env.DATABASE_ENV_FILE || ".env.local", quiet: true });

async function main() {
  if (!process.env.MIGRATION_DATABASE_URL) throw new Error("MIGRATION_DATABASE_URL is required");
  const db = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await db.connect();
  try {
    const result = await db.query<{ database: string; tables: number; vector_available: boolean }>(`
      SELECT current_database() AS database,
        (SELECT count(*)::int FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE') AS tables,
        EXISTS(SELECT 1 FROM pg_available_extensions WHERE name='vector') AS vector_available`);
    const row = result.rows[0];
    console.log(JSON.stringify(row));
    if (!row.vector_available) throw new Error("The baseline requires a PostgreSQL image with pgvector available");
    if (process.argv.includes("--expect-empty") && row.tables !== 0) throw new Error("Database is not empty; refuse a fresh-baseline operation");
  } finally { await db.end(); }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error && /requires|not empty|required/.test(error.message) ? error.message : "Database preflight failed; verify migration connection configuration.");
  process.exitCode = 1;
});
