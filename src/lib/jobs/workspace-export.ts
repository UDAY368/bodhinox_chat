// The workspace.export job and its expiry sweep (Phase 14).
//
// workspace.export (payload { exportId }): claims the queued row, then reads the
// workspace's own data domain by domain, page by page (keyset on the
// (account_id, id) indexes, 1000 rows per short worker-tenant transaction under
// withTenant, so RLS scopes every read to this workspace), writes one JSONL
// file per domain plus manifest.json into a zip that is streamed into private
// storage as it is built. Nothing is ever held in memory whole. Secrets,
// *_enc columns, tokens, hashes and similar credentials are removed from every
// row (EXCLUDED_COLUMN); no secret-bearing table (provider connections, API
// keys, auth tables) is exported at all. On success the row becomes ready with
// a 7-day window; a failure is retried by the queue and marked failed on the
// last attempt (the partial upload is aborted). Logs carry categories only.
//
// workspace.export_sweep (one per workspace from crm_accounts_with_exports_due,
// at most hourly): fails exports stuck queued/running for a day, then deletes
// expired files and marks their rows expired (rows are kept).

import { deflateRawSync, constants as zlibConstants, crc32 } from 'node:zlib';
import { Prisma } from '@prisma/client';

import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import {
  EXPORT_READY_DAYS,
  WORKSPACE_EXPORT_JOB,
  deleteExportFile,
  exportObjectKey,
  s3ExportSink,
  type ExportSink,
} from '@/lib/account/export';

export { WORKSPACE_EXPORT_JOB };
export const WORKSPACE_EXPORT_SWEEP_JOB = 'workspace.export_sweep';
export const EXPORT_PAGE_SIZE = 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ------------------------------------------------------------------ domains

/**
 * What is exported: tenant tables only, in a fixed allowlist (identifiers are
 * constants, never input). `key` is the keyset order; every key column is a uuid.
 */
export const EXPORT_DOMAINS = [
  { file: 'contacts', table: 'contacts', key: ['id'] },
  { file: 'contact_notes', table: 'contact_notes', key: ['id'] },
  { file: 'custom_fields', table: 'custom_fields', key: ['id'] },
  { file: 'contact_custom_values', table: 'contact_custom_values', key: ['id'] },
  { file: 'tags', table: 'tags', key: ['id'] },
  { file: 'contact_tags', table: 'contact_tags', key: ['id'] },
  { file: 'lists', table: 'contact_lists', key: ['id'] },
  { file: 'list_members', table: 'contact_list_members', key: ['contact_id', 'list_id'] },
  { file: 'segments', table: 'segments', key: ['id'] },
  { file: 'conversations', table: 'conversations', key: ['id'] },
  { file: 'messages', table: 'messages', key: ['id'] },
  { file: 'pipelines', table: 'pipelines', key: ['id'] },
  { file: 'pipeline_stages', table: 'pipeline_stages', key: ['id'] },
  { file: 'deals', table: 'deals', key: ['id'] },
  { file: 'flows', table: 'flows', key: ['id'] },
  { file: 'flow_versions', table: 'flow_versions', key: ['id'] },
  { file: 'automations', table: 'automations', key: ['id'] },
  { file: 'automation_steps', table: 'automation_steps', key: ['id'] },
  { file: 'templates', table: 'message_templates', key: ['id'] },
  { file: 'quick_replies', table: 'quick_replies', key: ['id'] },
  { file: 'catalogue_products', table: 'products', key: ['id'] },
  { file: 'shop_products', table: 'shop_products', key: ['id'] },
  { file: 'shop_variants', table: 'shop_variants', key: ['id'] },
  { file: 'orders', table: 'orders', key: ['id'] },
  { file: 'order_items', table: 'order_items', key: ['id'] },
  { file: 'appointments', table: 'appointments', key: ['id'] },
  { file: 'invoices', table: 'invoices', key: ['id'] },
] as const satisfies readonly { file: string; table: string; key: readonly string[] }[];

/**
 * Columns never exported: encrypted values, secrets, tokens, hashes, passwords,
 * one-time codes and internal object keys.
 */
export const EXCLUDED_COLUMN = /(_enc|_hash|_secret|secret|token|password|_code_hash|^hold_code$|_object_key$|^token_epoch$)/i;

/** A row as exported: excluded columns removed. */
export function sanitizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (!EXCLUDED_COLUMN.test(k)) out[k] = v;
  return out;
}

// ------------------------------------------------------------------ streaming zip

const DOS_EPOCH = { time: 0, date: (1 << 5) | 1 }; // 1980-01-01 00:00
const LIMIT_32 = 0xffffffff;

function dosDateTime(at: Date): { time: number; date: number } {
  if (at.getUTCFullYear() < 1980) return DOS_EPOCH;
  return {
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2),
    date: ((at.getUTCFullYear() - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  };
}

export class ExportTooLargeError extends Error {
  constructor() {
    super('export_too_large');
    this.name = 'ExportTooLargeError';
  }
}

/**
 * A minimal streaming zip writer (deflate, data descriptors, no ZIP64): each
 * entry's chunks are compressed as they arrive (independent sync-flushed raw
 * deflate segments, which concatenate into one valid stream) and handed to the
 * sink straight away. Only the small central directory is kept in memory.
 * Archives past 4 GiB are refused with ExportTooLargeError.
 */
export class StreamingZip {
  private offset = 0;
  private entries: { name: Buffer; crc: number; compressed: number; size: number; offset: number; time: number; date: number }[] = [];
  private current: { name: Buffer; crc: number; compressed: number; size: number; offset: number; time: number; date: number } | null = null;

  constructor(private readonly sink: ExportSink, private readonly at: Date = new Date()) {}

  private async emit(chunk: Buffer): Promise<void> {
    if (!chunk.byteLength) return;
    this.offset += chunk.byteLength;
    if (this.offset > LIMIT_32) throw new ExportTooLargeError();
    await this.sink.write(chunk);
  }

  async begin(name: string): Promise<void> {
    if (this.current) await this.end();
    const encoded = Buffer.from(name, 'utf8');
    const { time, date } = dosDateTime(this.at);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0x0808, 6); // data descriptor + UTF-8 names
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    // crc, sizes: 0 (in the data descriptor)
    header.writeUInt16LE(encoded.byteLength, 26);
    this.current = { name: encoded, crc: 0, compressed: 0, size: 0, offset: this.offset, time, date };
    await this.emit(Buffer.concat([header, encoded]));
  }

  async write(data: string | Buffer): Promise<void> {
    const entry = this.current;
    if (!entry) throw new Error('No open zip entry');
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    if (!bytes.byteLength) return;
    entry.crc = crc32(bytes, entry.crc);
    entry.size += bytes.byteLength;
    const compressed = deflateRawSync(bytes, { finishFlush: zlibConstants.Z_SYNC_FLUSH });
    entry.compressed += compressed.byteLength;
    if (entry.size > LIMIT_32) throw new ExportTooLargeError();
    await this.emit(compressed);
  }

  async end(): Promise<void> {
    const entry = this.current;
    if (!entry) return;
    // The final (empty) block closes the deflate stream.
    const last = deflateRawSync(Buffer.alloc(0));
    entry.compressed += last.byteLength;
    await this.emit(last);
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(entry.crc >>> 0, 4);
    descriptor.writeUInt32LE(entry.compressed, 8);
    descriptor.writeUInt32LE(entry.size, 12);
    await this.emit(descriptor);
    this.entries.push(entry);
    this.current = null;
  }

  /** Writes the central directory; the sink is not finished here. */
  async close(): Promise<void> {
    await this.end();
    const start = this.offset;
    for (const e of this.entries) {
      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014b50, 0);
      record.writeUInt16LE(20, 4); // made by
      record.writeUInt16LE(20, 6); // needed
      record.writeUInt16LE(0x0808, 8);
      record.writeUInt16LE(8, 10);
      record.writeUInt16LE(e.time, 12);
      record.writeUInt16LE(e.date, 14);
      record.writeUInt32LE(e.crc >>> 0, 16);
      record.writeUInt32LE(e.compressed, 20);
      record.writeUInt32LE(e.size, 24);
      record.writeUInt16LE(e.name.byteLength, 28);
      record.writeUInt32LE(e.offset, 42);
      await this.emit(Buffer.concat([record, e.name]));
    }
    const size = this.offset - start;
    if (this.entries.length > 0xffff) throw new ExportTooLargeError();
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(size, 12);
    eocd.writeUInt32LE(start, 16);
    await this.emit(eocd);
  }
}

// ------------------------------------------------------------------ the job

const worker = (accountId: string) => ({ accountId, role: 'owner' as const });

/** One domain written page by page; returns its row count. */
async function writeDomain(zip: StreamingZip, accountId: string, domain: (typeof EXPORT_DOMAINS)[number], pageSize: number): Promise<number> {
  await zip.begin(`${domain.file}.jsonl`);
  const table = Prisma.raw(`"${domain.table}"`);
  const keys = domain.key.map((k) => Prisma.raw(`t."${k}"`));
  const keyList = Prisma.join(keys, ', ');
  let cursor: string[] | null = null;
  let count = 0;
  for (;;) {
    const after: Prisma.Sql = cursor
      ? Prisma.sql`AND (${keyList}) > (${Prisma.join(cursor.map((v) => Prisma.sql`${v}::uuid`), ', ')})`
      : Prisma.empty;
    const rows = await withTenant(worker(accountId), (tx) => tx.$queryRaw<{ row: Record<string, unknown>; k: string[] }[]>(Prisma.sql`
      SELECT to_jsonb(t) AS row, ARRAY[${Prisma.join(domain.key.map((k) => Prisma.raw(`t."${k}"::text`)), ', ')}] AS k
      FROM ${table} t WHERE t.account_id=${accountId}::uuid ${after}
      ORDER BY ${keyList} LIMIT ${pageSize}`), getWorkerPrisma());
    if (!rows.length) break;
    await zip.write(rows.map((r) => `${JSON.stringify(sanitizeRow(r.row))}\n`).join(''));
    count += rows.length;
    cursor = rows[rows.length - 1].k;
    if (rows.length < pageSize) break;
  }
  await zip.end();
  return count;
}

/** Builds the whole archive into `sink` (finish/abort are the caller's). Exported for tests. */
export async function buildWorkspaceExport(accountId: string, exportId: string, sink: ExportSink,
  options: { pageSize?: number; now?: Date } = {}): Promise<Record<string, number>> {
  const now = options.now ?? new Date();
  const zip = new StreamingZip(sink, now);
  const counts: Record<string, number> = {};
  for (const domain of EXPORT_DOMAINS) counts[domain.file] = await writeDomain(zip, accountId, domain, options.pageSize ?? EXPORT_PAGE_SIZE);
  await zip.begin('manifest.json');
  await zip.write(JSON.stringify({
    format: 'bodhinox-workspace-export',
    version: 1,
    workspace_id: accountId,
    export_id: exportId,
    exported_at: now.toISOString(),
    encoding: 'One JSON object per line (JSONL), UTF-8. Timestamps are ISO 8601.',
    excluded: 'Credentials, tokens, password and code hashes, encrypted values and provider connections are never exported.',
    files: counts,
  }, null, 2));
  await zip.close();
  return counts;
}

async function markFailed(accountId: string, exportId: string, code: string): Promise<void> {
  await withTenant(worker(accountId), (tx) => tx.$executeRaw`UPDATE workspace_exports SET status='failed', error_code=${code}, completed_at=now()
    WHERE account_id=${accountId}::uuid AND id=${exportId}::uuid AND status IN ('queued','running')`, getWorkerPrisma());
}

/** The workspace.export job. `makeSink` is replaceable in tests. */
export async function runWorkspaceExportJob(accountId: string, payload: Record<string, unknown>,
  attempt: { attempts: number; maxAttempts: number } = { attempts: 1, maxAttempts: 1 },
  makeSink: (accountId: string, key: string) => ExportSink = s3ExportSink): Promise<void> {
  const exportId = typeof payload.exportId === 'string' && UUID.test(payload.exportId) ? payload.exportId : null;
  if (!exportId) throw new Error('Invalid workspace export job');
  const claimed = await withTenant(worker(accountId), (tx) => tx.$queryRaw<{ id: string }[]>`
    UPDATE workspace_exports SET status='running' WHERE account_id=${accountId}::uuid AND id=${exportId}::uuid
      AND status IN ('queued','running') RETURNING id::text AS id`, getWorkerPrisma());
  if (!claimed[0]) return; // Already finished, failed, expired or gone.
  const key = exportObjectKey(accountId, exportId);
  const sink = makeSink(accountId, key);
  let size: number;
  try {
    await buildWorkspaceExport(accountId, exportId, sink);
    size = await sink.finish();
  } catch (error) {
    await sink.abort().catch(() => undefined);
    const tooLarge = error instanceof ExportTooLargeError;
    // Category only: errors can carry SQL or storage details.
    console.error('[workspace-export] build failed', { attempt: attempt.attempts, tooLarge });
    if (tooLarge) return markFailed(accountId, exportId, 'export_too_large');
    if (attempt.attempts >= attempt.maxAttempts) await markFailed(accountId, exportId, 'build_failed');
    throw error;
  }
  const marked = await withTenant(worker(accountId), (tx) => tx.$executeRaw`UPDATE workspace_exports SET status='ready',
    storage_key=${key}, size_bytes=${size}, expires_at=now() + make_interval(days => ${EXPORT_READY_DAYS}::int), error_code=NULL, completed_at=now()
    WHERE account_id=${accountId}::uuid AND id=${exportId}::uuid AND status='running'`, getWorkerPrisma());
  if (marked === 0) {
    // The row left 'running' meanwhile (failed by the sweep or gone): remove the file just
    // written unless a concurrent run already made it ready.
    const now = await withTenant(worker(accountId), (tx) => tx.$queryRaw<{ status: string }[]>`
      SELECT status FROM workspace_exports WHERE account_id=${accountId}::uuid AND id=${exportId}::uuid`, getWorkerPrisma());
    if (now[0]?.status !== 'ready') await deleteExportFile(accountId, key).catch(() => undefined);
    return;
  }
  await withTenant(worker(accountId), (tx) => tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
    VALUES(${accountId}::uuid,NULL,'workspace.export_ready',${exportId},${JSON.stringify({ size_bytes: size })}::jsonb)`, getWorkerPrisma());
}

// ------------------------------------------------------------------ sweep

let lastSweepSchedule = Number.NEGATIVE_INFINITY;

/** Queues one sweep per workspace with an export to expire (or stuck), at most hourly; returns how many. */
export async function scheduleWorkspaceExportSweeps(now: number = Date.now(), force = false): Promise<number> {
  if (!force && now - lastSweepSchedule < SWEEP_INTERVAL_MS) return 0;
  const accounts = await getWorkerPrisma().$queryRaw<{ account_id: string }[]>`SELECT * FROM crm_accounts_with_exports_due()`;
  const slot = Math.floor(now / SWEEP_INTERVAL_MS);
  for (const { account_id } of accounts)
    await getWorkerPrisma().$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,max_attempts)
      VALUES(${WORKSPACE_EXPORT_SWEEP_JOB},${account_id}::uuid,'{}'::jsonb,${`workspace-export-sweep:${account_id}:${slot}`},2)
      ON CONFLICT(dedupe_key) DO NOTHING`;
  lastSweepSchedule = now;
  return accounts.length;
}

export function resetWorkspaceExportSweepForTests(): void {
  lastSweepSchedule = Number.NEGATIVE_INFINITY;
}

/** Fails exports stuck for a day, then deletes expired files and marks their rows expired. */
export async function runWorkspaceExportSweep(accountId: string,
  removeFile: (accountId: string, key: string) => Promise<void> = deleteExportFile): Promise<{ failed: number; expired: number }> {
  const failed = await withTenant(worker(accountId), (tx) => tx.$executeRaw`UPDATE workspace_exports SET status='failed', error_code='timed_out', completed_at=now()
    WHERE account_id=${accountId}::uuid AND status IN ('queued','running') AND created_at < now() - interval '1 day'`, getWorkerPrisma());
  const due = await withTenant(worker(accountId), (tx) => tx.$queryRaw<{ id: string; storage_key: string | null }[]>`
    SELECT id::text AS id, storage_key FROM workspace_exports
    WHERE account_id=${accountId}::uuid AND status='ready' AND expires_at <= now() ORDER BY expires_at LIMIT 500`, getWorkerPrisma());
  let expired = 0;
  for (const row of due) {
    // File first: a failed delete leaves the row for the next sweep.
    await removeFile(accountId, row.storage_key ?? exportObjectKey(accountId, row.id));
    expired += await withTenant(worker(accountId), (tx) => tx.$executeRaw`UPDATE workspace_exports SET status='expired', storage_key=NULL
      WHERE account_id=${accountId}::uuid AND id=${row.id}::uuid AND status='ready'`, getWorkerPrisma());
  }
  return { failed, expired };
}

/** Worker entry for both job types. */
export async function handleWorkspaceExportJob(
  accountId: string,
  type: string,
  payload: Record<string, unknown>,
  meta: { attempts: number; maxAttempts: number },
): Promise<void> {
  if (type === WORKSPACE_EXPORT_JOB) return runWorkspaceExportJob(accountId, payload, meta);
  if (type === WORKSPACE_EXPORT_SWEEP_JOB) {
    await runWorkspaceExportSweep(accountId);
    return;
  }
  throw new Error('Unsupported workspace export job type');
}
