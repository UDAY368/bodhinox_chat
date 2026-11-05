import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const baseline = resolve("prisma/migrations/20261014000000_foundation/migration.sql");

describe("PostgreSQL foundation contract", () => {
  it("provides a clean migration without platform-managed schemas", () => {
    expect(existsSync(baseline), "A deployable bare PostgreSQL baseline is required").toBe(true);
    const sql = readFileSync(baseline, "utf8");
    expect(sql).not.toMatch(/auth\.users|auth\.uid\(|storage\.objects|supabase_realtime|\bservice_role\b/i);
    for (const table of ["contacts", "messages", "flows", "ai_knowledge_chunks", "auth_users", "account_memberships", "jobs"]) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?"?${table}"?\\s*\\(`, "i"));
    }
  });

  it("retains concurrency constraints and forces tenant isolation", () => {
    expect(existsSync(baseline)).toBe(true);
    const sql = readFileSync(baseline, "utf8");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("app.account_id");
    expect(sql).toContain("idx_one_active_run_per_contact");
    expect(sql).toContain("idx_contacts_account_phone_normalized");
    expect(sql).toContain("idx_messages_conversation_message_id");
    expect(sql).toContain("FOREIGN KEY (account_id, contact_id)");
    expect(sql).toContain("FOREIGN KEY (account_id, tag_id)");
    expect(sql).toContain("CREATE EXTENSION IF NOT EXISTS vector;");
  });
});

describe("Phase 14 migrations (platform administration)", () => {
  const dir = resolve("prisma/migrations");
  const phase14 = [
    "20261112100000_platform_role_audit", "20261112100100_plan_versions", "20261112100200_usage_ledger",
    "20261112100300_billing_reconciliation", "20261112100400_tenant_lifecycle_support", "20261112100500_workspace_privacy",
    "20261112100600_platform_validate",
  ];
  const read = (name: string) => readFileSync(resolve(dir, name, "migration.sql"), "utf8");

  it("is additive and takes locks with a timeout", () => {
    for (const name of phase14) {
      const sql = read(name);
      expect(sql, name).toMatch(/^SET LOCAL lock_timeout = '5s';$/m);
      // No destructive statement on existing data.
      expect(sql, name).not.toMatch(/\bDROP\s+(TABLE|COLUMN|CONSTRAINT|POLICY|FUNCTION)\b/i);
      expect(sql, name).not.toMatch(/\bTRUNCATE\s+(?!ON\b)/i);
      expect(sql, name).not.toMatch(/^\s*DELETE FROM\b/im);
      // A new FK on an existing table is NOT VALID first (validated in a later migration).
      for (const fk of sql.match(/ALTER TABLE \w+ ADD CONSTRAINT \w+\s+FOREIGN KEY[^;]+;/g) ?? []) expect(fk).toMatch(/NOT VALID;$/);
    }
    expect(read("20261112100600_platform_validate")).toContain("VALIDATE CONSTRAINT account_subscriptions_plan_version_fkey");
  });

  it("creates the platform role without login or bypass and gives it no table grants", () => {
    const sql = read("20261112100000_platform_role_audit");
    expect(sql).toMatch(/CREATE ROLE bodhinox_platform NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS/);
    const all = phase14.map(read).join("\n");
    expect(all).not.toMatch(/GRANT\s+(SELECT|INSERT|UPDATE|DELETE|ALL)[^;]*\bON\s+(TABLE\s+)?\w+[^;]*\bTO\b[^;]*bodhinox_platform/i);
    // Every platform grant is EXECUTE on a crm_platform_* or catalogue function.
    for (const grant of all.match(/GRANT[^;]*bodhinox_platform[^;]*;/g) ?? [])
      expect(grant).toMatch(/^GRANT (USAGE ON SCHEMA public|EXECUTE ON FUNCTION (crm_platform_\w+|crm_plan_feature_keys|crm_plan_limit_keys))/);
  });

  it("makes every definer pin its search path and revoke PUBLIC", () => {
    const all = phase14.map(read).join("\n");
    // Each function's header, up to its body.
    const heads = all.split("CREATE FUNCTION ").slice(1).map((chunk) => chunk.slice(0, chunk.indexOf("$$")));
    expect(heads.filter((head) => head.includes("SECURITY DEFINER")).length).toBeGreaterThan(15);
    for (const head of heads) {
      const name = head.slice(0, head.indexOf("("));
      expect(head, name).toContain("SET search_path=public,pg_temp");
      expect(all.includes(`REVOKE ALL ON FUNCTION ${name}(`), name).toBe(true);
    }
  });

  it("keeps platform_audit_log append-only and grant-free", () => {
    const sql = read("20261112100000_platform_role_audit");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON platform_audit_log/);
    expect(sql).toMatch(/BEFORE TRUNCATE ON platform_audit_log/);
    expect(sql).not.toMatch(/GRANT[^;]*ON platform_audit_log/);
  });

  it("meters usage only in the transaction's own workspace", () => {
    const sql = read("20261112100200_usage_ledger");
    for (const fn of ["billing_reserve_usage", "billing_settle_usage", "billing_release_usage", "billing_record_usage"]) {
      const body = sql.slice(sql.indexOf(`CREATE FUNCTION ${fn}(`));
      expect(body.slice(0, body.indexOf("$$;")), fn).toMatch(/SECURITY INVOKER[\s\S]*app_account_id\(\)/);
      expect(body.slice(0, body.indexOf("$$;")), fn).not.toMatch(/\bp_account\b/);
    }
  });
});
