/**
 * Phase 11's conversation_channel migration takes ACCESS EXCLUSIVE locks on
 * messages and conversations. Prisma runs a migration file as one transaction,
 * so a VALIDATE in that file would full-scan those tables while the locks
 * block all WhatsApp traffic. Every constraint it adds NOT VALID is validated
 * in the follow-up file instead, which takes no ACCESS EXCLUSIVE lock.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (name: string) =>
  readFileSync(resolve(`prisma/migrations/${name}/migration.sql`), "utf8")
    .replace(/--[^\n]*/g, "");
const channel = read("20261109101000_conversation_channel");
const validate = read("20261109101400_conversation_channel_validate");

const notValid = [...channel.matchAll(/ALTER TABLE (\w+) ADD CONSTRAINT (\w+)[^;]*NOT VALID;/g)]
  .map(([, table, name]) => `${table}.${name}`);

describe("conversation_channel migration locking", () => {
  it("validates nothing in the file that takes ACCESS EXCLUSIVE locks", () => {
    expect(channel).not.toMatch(/VALIDATE CONSTRAINT/i);
  });

  it("adds every constraint NOT VALID", () => {
    const added = [...channel.matchAll(/ADD CONSTRAINT (\w+)/g)].map(([, name]) => name);
    expect(added.length).toBeGreaterThan(0);
    expect(notValid.map((key) => key.split(".")[1])).toEqual(added);
  });

  it("validates each of them in the follow-up file", () => {
    const validated = [...validate.matchAll(/ALTER TABLE (\w+) VALIDATE CONSTRAINT (\w+);/g)]
      .map(([, table, name]) => `${table}.${name}`);
    expect(validated.sort()).toEqual([...notValid].sort());
  });

  it("takes no ACCESS EXCLUSIVE step in the follow-up file", () => {
    const statements = validate.split(";").map((s) => s.trim()).filter(Boolean);
    for (const statement of statements) expect(statement).toMatch(/^ALTER TABLE \w+ VALIDATE CONSTRAINT \w+$/);
  });
});
