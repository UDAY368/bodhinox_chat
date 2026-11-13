// The saved report migrations: a FORCE RLS table for admins (worker reads),
// value lists in step with saved-report-shape.ts and report-kinds.ts, every
// constraint added to an existing table NOT VALID and validated later, and the
// inventory, Prisma schema and checksums carrying the new table and columns.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import inventory from '../../../prisma/schema-inventory.json';
import checksums from '../../../prisma/migration-checksums.json';
import { RUN_KINDS } from './report-kinds';
import { SAVED_CHANNELS, SAVED_FORMATS, SAVED_GROUPS, SAVED_METRICS, SAVED_RANGES } from './saved-report-shape';

const NAMES = ['20261122000000_analytics_saved_reports', '20261122000100_analytics_saved_reports_validate', '20261122000200_report_schedules_saved_report_idx'];
const sql = (name: string) => readFileSync(join(process.cwd(), 'prisma', 'migrations', name, 'migration.sql'), 'utf8')
  .replace(/\r\n/g, '\n').replace(/--[^\n]*/g, '');
const [create, validate, index] = NAMES.map(sql);
const quoted = (text: string) => [...text.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
const columns = (table: string) => ((inventory.tables as Record<string, { name: string }[]>)[table] ?? []).map((c) => c.name);

describe('saved report migrations', () => {
  it('records a checksum for each migration', () => {
    for (const name of NAMES) expect((checksums as Record<string, string>)[name], name).toMatch(/^[0-9a-f]{64}$/);
  });

  it('creates a FORCE RLS table that only admins and owners write, and the worker only reads', () => {
    expect(create).toContain('ALTER TABLE analytics_saved_reports ENABLE ROW LEVEL SECURITY;');
    expect(create).toContain('ALTER TABLE analytics_saved_reports FORCE ROW LEVEL SECURITY;');
    expect(create).toMatch(/CREATE POLICY tenant_read ON analytics_saved_reports FOR SELECT TO bodhinox_app\s+USING \(account_id = app_account_id\(\) AND app_write_allowed\('admin'\)\);/);
    expect(create).toMatch(/CREATE POLICY tenant_write ON analytics_saved_reports FOR ALL TO bodhinox_app\s+USING \(account_id = app_account_id\(\) AND app_write_allowed\('admin'\)\)\s+WITH CHECK \(account_id = app_account_id\(\) AND app_write_allowed\('admin'\)\);/);
    expect(create).toMatch(/CREATE POLICY worker_read ON analytics_saved_reports FOR SELECT TO bodhinox_worker\s+USING \(account_id = app_account_id\(\)\);/);
    expect(create).toContain('GRANT SELECT ON analytics_saved_reports TO bodhinox_worker;');
    expect(create).not.toMatch(/GRANT [^;]*(INSERT|UPDATE|DELETE)[^;]*ON analytics_saved_reports TO bodhinox_worker/);
    expect(create).toContain('CREATE UNIQUE INDEX analytics_saved_reports_name_idx ON analytics_saved_reports (account_id, lower(name));');
  });

  it('keeps the SQL value lists in step with the app', () => {
    const table = create.slice(create.indexOf('CREATE TABLE analytics_saved_reports'), create.indexOf('CREATE UNIQUE INDEX'));
    const line = (column: string) => table.split('\n').find((l) => l.trim().startsWith(column)) ?? '';
    expect(quoted(table.slice(table.indexOf('metrics text[]'), table.indexOf('group_by')))).toEqual([...SAVED_METRICS]);
    expect(quoted(line('group_by'))).toEqual([...SAVED_GROUPS]);
    expect(quoted(line('channel')).filter((v) => v !== 'all').concat('all').sort()).toEqual([...SAVED_CHANNELS].sort());
    expect(quoted(line('range_preset'))).toEqual([...SAVED_RANGES]);
    expect(quoted(line('format')).filter((v, i, a) => a.indexOf(v) === i).sort()).toEqual([...SAVED_FORMATS].sort());
    for (const check of create.match(/CHECK \(kind IN \([^)]*\)\)/g) ?? []) expect(quoted(check)).toEqual([...RUN_KINDS]);
    expect(create.match(/CHECK \(kind IN/g)).toHaveLength(2);
  });

  it('adds constraints to existing tables NOT VALID and validates each later; builds the index concurrently', () => {
    const added = [...create.matchAll(/ADD CONSTRAINT (\w+)[\s\S]*?NOT VALID;/g)].map((m) => m[1]).sort();
    const validated = [...validate.matchAll(/VALIDATE CONSTRAINT (\w+)/g)].map((m) => m[1]).sort();
    expect(added).toEqual(validated);
    expect(added).toHaveLength(5);
    expect(index.trim()).toBe('CREATE UNIQUE INDEX CONCURRENTLY report_schedules_saved_report_idx ON report_schedules (account_id, saved_report_id) WHERE saved_report_id IS NOT NULL;');
    expect(create).toContain('ON DELETE CASCADE NOT VALID');
  });

  it('lists the new table and columns in the inventory and the Prisma schema', () => {
    expect(columns('analytics_saved_reports')).toEqual(['id', 'account_id', 'name', 'metrics', 'group_by', 'channel', 'range_preset', 'from_day',
      'to_day', 'format', 'created_by', 'created_at', 'updated_at']);
    expect(columns('report_schedules')).toEqual(expect.arrayContaining(['saved_report_id', 'minute_local']));
    const prisma = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');
    expect(prisma).toContain('model analytics_saved_reports {');
    expect(prisma).toMatch(/saved_report_id String\? @db\.Uuid/);
    expect(prisma).toMatch(/minute_local Int @db\.SmallInt @default\(0\)/);
  });
});
