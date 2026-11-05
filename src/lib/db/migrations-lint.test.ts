// Migration safety gate (unit stage, so it runs in CI before the production migrate job).
// Merging to main runs `prisma migrate deploy` against production while the previous release is
// still serving, so every migration after Phase 14 must be additive and live-safe, and no
// migration that may already be deployed can change. See docs/testing/migration-safety.md.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = resolve("prisma/migrations");
const MANIFEST = resolve("prisma/migration-checksums.json");
/** The last Phase 14 migration; every migration after it is linted. */
const LINT_AFTER = "20261112100600_platform_validate";

const names = readdirSync(DIR).filter((name) => existsSync(resolve(DIR, name, "migration.sql"))).sort();
const read = (name: string) => readFileSync(resolve(DIR, name, "migration.sql"), "utf8").replace(/\r\n/g, "\n");
const linted = names.filter((name) => name > LINT_AFTER);

/** SQL without comments, so a word in a comment is never mistaken for a statement. */
export function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/**
 * Top-level statements, ignoring semicolons inside $$ bodies, quoted strings and comments.
 * keepComments=true keeps each statement's comments (for `-- additive-exception:` notes); a
 * comment after a statement's semicolon on the same line belongs to that statement.
 */
function split(rawSql: string, keepComments: boolean): string[] {
  const body = rawSql.replace(/\r\n/g, "\n");
  const out: string[] = [];
  let current = "";
  let dollar: string | null = null;
  let quote = false;
  let trailing = false; // after a top-level ';', until the end of that line
  const push = () => { if (stripComments(current).trim()) out.push(current.trim()); current = ""; };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (dollar === null && !quote) {
      if (body.startsWith("--", i)) {
        const end = body.indexOf("\n", i);
        const comment = body.slice(i, end === -1 ? body.length : end);
        if (keepComments) {
          if (trailing && out.length) out[out.length - 1] += ` ${comment}`;
          else current += comment;
        } else current += " ";
        i += comment.length - 1;
        continue;
      }
      if (body.startsWith("/*", i)) {
        const end = body.indexOf("*/", i + 2);
        const comment = body.slice(i, end === -1 ? body.length : end + 2);
        current += keepComments ? comment : " ";
        i += comment.length - 1;
        continue;
      }
    }
    if (ch === "\n") trailing = false;
    if (!quote) {
      const tag = body.slice(i).match(/^\$[A-Za-z_]*\$/)?.[0];
      if (tag && (dollar === null || dollar === tag)) {
        dollar = dollar === null ? tag : null;
        current += tag;
        i += tag.length - 1;
        continue;
      }
    }
    if (dollar === null && ch === "'") quote = !quote;
    if (dollar === null && !quote && ch === ";") {
      push();
      trailing = true;
      continue;
    }
    current += ch;
  }
  push();
  return keepComments ? out : out.map((statement) => statement.replace(/\s+/g, " ").trim());
}

/** Top-level statements without comments. */
export function statements(sql: string): string[] {
  return split(sql, false);
}

const DESTRUCTIVE = new RegExp([
  String.raw`\bDROP\s+(TABLE|COLUMN|CONSTRAINT|POLICY|FUNCTION|TRIGGER|INDEX|VIEW|MATERIALIZED\s+VIEW|TYPE|SEQUENCE|SCHEMA|EXTENSION)\b`,
  String.raw`\bRENAME\b`, String.raw`\bALTER\s+COLUMN\b[^;\n]*\bTYPE\b`, String.raw`\bSET\s+NOT\s+NULL\b`, String.raw`\bTRUNCATE\b`,
  String.raw`\b(DISABLE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY\b`, String.raw`\bDISABLE\s+TRIGGER\b`,
].join("|"), "i");

const TABLE = String.raw`(?:ONLY\s+)?(?:public\.)?"?(\w+)"?`;
/**
 * DDL that takes a long or ACCESS EXCLUSIVE lock on its table. lock_timeout bounds only the wait for
 * the lock, not a non-concurrent index build. Allowed on a table the same migration creates, or with an
 * `-- additive-exception: <reason>` note in the statement. Matched anywhere in a statement, including
 * dynamic SQL in a DO block.
 */
const LOCK_HEAVY: Array<[string, RegExp]> = [
  ["CREATE INDEX without CONCURRENTLY", new RegExp(String.raw`\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!CONCURRENTLY\b)(?:IF\s+NOT\s+EXISTS\s+)?\w+\s+ON\s+${TABLE}`, "gi")],
  ["CREATE POLICY", new RegExp(String.raw`\bCREATE\s+POLICY\s+\w+\s+ON\s+${TABLE}`, "gi")],
  ["ENABLE/FORCE ROW LEVEL SECURITY", new RegExp(String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?${TABLE}\s+(?:ENABLE|FORCE)\s+ROW\s+LEVEL\s+SECURITY\b`, "gi")],
  ["CREATE TRIGGER", new RegExp(String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+\w+\s+[\s\S]*?\bON\s+${TABLE}`, "gi")],
];
const CHECK_ON_EXISTING = new RegExp(String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?${TABLE}\s[\s\S]*\bADD\s+(?:CONSTRAINT\s+\w+\s+)?CHECK\b`, "i");
const EXCEPTION = /--\s*additive-exception:\s*\S/;

/** Problems in one migration; an empty list means it passes. */
export function lintMigration(name: string, rawSql: string): string[] {
  const sql = rawSql.replace(/\r\n/g, "\n");
  const problems: string[] = [];
  if (!/^\d{14}_[a-z0-9_]+$/.test(name)) problems.push("name must match ^\\d{14}_[a-z0-9_]+$");
  // A destructive line needs an inline reason on the same line.
  for (const line of sql.split("\n")) {
    const code = line.replace(/--.*$/, "");
    if (DESTRUCTIVE.test(code) && !EXCEPTION.test(line)) {
      problems.push(`destructive statement without "-- additive-exception: <reason>": ${code.trim().slice(0, 80)}`);
    }
  }
  const stmts = statements(sql);
  const raw = split(sql, true);
  const concurrent = stmts.some((s) => /\bCONCURRENTLY\b/i.test(s));
  if (concurrent) {
    if (stmts.length !== 1) problems.push("a CONCURRENTLY migration must hold exactly one statement");
    if (stmts.some((s) => /\bIF\s+NOT\s+EXISTS\b/i.test(s))) problems.push("CONCURRENTLY with IF NOT EXISTS would keep an INVALID index");
  } else if (!/^SET LOCAL lock_timeout = '5s'$/.test(stmts[0] ?? "")) {
    problems.push("a non-index migration must start with SET LOCAL lock_timeout = '5s';");
  }
  const created = new Set<string>();
  stmts.forEach((s, index) => {
    const table = s.match(new RegExp(String.raw`^CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${TABLE}`, "i"))?.[1]?.toLowerCase();
    if (table) created.add(table);
    const excepted = EXCEPTION.test(raw[index] ?? "");
    const heavy = (label: string, target: string) => {
      if (!created.has(target.toLowerCase()) && !excepted) {
        problems.push(`${label} on existing table ${target} without "-- additive-exception: <reason>" (blocks writes)`);
      }
    };
    for (const [label, pattern] of LOCK_HEAVY) for (const match of s.matchAll(pattern)) heavy(label, match[1]);
    const check = s.match(CHECK_ON_EXISTING);
    if (check && !/\bNOT\s+VALID\b/i.test(s)) heavy("CHECK constraint without NOT VALID", check[1]);
  });
  for (const s of stmts) {
    if (/^ALTER\s+TABLE\b[\s\S]*\bADD\b[\s\S]*\bFOREIGN\s+KEY\b/i.test(s) && !/\bNOT\s+VALID\s*$/i.test(s)) {
      problems.push("a foreign key added to an existing table must be NOT VALID (validate in a later migration)");
    }
    const fn = s.match(/^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(\w+)\s*\(/i);
    if (fn && /\bSECURITY\s+DEFINER\b/i.test(s)) {
      if (!/\bSET\s+search_path\s*=\s*public\s*,\s*pg_temp\b/i.test(s)) problems.push(`${fn[1]}: SECURITY DEFINER without SET search_path=public,pg_temp`);
      if (!new RegExp(`REVOKE\\s+ALL\\s+ON\\s+FUNCTION\\s+${fn[1]}\\s*\\([^)]*\\)\\s+FROM\\s+PUBLIC`, "i").test(sql)) {
        problems.push(`${fn[1]}: SECURITY DEFINER without REVOKE ALL ... FROM PUBLIC`);
      }
    }
  }
  return problems;
}

export function checksum(sql: string): string {
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");
}

describe("[OPS-03][OPS-01] migration safety lint", () => {
  it("lints every migration after Phase 14", () => {
    expect(linted.length).toBeGreaterThan(0);
    const failures = linted.flatMap((name) => lintMigration(name, read(name)).map((problem) => `${name}: ${problem}`));
    expect(failures).toEqual([]);
  });

  it("catches the unsafe patterns it is meant to", () => {
    const head = "SET LOCAL lock_timeout = '5s';\n";
    expect(lintMigration("20261113000000_ok", `${head}CREATE TABLE t (id int);`)).toEqual([]);
    expect(lintMigration("2026_bad-name", `${head}SELECT 1;`)).toContainEqual(expect.stringMatching(/name must match/));
    expect(lintMigration("20261113000000_x", "CREATE TABLE t (id int);")).toContainEqual(expect.stringMatching(/lock_timeout/));
    expect(lintMigration("20261113000000_x", `${head}ALTER TABLE t DROP COLUMN c;`)).toContainEqual(expect.stringMatching(/destructive/));
    expect(lintMigration("20261113000000_x", `${head}ALTER TABLE t DROP COLUMN c; -- additive-exception: unused since 2026-01`)).toEqual([]);
    expect(lintMigration("20261113000000_x", `${head}ALTER TABLE t RENAME TO u;`)).toContainEqual(expect.stringMatching(/destructive/));
    expect(lintMigration("20261113000000_x", `${head}ALTER TABLE t ALTER COLUMN c TYPE bigint;`)).toContainEqual(expect.stringMatching(/destructive/));
    expect(lintMigration("20261113000000_x", `${head}ALTER TABLE t ALTER COLUMN c SET NOT NULL;`)).toContainEqual(expect.stringMatching(/destructive/));
    expect(lintMigration("20261113000000_x", `${head}TRUNCATE t;`)).toContainEqual(expect.stringMatching(/destructive/));
    expect(lintMigration("20261113000000_x", `${head}-- we never DROP TABLE here\nSELECT 1;`)).toEqual([]);
    expect(lintMigration("20261113000000_x", "CREATE INDEX CONCURRENTLY i ON t (c);")).toEqual([]);
    expect(lintMigration("20261113000000_x", "CREATE INDEX CONCURRENTLY IF NOT EXISTS i ON t (c);")).toContainEqual(expect.stringMatching(/INVALID/));
    expect(lintMigration("20261113000000_x", "CREATE INDEX CONCURRENTLY i ON t (c);\nCREATE INDEX CONCURRENTLY j ON t (d);"))
      .toContainEqual(expect.stringMatching(/exactly one statement/));
    expect(lintMigration("20261113000000_x", `${head}ALTER TABLE t ADD CONSTRAINT f FOREIGN KEY (a) REFERENCES u(id);`))
      .toContainEqual(expect.stringMatching(/NOT VALID/));
    expect(lintMigration("20261113000000_x", `${head}ALTER TABLE t ADD CONSTRAINT f FOREIGN KEY (a) REFERENCES u(id) NOT VALID;`)).toEqual([]);
    const definer = `${head}CREATE FUNCTION f() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1; $$;`;
    expect(lintMigration("20261113000000_x", definer)).toEqual(expect.arrayContaining([
      expect.stringMatching(/search_path/), expect.stringMatching(/REVOKE/)]));
    // L1: the lock_timeout must come first, and lock-heavy DDL on an existing table needs a reason.
    expect(lintMigration("20261113000000_x", `CREATE TABLE t (id int);\n${head}`)).toContainEqual(expect.stringMatching(/lock_timeout/));
    expect(lintMigration("20261113000000_x", `${head}CREATE INDEX i ON messages (c);`)).toContainEqual(expect.stringMatching(/CREATE INDEX without CONCURRENTLY/));
    expect(lintMigration("20261113000000_x", `${head}CREATE UNIQUE INDEX IF NOT EXISTS i ON public.messages (c);`)).toContainEqual(expect.stringMatching(/messages/));
    expect(lintMigration("20261113000000_x", `${head}CREATE POLICY p ON jobs FOR SELECT USING (true);`)).toContainEqual(expect.stringMatching(/CREATE POLICY/));
    expect(lintMigration("20261113000000_x", `${head}DO $$ BEGIN EXECUTE format('CREATE POLICY p ON jobs USING (true)'); END $$;`))
      .toContainEqual(expect.stringMatching(/CREATE POLICY on existing table jobs/));
    expect(lintMigration("20261113000000_x", `${head}ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;`)).toContainEqual(expect.stringMatching(/ROW LEVEL SECURITY/));
    expect(lintMigration("20261113000000_x", `${head}ALTER TABLE contacts FORCE ROW LEVEL SECURITY;`)).toContainEqual(expect.stringMatching(/ROW LEVEL SECURITY/));
    expect(lintMigration("20261113000000_x", `${head}CREATE TRIGGER tr AFTER INSERT ON messages FOR EACH ROW EXECUTE FUNCTION f();`))
      .toContainEqual(expect.stringMatching(/CREATE TRIGGER/));
    expect(lintMigration("20261113000000_x", `${head}ALTER TABLE t ADD CONSTRAINT c CHECK (x > 0);`)).toContainEqual(expect.stringMatching(/NOT VALID/));
    expect(lintMigration("20261113000000_x", `${head}ALTER TABLE t ADD CONSTRAINT c CHECK (x > 0) NOT VALID;`)).toEqual([]);
    expect(lintMigration("20261113000000_x", `${head}CREATE POLICY p ON jobs USING (true); -- additive-exception: owner read policy`)).toEqual([]);
    const fresh = `${head}CREATE TABLE w (id int);\nCREATE INDEX w_idx ON w (id);\nALTER TABLE w ENABLE ROW LEVEL SECURITY;\nALTER TABLE w FORCE ROW LEVEL SECURITY;\n`
      + `CREATE POLICY p ON w USING (true);\nALTER TABLE w ADD CONSTRAINT c CHECK (id > 0);\nCREATE TRIGGER tr BEFORE INSERT ON w FOR EACH ROW EXECUTE FUNCTION f();`;
    expect(lintMigration("20261113000000_x", fresh)).toEqual([]);
    // F9: more destructive statements need a reason.
    for (const stmt of ["DROP INDEX i;", "DROP TRIGGER tr ON t;", "DROP VIEW v;", "DROP MATERIALIZED VIEW v;", "DROP TYPE ty;", "DROP SEQUENCE s;",
      "ALTER TABLE t DISABLE ROW LEVEL SECURITY;", "ALTER TABLE t NO FORCE ROW LEVEL SECURITY;", "ALTER TABLE t DISABLE TRIGGER tr;"]) {
      expect(lintMigration("20261113000000_x", `${head}${stmt}`), stmt).toContainEqual(expect.stringMatching(/destructive/));
    }
    const pinned = `${head}CREATE FUNCTION f() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT 1; $$;\nREVOKE ALL ON FUNCTION f() FROM PUBLIC;`;
    expect(lintMigration("20261113000000_x", pinned)).toEqual([]);
  });

  it("splits statements without breaking $$ bodies or strings", () => {
    expect(statements("SELECT ';'; CREATE FUNCTION f() AS $$ SELECT 1; SELECT 2; $$; -- x;\n/* y; */SELECT 3;")).toHaveLength(3);
    expect(statements("-- only a comment;\n")).toEqual([]);
  });
});

describe("[OPS-03][OPS-01] deployed migrations never change", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Record<string, string>;

  it("lists every migration (run node scripts/release/migration-checksums.cjs after adding one)", () => {
    expect(names.filter((name) => !manifest[name])).toEqual([]);
    expect(Object.keys(manifest).filter((name) => !names.includes(name))).toEqual([]);
  });

  it("matches the recorded checksum (CRLF normalized to LF)", () => {
    const changed = names.filter((name) => manifest[name] && manifest[name] !== checksum(read(name)));
    expect(changed).toEqual([]);
    expect(checksum("a\r\nb")).toBe(checksum("a\nb"));
  });
});
