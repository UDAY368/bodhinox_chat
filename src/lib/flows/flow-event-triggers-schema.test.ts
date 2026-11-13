// The automation list's flow triggers (contact_created, tag_added, outside_hours):
// the migration widens flows_trigger_type_check to exactly the shared trigger
// list, re-adds it NOT VALID after every earlier re-add, validates it in a later
// file, and destroys nothing else. schema-inventory.json carries the new values.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import inventory from '../../../prisma/schema-inventory.json';
import checksums from '../../../prisma/migration-checksums.json';
import { FLOW_TRIGGER_TYPES } from './types';

const MIGRATIONS = join(process.cwd(), 'prisma', 'migrations');
const migrations = readdirSync(MIGRATIONS).filter((name) => /^\d{14}_/.test(name)).sort();
const sql = (name: string) => readFileSync(join(MIGRATIONS, name, 'migration.sql'), 'utf8').replace(/--[^\n]*/g, '');
const ADD = '20261123014000_flow_event_triggers';
const VALIDATE = '20261123015000_flow_event_triggers_validate';

const inList = (text: string): string[] => {
  const match = /trigger_type\s+IN\s*\(([^)]*)\)/.exec(text);
  return match ? [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]) : [];
};

describe('flow event trigger migration', () => {
  it('ships both migrations with recorded checksums', () => {
    expect(migrations).toEqual(expect.arrayContaining([ADD, VALIDATE]));
    for (const name of [ADD, VALIDATE]) expect((checksums as Record<string, string>)[name], name).toMatch(/^[0-9a-f]{64}$/);
  });

  it('widens the trigger check to every flow trigger type', () => {
    expect(inList(sql(ADD)).sort()).toEqual([...FLOW_TRIGGER_TYPES].sort());
    for (const type of ['contact_created', 'tag_added', 'outside_hours']) expect(FLOW_TRIGGER_TYPES).toContain(type);
  });

  it('is the last migration that re-adds the trigger check, so a fresh database ends on the superset', () => {
    const readds = migrations.filter((name) => /ADD CONSTRAINT flows_trigger_type_check\b/.test(sql(name)));
    expect(readds[readds.length - 1]).toBe(ADD);
    // Every earlier list is a subset of this one.
    const latest = new Set(inList(sql(ADD)));
    for (const name of readds) for (const value of inList(sql(name))) expect(latest.has(value), `${name}: ${value}`).toBe(true);
  });

  it('adds the check NOT VALID and validates it in the later file', () => {
    expect(sql(ADD)).toMatch(/ADD CONSTRAINT flows_trigger_type_check[\s\S]*NOT VALID/);
    expect(sql(VALIDATE)).toMatch(/VALIDATE CONSTRAINT flows_trigger_type_check/);
    expect(migrations.indexOf(VALIDATE)).toBeGreaterThan(migrations.indexOf(ADD));
  });

  it('drops nothing but the re-added check', () => {
    for (const name of [ADD, VALIDATE]) {
      const text = sql(name);
      expect(text, name).not.toMatch(/\b(DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM|ALTER COLUMN)\b/i);
      for (const drop of text.match(/\bDROP\s+\w+[^;]*/gi) ?? []) expect(drop, name).toMatch(/DROP CONSTRAINT IF EXISTS flows_trigger_type_check/);
    }
  });

  it('keeps the schema inventory in step', () => {
    const flows = (inventory.tables as Record<string, { name: string; definition: string }[]>).flows;
    const definition = flows.find((c) => c.name === 'trigger_type')?.definition ?? '';
    for (const type of FLOW_TRIGGER_TYPES) expect(definition).toContain(`'${type}'`);
  });
});
