import { describe, expect, it } from 'vitest';
import {
  archiveCreatedAt, assertLocalDrillUrl, defaultReportPath, DRILL_COUNT_TABLES, DRILL_DEFAULT_PORT, drillResult, drillUrl, dumpFormat,
  parseRestoreDrillArgs, RestoreDrillArgsError,
} from './restore-drill-args';

describe('[OPS-01] restore drill arguments and guards', () => {
  it('parses --dump, --port, --out and --cleanup', () => {
    expect(parseRestoreDrillArgs(['--dump', 'staging.dump'])).toEqual({ dump: 'staging.dump', port: DRILL_DEFAULT_PORT, out: null, cleanup: false });
    expect(parseRestoreDrillArgs(['--dump=a b.dump', '--port', '6000', '--out=r.json'])).toEqual({ dump: 'a b.dump', port: 6000, out: 'r.json', cleanup: false });
    expect(parseRestoreDrillArgs(['--cleanup'])).toEqual({ dump: null, port: DRILL_DEFAULT_PORT, out: null, cleanup: true });
  });

  it('rejects missing values, bad ports, unknown flags and mixed cleanup', () => {
    for (const argv of [[], ['--dump'], ['--dump', '--port'], ['--dump', 'x', '--port', '80'], ['--dump', 'x', '--port', '1e4'],
      ['--dump', 'x', '--host', 'db.example.com'], ['--cleanup', '--dump', 'x'], ['x.dump']]) {
      expect(() => parseRestoreDrillArgs(argv)).toThrow(RestoreDrillArgsError);
    }
  });

  it('builds local URLs and refuses any other host without echoing the URL', () => {
    const url = drillUrl('bodhinox_app', 'p@ss/word', 55433);
    expect(new URL(url).hostname).toBe('127.0.0.1');
    expect(decodeURIComponent(new URL(url).password)).toBe('p@ss/word');
    expect(() => assertLocalDrillUrl('DATABASE_URL', url)).not.toThrow();
    expect(() => assertLocalDrillUrl('DATABASE_URL', 'postgresql://u:p@[::1]:5432/x')).not.toThrow();
    for (const remote of ['postgresql://u:secretpw@db.railway.internal:5432/x', 'postgresql://u:p@10.0.0.5/x', 'nonsense']) {
      let message = '';
      try { assertLocalDrillUrl('DATABASE_URL', remote); } catch (error) { message = (error as Error).message; }
      expect(message).toMatch(/DATABASE_URL/);
      expect(message).not.toMatch(/secretpw|railway|10\.0\.0\.5/);
    }
  });

  it('detects the dump format and the archive time', () => {
    expect(dumpFormat(Buffer.from('PGDMP\x01\x10'))).toBe('custom');
    expect(dumpFormat(Buffer.from('--\n-- PostgreSQL'))).toBe('plain');
    expect(archiveCreatedAt(';\n; Archive created at 2026-11-05 10:11:12 UTC\n;     dbname: x')).toBe('2026-11-05T10:11:12.000Z');
    expect(archiveCreatedAt('; Archive created at 2026-11-05 10:11:12 +05:30')).toBe('2026-11-05T04:41:12.000Z');
    expect(archiveCreatedAt('no header')).toBeNull();
    expect(defaultReportPath(new Date('2026-11-05T23:00:00Z'))).toBe('docs/testing/restore-drill-2026-11-05.json');
  });

  it('passes only when preflight, migrate status, counts and the tenant read all worked', () => {
    const base = { drill: 'restore' as const, ranAt: '', environment: { target: 'local-docker' as const, image: '', postgres: null },
      dump: { file: 'x', format: 'custom' as const, sizeBytes: 1, createdAt: null, ageHours: null },
      timings: { containerS: 0, restoreS: 0, rolesS: 0, totalS: 0 }, restore: { exitCode: 0, errorLines: 0 },
      migrateStatus: 'up-to-date' as const, preflight: 'pass' as const,
      counts: Object.fromEntries(DRILL_COUNT_TABLES.map((t) => [t, 2])) as Record<string, number | null>, tenantRead: 'pass' as const };
    expect(drillResult(base)).toBe('pass');
    expect(drillResult({ ...base, migrateStatus: 'behind-or-diverged' })).toBe('pass');
    expect(drillResult({ ...base, tenantRead: 'fail' })).toBe('fail');
    expect(drillResult({ ...base, preflight: 'fail' })).toBe('fail');
    expect(drillResult({ ...base, counts: { ...base.counts, accounts: null } })).toBe('fail');
    expect(drillResult({ ...base, counts: { ...base.counts, messages: null } })).toBe('fail'); // a partly loaded dump
    expect(drillResult({ ...base, tenantRead: 'no-accounts' })).toBe('fail');
    expect(drillResult({ ...base, restore: { exitCode: 1, errorLines: 3 } })).toBe('pass'); // benign --no-owner errors
    expect(drillResult({ ...base, migrateStatus: 'error' })).toBe('fail');
  });
});
