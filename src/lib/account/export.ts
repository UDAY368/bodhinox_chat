// Workspace export, request side (Phase 14, Settings -> Privacy & access).
//
// Owners and admins request a full export of the workspace's own data; viewers
// and agents are refused. A user with MFA confirms the authenticator (or a
// recovery code) first. The workspace_exports row and its workspace.export job
// are committed in one tenant transaction (the report_runs pattern); one queued
// or running export per workspace (partial unique index). The job
// (src/lib/jobs/workspace-export.ts) streams JSONL per domain into a zip in
// private storage under <account_id>/exports/<export id>.zip; the file is
// downloadable through the signed-in download route for 7 days, then the job's
// own sweep deletes it and marks the row expired (the row is kept). Without the
// S3 configuration the request is refused with storage_not_configured. Every
// request and download is audit-logged.

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';

import { withTenant } from '@/lib/db/tenant';
import type { AuthContext } from '@/lib/auth/session';
import { hasMinRole } from '@/lib/auth/roles';
import { AccountActionError, confirmStepUp } from './deletion';

export const WORKSPACE_EXPORT_JOB = 'workspace.export';
export const EXPORT_READY_DAYS = 7;
export const EXPORT_LIST_LIMIT = 10;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^([0-9a-f-]{36})\/exports\/([0-9a-f-]{36})\.zip$/;
const S3_VARS = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const;

export type ExportStatus = 'queued' | 'running' | 'ready' | 'failed' | 'expired';

export interface WorkspaceExport {
  id: string;
  status: ExportStatus;
  sizeBytes: number | null;
  expiresAt: string | null;
  errorCode: string | null;
  createdAt: string;
  completedAt: string | null;
}

type ExportRow = {
  id: string; status: ExportStatus; size_bytes: bigint | null; expires_at: Date | null;
  error_code: string | null; created_at: Date; completed_at: Date | null;
};

const toExport = (r: ExportRow): WorkspaceExport => ({
  id: r.id,
  status: r.status,
  sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
  expiresAt: r.expires_at?.toISOString() ?? null,
  errorCode: r.error_code,
  createdAt: r.created_at.toISOString(),
  completedAt: r.completed_at?.toISOString() ?? null,
});

const tenant = (context: AuthContext) => ({ accountId: context.accountId, userId: context.userId, role: context.role });

function assertAdmin(context: AuthContext): void {
  if (!hasMinRole(context.role, 'admin')) throw new AccountActionError('admin_required', 403);
}

/** Whether private object storage is configured (the export needs it). */
export function exportStorageConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return S3_VARS.every((name) => !!env[name]);
}

/** Records an export request and queues its job in one transaction. */
export async function requestWorkspaceExport(context: AuthContext, input: { mfaCode?: string }): Promise<WorkspaceExport> {
  assertAdmin(context);
  if (!exportStorageConfigured()) throw new AccountActionError('storage_not_configured', 503);
  await confirmStepUp(context, { mfaCode: input.mfaCode }, { identity: false });
  return withTenant(tenant(context), async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`workspace-export:${context.accountId}`}, 0))`;
    const open = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM workspace_exports
      WHERE account_id=${context.accountId}::uuid AND status IN ('queued','running') LIMIT 1`;
    if (open[0]) throw new AccountActionError('export_in_progress', 409);
    const inserted = await tx.$queryRaw<ExportRow[]>`INSERT INTO workspace_exports(account_id, requested_by, status)
      VALUES (${context.accountId}::uuid, ${context.userId}::uuid, 'queued')
      RETURNING id::text AS id, status, size_bytes, expires_at, error_code, created_at, completed_at`;
    const row = inserted[0];
    await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,max_attempts)
      VALUES(${WORKSPACE_EXPORT_JOB},${context.accountId}::uuid,${JSON.stringify({ exportId: row.id })}::jsonb,${`workspace-export:${row.id}`},3)`;
    await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
      VALUES(${context.accountId}::uuid,${context.userId}::uuid,'workspace.export_requested',${row.id},'{}'::jsonb)`;
    return toExport(row);
  });
}

/** The workspace's latest exports, newest first (owners and admins). */
export async function listWorkspaceExports(context: AuthContext): Promise<WorkspaceExport[]> {
  assertAdmin(context);
  const rows = await withTenant(tenant(context), (tx) => tx.$queryRaw<ExportRow[]>`
    SELECT id::text AS id, status, size_bytes, expires_at, error_code, created_at, completed_at FROM workspace_exports
    WHERE account_id=${context.accountId}::uuid ORDER BY created_at DESC, id LIMIT ${EXPORT_LIST_LIMIT}`);
  return rows.map(toExport);
}

/**
 * Authorises one download and audit-logs it in the same transaction. Returns the
 * private object key; the caller streams the file. Anything but a live ready export
 * is refused (404 unknown or another workspace's, 409 not ready or expired).
 */
export async function openWorkspaceExportDownload(context: AuthContext, exportId: string): Promise<{ objectKey: string; filename: string }> {
  assertAdmin(context);
  if (!UUID.test(exportId)) throw new AccountActionError('export_not_found', 404);
  return withTenant(tenant(context), async (tx) => {
    const rows = await tx.$queryRaw<{ status: ExportStatus; storage_key: string | null; live: boolean; created_at: Date }[]>`
      SELECT status, storage_key, COALESCE(expires_at > now(), false) AS live, created_at FROM workspace_exports
      WHERE account_id=${context.accountId}::uuid AND id=${exportId}::uuid`;
    const row = rows[0];
    if (!row) throw new AccountActionError('export_not_found', 404);
    if (row.status !== 'ready' || !row.storage_key || !row.live) throw new AccountActionError('export_not_ready', 409);
    await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
      VALUES(${context.accountId}::uuid,${context.userId}::uuid,'workspace.export_downloaded',${exportId},'{}'::jsonb)`;
    return { objectKey: row.storage_key, filename: `workspace-export-${row.created_at.toISOString().slice(0, 10)}.zip` };
  });
}

// ------------------------------------------------------------------ private storage

let client: S3Client | undefined;
function s3(): S3Client {
  for (const name of S3_VARS) if (!process.env[name]) throw new Error(`Missing required configuration: ${name}`);
  client ??= new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION || 'auto',
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! },
  });
  return client;
}

/** The deterministic key of an export file: <account_id>/exports/<export id>.zip. */
export function exportObjectKey(accountId: string, exportId: string): string {
  if (!UUID.test(accountId) || !UUID.test(exportId)) throw new Error('Invalid export identity');
  return `${accountId.toLowerCase()}/exports/${exportId.toLowerCase()}.zip`;
}

/** A stored key must belong to this workspace; anything else is refused. */
function assertOwnKey(accountId: string, key: string): void {
  const match = KEY.exec(key);
  if (!match || match[1] !== accountId.toLowerCase()) throw new Error('Export file belongs to another workspace');
}

export async function getExportFile(accountId: string, key: string): Promise<ReadableStream<Uint8Array>> {
  assertOwnKey(accountId, key);
  const object = await s3().send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
  if (!object.Body) throw new Error('Export file is empty');
  return object.Body.transformToWebStream() as ReadableStream<Uint8Array>;
}

/** Deleting a missing object succeeds (S3 semantics), so the sweep can repeat safely. */
export async function deleteExportFile(accountId: string, key: string): Promise<void> {
  assertOwnKey(accountId, key);
  await s3().send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
}

/** Where the export job writes the zip, chunk by chunk. */
export interface ExportSink {
  write(chunk: Uint8Array): Promise<void>;
  /** Completes the object; returns its size in bytes. */
  finish(): Promise<number>;
  /** Discards everything written (best effort). */
  abort(): Promise<void>;
}

/** S3 parts other than the last must be at least 5 MiB; 8 MiB keeps memory bounded per export. */
export const EXPORT_PART_BYTES = 8 * 1024 * 1024;

/**
 * Streams the zip into private storage as a multipart upload: at most one part is
 * held in memory at a time, so an export of any size never sits in memory whole.
 */
export function s3ExportSink(accountId: string, key: string): ExportSink {
  assertOwnKey(accountId, key);
  const bucket = process.env.S3_BUCKET;
  let uploadId: string | undefined;
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let total = 0;
  const parts: { ETag: string | undefined; PartNumber: number }[] = [];
  const start = async () => {
    if (uploadId) return uploadId;
    const created = await s3().send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: 'application/zip' }));
    if (!created.UploadId) throw new Error('Export upload could not start');
    uploadId = created.UploadId;
    return uploadId;
  };
  const flush = async () => {
    const id = await start();
    const body = Buffer.concat(pending, pendingBytes);
    pending = [];
    pendingBytes = 0;
    const partNumber = parts.length + 1;
    const uploaded = await s3().send(new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: id, PartNumber: partNumber, Body: body }));
    parts.push({ ETag: uploaded.ETag, PartNumber: partNumber });
  };
  return {
    async write(chunk) {
      if (!chunk.byteLength) return;
      pending.push(chunk);
      pendingBytes += chunk.byteLength;
      total += chunk.byteLength;
      if (pendingBytes >= EXPORT_PART_BYTES) await flush();
    },
    async finish() {
      if (pendingBytes > 0 || parts.length === 0) await flush();
      await s3().send(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts } }));
      return total;
    },
    async abort() {
      pending = [];
      if (uploadId) await s3().send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId })).catch(() => undefined);
    },
  };
}
