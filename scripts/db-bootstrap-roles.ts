import { config } from "dotenv";
import pg from "pg";

config({ path: process.env.DATABASE_ENV_FILE || ".env.local", quiet: true });
const roles = [
  ["DATABASE_URL", "bodhinox_app"],
  ["AUTH_DATABASE_URL", "bodhinox_auth"],
  ["WORKER_DATABASE_URL", "bodhinox_worker"],
] as const;

async function main() {
  if (!process.env.MIGRATION_DATABASE_URL) throw new Error("MIGRATION_DATABASE_URL is required");
  const owner = new URL(process.env.MIGRATION_DATABASE_URL);
  const credentials = roles.map(([variable, role]) => {
    const value = process.env[variable];
    if (!value) throw new Error(`${variable} is required; generate a unique high-entropy role password first`);
    const url = new URL(value);
    if (decodeURIComponent(url.username) !== role || !url.password) throw new Error(`${variable} must name ${role} and contain its operator-generated password`);
    if (url.hostname !== owner.hostname || url.port !== owner.port || url.pathname !== owner.pathname) {
      throw new Error(`${variable} must target the migration database for role bootstrap`);
    }
    const password = decodeURIComponent(url.password);
    if (password.length < 32) throw new Error(`${variable} needs a password of at least 32 characters`);
    return { role, password };
  });
  const db = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await db.connect();
  try {
    await db.query("BEGIN");
    for (const { role, password } of credentials) {
      const statement = await db.query<{ sql: string }>(
        "SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS', $1::text, $2::text) AS sql",
        [role, password],
      );
      await db.query(statement.rows[0].sql);
    }
    await db.query("COMMIT");
    console.log("Configured constrained application, identity and worker role logins.");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally { await db.end(); }
}

main().catch((error: unknown) => {
  // SQL/connection error strings can contain credentials; print only safe operator configuration errors.
  if (error instanceof Error && /required|must target|must name|needs a password/.test(error.message)) console.error(error.message);
  else console.error("Database role bootstrap failed. Verify migration identity, committed migrations and role permissions.");
  process.exitCode = 1;
});
