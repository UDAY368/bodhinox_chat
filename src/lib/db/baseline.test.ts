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
