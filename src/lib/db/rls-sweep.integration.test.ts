// Catalogue sweep of the tenancy boundary in the real schema (after every migration), so a new
// table, grant or definer function cannot slip past row-level security unnoticed. Local Docker
// database only: node scripts/test-db-local.cjs run (it never reads .env.test).
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const connectionString = process.env.TEST_DATABASE_URL;
let pool: pg.Pool;

type AppAccess = "none" | "select" | "any";
/**
 * Tables intentionally outside tenant RLS (no account_id/tenant_id policy calling app_account_id()).
 * appAccess pins what bodhinox_app may do there: "none" = no table privilege at all.
 */
const ALLOWLIST: Record<string, { reason: string; appAccess: AppAccess }> = {
  _prisma_migrations: { reason: "Prisma migration history, owner only", appAccess: "none" },
  auth_identities: { reason: "identity service (bodhinox_auth), not tenant data", appAccess: "none" },
  auth_mfa_factors: { reason: "identity service (bodhinox_auth)", appAccess: "none" },
  auth_rate_limits: { reason: "identity service login limiter", appAccess: "none" },
  auth_refresh_tokens: { reason: "identity service (bodhinox_auth)", appAccess: "none" },
  auth_sessions: { reason: "identity service; account_id is the session's active workspace, read by bodhinox_auth only", appAccess: "none" },
  auth_users: { reason: "identity service (bodhinox_auth)", appAccess: "none" },
  auth_verifications: { reason: "identity service (bodhinox_auth)", appAccess: "none" },
  billing_events: { reason: "provider billing webhook ledger, worker only (forced RLS, worker policy)", appAccess: "none" },
  billing_reconciliation_items: { reason: "platform/worker reconciliation queue (forced RLS, no app grant)", appAccess: "none" },
  invoice_sequences: { reason: "global invoice numbering, used inside definer functions", appAccess: "none" },
  meta_data_deletion_requests: { reason: "Meta data deletion callback ledger (hashed Facebook user id), worker only", appAccess: "none" },
  plan_prices: { reason: "public plan catalogue, read-only", appAccess: "select" },
  plan_versions: { reason: "public plan catalogue, read-only", appAccess: "select" },
  plans: { reason: "public plan catalogue, read-only", appAccess: "select" },
  platform_audit_log: { reason: "platform console audit, owner policy only, append-only", appAccess: "none" },
  rate_cards: { reason: "public price catalogue, read-only", appAccess: "select" },
  webhook_receipts: { reason: "provider webhook dedupe before a tenant is resolved, worker only", appAccess: "none" },
  worker_heartbeats: { reason: "worker liveness (Phase 15), no tenant data, worker policy only", appAccess: "none" },
};

/**
 * Secret-like columns bodhinox_app can SELECT today. The server reads them inside withTenant; the
 * browser data gateway strips them (src/lib/data/contracts.ts sensitive set). This is a committed
 * snapshot: a new readable secret-like column fails until it is reviewed and added here.
 */
const KNOWN_APP_READABLE_SECRETS: Record<string, string> = {
  "account_invitations.token_hash": "hash only; invitation lookup",
  "appointments.manage_token_hash": "hash only; manage-link lookup",
  "broadcast_recipients.click_token": "click-tracking token, not a credential",
  "contacts.inbound_created_meta_id": "internalFields: provider id, stripped by contracts",
  "conversations.inbound_created_meta_id": "internalFields: provider id, stripped by contracts",
  "jobs.lease_token": "queue fencing token, not a credential",
  "storefront_sessions.token_hash": "hash only; storefront session lookup",
  "webhook_endpoints.secret": "tenant webhook signing secret; read server-side to sign deliveries",
  "whatsapp_config.access_token": "encrypted at rest; read server-side to send",
  "whatsapp_config.verify_token": "legacy verify token; stripped by contracts",
  "whatsapp_config.verify_token_hash": "hash only",
  "whatsapp_form_sessions.flow_token": "WhatsApp Forms correlation token",
};
/**
 * Permissive policies that reach bodhinox_app (TO PUBLIC = polroles {0}, or the app role) on a tenant
 * table. Postgres ORs permissive policies, so each one must itself confine rows to the caller's
 * workspace: its USING and WITH CHECK must be `<tenant column> = app_account_id()` alone or as the
 * first term of a top-level AND. pg_get_expr prints a top-level AND as `((a) AND (b) ...)`, so
 * `(... = app_account_id()) OR x` or `(a AND b) OR c` never match. Role-scoped auth/worker/platform
 * policies are not in polroles for app/PUBLIC, so they are not checked.
 */
const APP_POLICIES_SQL = `
  SELECT c.relname || '.' || p.polname AS policy, pg_get_expr(p.polqual, p.polrelid) AS qual,
    pg_get_expr(p.polwithcheck, p.polrelid) AS withcheck
  FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND p.polpermissive AND NOT (c.relname = ANY($1::text[]))
    AND (0 = ANY(p.polroles) OR (SELECT oid FROM pg_roles WHERE rolname = 'bodhinox_app') = ANY(p.polroles))
  ORDER BY 1`;
const TENANT_CONFINED = /^\(\(?(account_id|tenant_id|id) = app_account_id\(\)\)( AND |$)/;
/** App/PUBLIC policies scoped by something other than the workspace, reviewed. */
const POLICY_EXCEPTIONS: Record<string, string> = {
  "profiles.own_profile_update": "a user's own profile row (user_id = app_user_id()); profiles are per user, not per workspace",
  "profiles.tenant_read": "profiles of members of the caller's workspace (EXISTS membership with account_id = app_account_id())",
};

/** Names that match the secret pattern but are counts, timestamps or flags. */
const NOT_SECRET = /(_tokens|token_expires_at|token_refreshed_at|token_epoch|token_cap|^is_secret)$/;

describe.skipIf(!connectionString)("[TEN-01][SEC-03] row-level security catalogue sweep", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString, max: 2 });
    const name = await pool.query("SELECT current_database() AS name");
    if (!/test/i.test(name.rows[0].name)) throw new Error("Integration tests require a separately named test database");
  });
  afterAll(async () => { await pool?.end(); });

  it("forces RLS with an app_account_id() policy on every tenant table; everything else is allowlisted", async () => {
    const { rows } = await pool.query<{ table: string; rls: boolean; forced: boolean; tenant: boolean; policies: number }>(`
      SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
        (c.relname = 'accounts' OR EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND NOT a.attisdropped
          AND a.attnum > 0 AND a.attname IN ('account_id', 'tenant_id'))) AS tenant,
        (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid
          AND (coalesce(pg_get_expr(p.polqual, p.polrelid), '') || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) LIKE '%app_account_id()%') AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY 1`);
    expect(rows.length).toBeGreaterThan(50);
    const problems: string[] = [];
    for (const row of rows) {
      if (ALLOWLIST[row.table]) continue;
      if (!row.tenant) { problems.push(`${row.table}: no account_id/tenant_id and not allowlisted`); continue; }
      if (!row.rls || !row.forced) problems.push(`${row.table}: RLS not enabled and forced`);
      if (row.policies === 0) problems.push(`${row.table}: no policy calling app_account_id()`);
    }
    expect(problems).toEqual([]);
    const tables = new Set(rows.map((row) => row.table));
    expect(Object.keys(ALLOWLIST).filter((table) => !tables.has(table)), "stale allowlist entries").toEqual([]);
  });

  it("has no permissive bypass policy for bodhinox_app or PUBLIC on a tenant table (permissive policies are ORed)", async () => {
    const offending = async (db: pg.Pool | pg.PoolClient) => (await db.query<{ policy: string; qual: string | null; withcheck: string | null }>(
      APP_POLICIES_SQL, [Object.keys(ALLOWLIST)])).rows
      .filter((row) => !POLICY_EXCEPTIONS[row.policy] && [row.qual, row.withcheck].some((expr) => expr !== null && !TENANT_CONFINED.test(expr)))
      .map((row) => row.policy);
    expect(await offending(pool)).toEqual([]);
    // The check really sees a bypass: a USING (true) policy for PUBLIC, and an OR'd one for the app role.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("CREATE POLICY rls_sweep_probe_open ON contacts USING (true)");
      await client.query("CREATE POLICY rls_sweep_probe_or ON tags TO bodhinox_app USING (account_id = app_account_id() OR true)");
      expect((await offending(client)).sort()).toEqual(["contacts.rls_sweep_probe_open", "tags.rls_sweep_probe_or"]);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("gives bodhinox_app no more than the allowlist says on tables outside tenant RLS", async () => {
    const { rows } = await pool.query<{ table: string; privilege: string }>(`
      SELECT table_name AS table, privilege_type AS privilege FROM information_schema.table_privileges
      WHERE grantee = 'bodhinox_app' AND table_schema = 'public' AND table_name = ANY($1)`, [Object.keys(ALLOWLIST)]);
    const columns = await pool.query<{ table: string }>(`
      SELECT DISTINCT table_name AS table FROM information_schema.column_privileges
      WHERE grantee = 'bodhinox_app' AND table_schema = 'public' AND table_name = ANY($1)`,
      [Object.entries(ALLOWLIST).filter(([, entry]) => entry.appAccess === "none").map(([table]) => table)]);
    const problems = rows.filter((row) => {
      const access = ALLOWLIST[row.table].appAccess;
      return access === "none" || (access === "select" && row.privilege !== "SELECT");
    }).map((row) => `${row.table}: ${row.privilege}`);
    expect(problems).toEqual([]);
    expect(columns.rows).toEqual([]);
  });

  it("keeps every constrained role without superuser or RLS bypass", async () => {
    const { rows } = await pool.query<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean }>(
      "SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = ANY($1) ORDER BY 1",
      [["bodhinox_app", "bodhinox_auth", "bodhinox_platform", "bodhinox_worker"]]);
    expect(rows.map((row) => row.rolname)).toEqual(["bodhinox_app", "bodhinox_auth", "bodhinox_platform", "bodhinox_worker"]);
    for (const row of rows) expect(row, row.rolname).toMatchObject({ rolbypassrls: false, rolsuper: false });
  });

  it("lets bodhinox_app read no secret-like column beyond the reviewed snapshot", async () => {
    const { rows } = await pool.query<{ table: string; column: string }>(`
      SELECT DISTINCT table_name AS table, column_name AS column FROM information_schema.column_privileges
      WHERE grantee = 'bodhinox_app' AND table_schema = 'public' AND privilege_type = 'SELECT'
        AND (column_name ~* '(password|token|secret)' OR column_name = 'inbound_created_meta_id')`);
    const readable = rows.filter((row) => !NOT_SECRET.test(row.column)).map((row) => `${row.table}.${row.column}`).sort();
    expect(readable.filter((column) => !KNOWN_APP_READABLE_SECRETS[column]), "new app-readable secret-like columns").toEqual([]);
    // Passwords are never readable by the app role, whatever the table.
    expect(readable.filter((column) => /password/i.test(column))).toEqual([]);
  });

  it("pins search_path and revokes PUBLIC on every SECURITY DEFINER function", async () => {
    const { rows } = await pool.query<{ name: string }>(`
      SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS name
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef
        AND (NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}'::text[])) c WHERE c LIKE 'search_path=%')
          OR has_function_privilege('public', p.oid, 'EXECUTE'))`);
    expect(rows.map((row) => row.name)).toEqual([]);
  });

  it("[OPS-01] crm_ops_health is executable by platform and worker only and returns scalars", async () => {
    const { rows } = await pool.query<{ role: string; allowed: boolean }>(`
      SELECT r AS role, has_function_privilege(r, 'crm_ops_health()', 'EXECUTE') AS allowed
      FROM unnest(ARRAY['bodhinox_app','bodhinox_auth','bodhinox_platform','bodhinox_worker']) r ORDER BY 1`);
    expect(Object.fromEntries(rows.map((row) => [row.role, row.allowed]))).toEqual({
      bodhinox_app: false, bodhinox_auth: false, bodhinox_platform: true, bodhinox_worker: true });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE bodhinox_platform");
      const health = await client.query("SELECT * FROM crm_ops_health()");
      expect(health.rows).toHaveLength(1);
      expect(Object.keys(health.rows[0]).sort()).toEqual(["expired_running_leases", "failed_jobs_1h", "last_beat_age_s",
        "latest_migration", "oldest_due_age_s", "pending_due", "unknown_intents", "unprocessed_webhooks_15m"]);
      expect(health.rows[0].latest_migration).toMatch(/^\d{14}_[a-z0-9_]+$/);
      await client.query("ROLLBACK");
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE bodhinox_app");
      await expect(client.query("SELECT * FROM crm_ops_health()")).rejects.toThrow(/permission denied/);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("[OPS-01] worker_heartbeats is writable by the worker role only", async () => {
    const id = `rls-sweep-${process.pid}-${Date.now()}`;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE bodhinox_worker");
      await client.query(`INSERT INTO worker_heartbeats(worker_id, started_at, beat_at) VALUES ($1, now(), now())
        ON CONFLICT (worker_id) DO UPDATE SET beat_at = EXCLUDED.beat_at`, [id]);
      expect((await client.query("SELECT count(*)::int AS n FROM worker_heartbeats WHERE worker_id = $1", [id])).rows[0].n).toBe(1);
      await expect(client.query("DELETE FROM worker_heartbeats WHERE worker_id = $1", [id])).rejects.toThrow(/permission denied/);
      await client.query("ROLLBACK");
      for (const role of ["bodhinox_app", "bodhinox_auth", "bodhinox_platform"]) {
        await client.query("BEGIN");
        await client.query(`SET LOCAL ROLE ${role}`);
        await expect(client.query("SELECT 1 FROM worker_heartbeats LIMIT 1"), role).rejects.toThrow(/permission denied/);
        await client.query("ROLLBACK");
      }
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });
});
