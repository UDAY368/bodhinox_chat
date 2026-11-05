/**
 * Pure helpers for scripts/restore-drill.ts (Phase 15): argument parsing, the local-only target
 * guard and the report shape. They live under src/ so vitest collects their test.
 */
export const DRILL_CONTAINER = 'bodhinox-restore-drill';
export const DRILL_IMAGE = 'pgvector/pgvector:pg18';
export const DRILL_DATABASE = 'bodhinox_restore_drill';
export const DRILL_DEFAULT_PORT = 55433;
/** Created NOLOGIN before the restore, exactly as the foundation and platform migrations do, so ACLs restore. */
export const DRILL_ROLES = ['bodhinox_app', 'bodhinox_auth', 'bodhinox_worker', 'bodhinox_platform'] as const;
/** Row counts recorded in the report (counts only, never data). */
export const DRILL_COUNT_TABLES = ['accounts', 'account_memberships', 'auth_users', 'contacts', 'conversations', 'messages',
  'orders', 'appointments', 'broadcasts', 'jobs', 'outbound_intents', 'webhook_receipts', '_prisma_migrations'] as const;

export interface RestoreDrillArgs { dump: string | null; port: number; out: string | null; cleanup: boolean }

export class RestoreDrillArgsError extends Error {
  constructor(message: string) { super(message); this.name = 'RestoreDrillArgsError'; }
}

export const RESTORE_DRILL_USAGE = [
  'Usage: npx tsx scripts/restore-drill.ts --dump <file> [--port 55433] [--out <report.json>]',
  '       npx tsx scripts/restore-drill.ts --cleanup',
  'Restores a pg_dump (custom or plain format) into a local Docker container and records timings and row counts.',
].join('\n');

export function parseRestoreDrillArgs(argv: readonly string[]): RestoreDrillArgs {
  const args: RestoreDrillArgs = { dump: null, port: DRILL_DEFAULT_PORT, out: null, cleanup: false };
  for (let i = 0; i < argv.length; i++) {
    const eq = argv[i].startsWith('--') ? argv[i].indexOf('=') : -1;
    const [flag, inline] = eq > 0 ? [argv[i].slice(0, eq), argv[i].slice(eq + 1)] : [argv[i], undefined];
    const value = () => {
      const next = inline ?? argv[++i];
      if (next === undefined || next === '' || (inline === undefined && next.startsWith('--'))) throw new RestoreDrillArgsError(`${flag} needs a value`);
      return next;
    };
    switch (flag) {
      case '--dump': args.dump = value(); break;
      case '--out': args.out = value(); break;
      case '--port': {
        const raw = value();
        const port = /^\d{1,5}$/.test(raw) ? Number(raw) : NaN;
        if (!(port >= 1024 && port <= 65535)) throw new RestoreDrillArgsError('--port must be 1024-65535');
        args.port = port;
        break;
      }
      case '--cleanup': args.cleanup = true; break;
      default: throw new RestoreDrillArgsError(`Unknown argument ${flag}`);
    }
  }
  if (!args.cleanup && !args.dump) throw new RestoreDrillArgsError('--dump <file> is required');
  if (args.cleanup && args.dump) throw new RestoreDrillArgsError('--cleanup takes no other arguments');
  return args;
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
/** Refuses any connection URL that does not point at this machine. Never echoes the URL. */
export function assertLocalDrillUrl(name: string, value: string): void {
  let host: string;
  try { host = new URL(value).hostname; } catch { throw new Error(`${name} is not a valid connection URL`); }
  if (!LOCAL_HOSTS.has(host)) throw new Error(`${name} must point at the local drill container; refusing a non-local host`);
}

export function drillUrl(role: string, password: string, port: number): string {
  return `postgresql://${encodeURIComponent(role)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${DRILL_DATABASE}?sslmode=disable`;
}

/** pg_dump custom-format archives start with "PGDMP"; anything else is restored with psql. */
export function dumpFormat(head: Uint8Array): 'custom' | 'plain' {
  return Buffer.from(head.subarray(0, 5)).toString('latin1') === 'PGDMP' ? 'custom' : 'plain';
}

/** "; Archive created at 2026-11-05 10:11:12 UTC" from `pg_restore --list`, as an ISO time. */
export function archiveCreatedAt(listing: string): string | null {
  const match = /^;\s*Archive created at (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\s+(\S+))?/m.exec(listing);
  if (!match) return null;
  const zone = match[3] && /^(UTC|GMT|[+-]\d{2}(:?\d{2})?)$/i.test(match[3]) ? (/^(UTC|GMT)$/i.test(match[3]) ? 'Z' : match[3]) : 'Z';
  const parsed = new Date(`${match[1]}T${match[2]}${zone}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function defaultReportPath(now: Date): string {
  return `docs/testing/restore-drill-${now.toISOString().slice(0, 10)}.json`;
}

export interface RestoreDrillReport {
  drill: 'restore';
  ranAt: string;
  environment: { target: 'local-docker'; image: string; postgres: string | null };
  dump: { file: string; format: 'custom' | 'plain'; sizeBytes: number; createdAt: string | null; ageHours: number | null };
  timings: { containerS: number; restoreS: number; rolesS: number; totalS: number };
  restore: { exitCode: number; errorLines: number };
  migrateStatus: 'up-to-date' | 'behind-or-diverged' | 'error';
  preflight: 'pass' | 'fail';
  counts: Record<string, number | null>;
  tenantRead: 'pass' | 'fail' | 'no-accounts';
  result: 'pass' | 'fail';
}

/**
 * A drill passes when roles signed in (preflight), every counted table loaded, and a tenant-scoped
 * read worked (a dump with no accounts proves nothing). restore.exitCode and errorLines stay reported
 * fields, not gates: `pg_restore --no-owner` exits non-zero on benign ownership errors.
 */
export function drillResult(report: Omit<RestoreDrillReport, 'result'>): 'pass' | 'fail' {
  return report.preflight === 'pass' && report.migrateStatus !== 'error' && report.tenantRead === 'pass'
    && DRILL_COUNT_TABLES.every((table) => report.counts[table] != null) ? 'pass' : 'fail';
}
