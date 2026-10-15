import { defineConfig } from "prisma/config";
import { config } from "dotenv";

// CLI operations always use the migration owner. Runtime uses distinct constrained clients.
config({ path: process.env.DATABASE_ENV_FILE || ".env.local", quiet: true });

const migrationUrl = process.env.MIGRATION_DATABASE_URL ||
  (process.env.NODE_ENV !== "production" ? process.env.DATABASE_URL : undefined);
if (process.argv.some((argument) => argument === "migrate" || argument === "db") && !migrationUrl) {
  throw new Error("MIGRATION_DATABASE_URL is required for database schema operations");
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    url: migrationUrl || "postgresql://generate_only:generate_only@127.0.0.1:5432/generate_only",
  },
});
