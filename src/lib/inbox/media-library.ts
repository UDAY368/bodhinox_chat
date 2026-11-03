// ============================================================
// Media library: files an agent uploaded for reuse in the inbox.
// Rows live in media_objects (in_library = true) under the chat-media
// bucket; the bytes stay behind the private /api/media/object proxy.
//
// Deleting respects retention. A file that a message sent in the last
// MEDIA_REFERENCE_DAYS days, a template, flow, automation, quick reply,
// product, form or a queued/running campaign dispatch still points at is
// only hidden from the library; its object stays so those sends keep
// working. Anything else is removed.
// ============================================================

import { Prisma } from '@prisma/client';

import { hasMinRole, type AccountRole } from '@/lib/auth/roles';
import type { TenantTransaction } from '@/lib/db/tenant';
import { getEntitlements } from '@/lib/billing/entitlements';
import { mediaObjectUrl } from '@/lib/storage/client';

export const MEDIA_LIBRARY_BUCKET = 'chat-media';
export const MEDIA_LIBRARY_SUBFOLDER = 'library';
export const MEDIA_LIBRARY_KINDS = ['image', 'video', 'audio', 'document'] as const;
export type MediaKind = (typeof MEDIA_LIBRARY_KINDS)[number];
/** A message sent within this many days keeps its media from being deleted. */
export const MEDIA_REFERENCE_DAYS = 30;
export const MEDIA_LIBRARY_PAGE_SIZE = 30;
export const MEDIA_LIBRARY_MAX_PAGE_SIZE = 100;
export const MEDIA_FILENAME_MAX = 200;
export const MEDIA_SEARCH_MAX = 100;

export type MediaReferenceSource = 'message' | 'template' | 'flow' | 'automation' | 'quick_reply' | 'product' | 'form' | 'campaign';

export interface MediaLibraryItem {
  id: string;
  url: string;
  kind: MediaKind;
  filename: string;
  content_type: string;
  byte_size: number;
  uploaded_by: string | null;
  created_at: string;
  /** Whether the current viewer may delete it (admins, or the uploader). */
  can_delete: boolean;
}

export interface MediaLibraryPage {
  items: MediaLibraryItem[];
  next_cursor: string | null;
}

export interface MediaStorageUsage {
  /** Every stored, non-deleted object in the workspace. */
  used_bytes: number;
  library_bytes: number;
  library_count: number;
  /** No plan sets a storage cap yet, so this is always null (unlimited). */
  limit_bytes: number | null;
}

export interface MediaListQuery {
  kind: MediaKind | null;
  q: string | null;
  cursor: { createdAt: string; id: string } | null;
  limit: number;
}

export interface Viewer {
  userId?: string;
  role?: AccountRole;
}

export class MediaLibraryError extends Error {
  constructor(message: string, public code: string, public status = 400) {
    super(message);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isMediaId = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

export function mediaKindOf(contentType: string): MediaKind {
  const type = contentType.split(';')[0].trim().toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  return 'document';
}

// The cursor keeps PostgreSQL's own microsecond timestamp text; a JS Date
// would round to milliseconds and skip rows created in the same millisecond.
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:\d{2})?|Z)?$/;

export function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(value: string): { createdAt: string; id: string } | null {
  if (!value || value.length > 200) return null;
  const [createdAt, id, extra] = Buffer.from(value, 'base64url').toString('utf8').split('|');
  return extra === undefined && CURSOR_TIME.test(createdAt ?? '') && isMediaId(id) ? { createdAt, id } : null;
}

export function parseListQuery(params: URLSearchParams): MediaListQuery {
  const kind = params.get('kind');
  if (kind && !(MEDIA_LIBRARY_KINDS as readonly string[]).includes(kind)) throw new MediaLibraryError('Unknown media kind', 'invalid_kind');
  const rawCursor = params.get('cursor');
  const cursor = rawCursor ? decodeCursor(rawCursor) : null;
  if (rawCursor && !cursor) throw new MediaLibraryError('Invalid cursor', 'invalid_cursor');
  const rawLimit = params.get('limit');
  const limit = rawLimit === null ? MEDIA_LIBRARY_PAGE_SIZE : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MEDIA_LIBRARY_MAX_PAGE_SIZE) throw new MediaLibraryError('Invalid page size', 'invalid_limit');
  const q = (params.get('q') ?? '').trim().slice(0, MEDIA_SEARCH_MAX);
  return { kind: (kind as MediaKind) || null, q: q || null, cursor, limit };
}

/** A display name for the stored file: path segments and control characters removed, length capped. */
export function cleanFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, MEDIA_FILENAME_MAX);
  return clean || 'file';
}

export function canDeleteMedia(viewer: Viewer, uploadedBy: string | null): boolean {
  if (!viewer.role || !hasMinRole(viewer.role, 'agent')) return false;
  return hasMinRole(viewer.role, 'admin') || (!!viewer.userId && viewer.userId === uploadedBy);
}

interface MediaRow {
  id: string;
  bucket: string;
  object_key: string;
  content_type: string;
  byte_size: bigint | number;
  original_name: string | null;
  uploaded_by: string | null;
  created_at: Date;
  cursor_at?: string;
}

function toItem(row: MediaRow, viewer: Viewer): MediaLibraryItem {
  return {
    id: row.id,
    url: mediaObjectUrl(row.bucket, row.object_key),
    kind: mediaKindOf(row.content_type),
    filename: row.original_name || row.object_key.split('/').pop() || 'file',
    content_type: row.content_type,
    byte_size: Number(row.byte_size),
    uploaded_by: row.uploaded_by,
    created_at: row.created_at.toISOString(),
    can_delete: canDeleteMedia(viewer, row.uploaded_by),
  };
}

const KIND_FILTER: Record<MediaKind, Prisma.Sql> = {
  image: Prisma.sql`AND content_type LIKE 'image/%'`,
  video: Prisma.sql`AND content_type LIKE 'video/%'`,
  audio: Prisma.sql`AND content_type LIKE 'audio/%'`,
  document: Prisma.sql`AND content_type NOT LIKE 'image/%' AND content_type NOT LIKE 'video/%' AND content_type NOT LIKE 'audio/%'`,
};

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Newest first, keyset-paginated on (created_at, id). */
export async function listLibraryMedia(tx: TenantTransaction, accountId: string, query: MediaListQuery, viewer: Viewer): Promise<MediaLibraryPage> {
  const rows = await tx.$queryRaw<MediaRow[]>`
    SELECT id, bucket, object_key, content_type, byte_size, original_name, uploaded_by, created_at,
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
    FROM media_objects
    WHERE account_id=${accountId}::uuid AND in_library AND deleted_at IS NULL
      ${query.kind ? KIND_FILTER[query.kind] : Prisma.empty}
      ${query.q ? Prisma.sql`AND original_name ILIKE ${`%${escapeLike(query.q)}%`}` : Prisma.empty}
      ${query.cursor ? Prisma.sql`AND (created_at, id) < (${query.cursor.createdAt}::timestamptz, ${query.cursor.id}::uuid)` : Prisma.empty}
    ORDER BY created_at DESC, id DESC
    LIMIT ${query.limit + 1}`;
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((row) => toItem(row, viewer)),
    next_cursor: rows.length > query.limit && last?.cursor_at ? encodeCursor(last.cursor_at, last.id) : null,
  };
}

/** Marks an object this request just stored as a library item and records its display name. */
export async function addToLibrary(tx: TenantTransaction, accountId: string, objectKey: string, filename: string, viewer: Viewer): Promise<MediaLibraryItem> {
  const rows = await tx.$queryRaw<MediaRow[]>`
    UPDATE media_objects SET in_library=true, original_name=${cleanFilename(filename)}
    WHERE account_id=${accountId}::uuid AND bucket=${MEDIA_LIBRARY_BUCKET} AND object_key=${objectKey} AND deleted_at IS NULL
    RETURNING id, bucket, object_key, content_type, byte_size, original_name, uploaded_by, created_at`;
  if (!rows[0]) throw new MediaLibraryError('Media not found', 'not_found', 404);
  return toItem(rows[0], viewer);
}

export async function getStorageUsage(tx: TenantTransaction, accountId: string): Promise<MediaStorageUsage> {
  const rows = await tx.$queryRaw<{ used: bigint | null; library: bigint | null; count: bigint }[]>`
    SELECT COALESCE(SUM(byte_size),0) AS used,
      COALESCE(SUM(byte_size) FILTER (WHERE in_library),0) AS library,
      COUNT(*) FILTER (WHERE in_library) AS count
    FROM media_objects WHERE account_id=${accountId}::uuid AND deleted_at IS NULL`;
  const row = rows[0];
  // The plan's media storage (null = unlimited).
  const limit = (await getEntitlements(tx, accountId)).limits.storage_bytes;
  return { used_bytes: Number(row?.used ?? 0), library_bytes: Number(row?.library ?? 0), library_count: Number(row?.count ?? 0), limit_bytes: limit };
}

/**
 * Which kinds of record still point at this object. A reference is any
 * stored text containing the object's proxy URL or its raw key, so an
 * absolute URL or a JSON config that embeds either one is found too.
 */
export async function findMediaReferences(tx: TenantTransaction, accountId: string, bucket: string, objectKey: string, now = new Date()): Promise<MediaReferenceSource[]> {
  const url = mediaObjectUrl(bucket, objectKey);
  const since = new Date(now.getTime() - MEDIA_REFERENCE_DAYS * 86_400_000);
  const has = (column: Prisma.Sql) => Prisma.sql`(strpos(COALESCE(${column},''), ${url}) > 0 OR strpos(COALESCE(${column},''), ${objectKey}) > 0)`;
  const rows = await tx.$queryRaw<{ source: MediaReferenceSource }[]>`
    SELECT 'message' AS source WHERE EXISTS (SELECT 1 FROM messages WHERE account_id=${accountId}::uuid AND created_at >= ${since}
      AND (${has(Prisma.sql`media_url`)} OR ${has(Prisma.sql`interactive_payload::text`)}))
    UNION ALL SELECT 'template' WHERE EXISTS (SELECT 1 FROM message_templates WHERE account_id=${accountId}::uuid
      AND (${has(Prisma.sql`header_media_url`)} OR ${has(Prisma.sql`cards::text`)}))
    UNION ALL SELECT 'flow' WHERE EXISTS (SELECT 1 FROM flow_nodes WHERE account_id=${accountId}::uuid AND ${has(Prisma.sql`config::text`)})
    UNION ALL SELECT 'automation' WHERE EXISTS (SELECT 1 FROM automation_steps WHERE account_id=${accountId}::uuid AND ${has(Prisma.sql`step_config::text`)})
    UNION ALL SELECT 'quick_reply' WHERE EXISTS (SELECT 1 FROM quick_replies WHERE account_id=${accountId}::uuid AND ${has(Prisma.sql`interactive_payload::text`)})
    UNION ALL SELECT 'product' WHERE EXISTS (SELECT 1 FROM products WHERE account_id=${accountId}::uuid AND ${has(Prisma.sql`image_url`)})
    UNION ALL SELECT 'product' WHERE EXISTS (SELECT 1 FROM shop_product_images i WHERE i.account_id=${accountId}::uuid AND (${has(Prisma.sql`i.url`)}
      OR EXISTS (SELECT 1 FROM media_objects m WHERE m.account_id=i.account_id AND m.id=i.media_id AND m.bucket=${bucket} AND m.object_key=${objectKey})))
    UNION ALL SELECT 'form' WHERE EXISTS (SELECT 1 FROM whatsapp_forms WHERE account_id=${accountId}::uuid AND ${has(Prisma.sql`definition::text`)})
    UNION ALL SELECT 'campaign' WHERE EXISTS (SELECT 1 FROM jobs WHERE tenant_id=${accountId}::uuid AND type='broadcast.dispatch'
      AND status IN ('pending','running') AND ${has(Prisma.sql`payload::text`)})`;
  return [...new Set(rows.map((row) => row.source))];
}

export type DeleteDecision =
  | { outcome: 'hidden'; references: MediaReferenceSource[]; retained: boolean }
  | { outcome: 'remove'; bucket: string; objectKey: string };

/**
 * Locks the library row, checks the viewer may delete it, then either hides
 * it (still referenced or under a retention date) or soft-deletes it so the
 * caller can remove the stored object after the transaction commits.
 */
export async function prepareLibraryDelete(tx: TenantTransaction, accountId: string, id: string, viewer: Viewer, now = new Date()): Promise<DeleteDecision> {
  if (!isMediaId(id)) throw new MediaLibraryError('Media not found', 'not_found', 404);
  const rows = await tx.$queryRaw<{ bucket: string; object_key: string; uploaded_by: string | null; retain_until: Date | null }[]>`
    SELECT bucket, object_key, uploaded_by, retain_until FROM media_objects
    WHERE account_id=${accountId}::uuid AND id=${id}::uuid AND in_library AND deleted_at IS NULL FOR UPDATE`;
  const row = rows[0];
  if (!row) throw new MediaLibraryError('Media not found', 'not_found', 404);
  if (!canDeleteMedia(viewer, row.uploaded_by)) throw new MediaLibraryError('Only an admin or the uploader can delete this file', 'forbidden', 403);
  const references = await findMediaReferences(tx, accountId, row.bucket, row.object_key, now);
  const retained = !!row.retain_until && row.retain_until > now;
  if (references.length || retained) {
    await tx.$executeRaw`UPDATE media_objects SET in_library=false WHERE account_id=${accountId}::uuid AND id=${id}::uuid`;
    return { outcome: 'hidden', references, retained };
  }
  await tx.$executeRaw`UPDATE media_objects SET in_library=false, deleted_at=${now} WHERE account_id=${accountId}::uuid AND id=${id}::uuid`;
  return { outcome: 'remove', bucket: row.bucket, objectKey: row.object_key };
}

/**
 * Guard for the generic /api/media/object route, which deletes or overwrites
 * stored objects by key. It may not reach around the library's own delete
 * rules: library and mirrored inbound folders are off limits, and an existing
 * object can be changed only by an admin or its uploader, only when it is not
 * a library item, not under a retention date and not referenced by anything.
 */
export async function assertDirectObjectChange(tx: TenantTransaction, accountId: string, bucket: string, objectKey: string, viewer: Viewer, now = new Date()): Promise<void> {
  const root = `account-${accountId}/`;
  if (objectKey.startsWith(`${root}${MEDIA_LIBRARY_SUBFOLDER}/`) || objectKey.startsWith(`${root}inbound/`))
    throw new MediaLibraryError('Library and inbound media can only be changed through the media library', 'forbidden', 403);
  const rows = await tx.$queryRaw<{ uploaded_by: string | null; in_library: boolean; retain_until: Date | null }[]>`
    SELECT uploaded_by, in_library, retain_until FROM media_objects
    WHERE account_id=${accountId}::uuid AND bucket=${bucket} AND object_key=${objectKey} AND deleted_at IS NULL FOR UPDATE`;
  const row = rows[0];
  if (!row) return;
  if (row.in_library) throw new MediaLibraryError('Library media can only be changed through the media library', 'forbidden', 403);
  if (!canDeleteMedia(viewer, row.uploaded_by)) throw new MediaLibraryError('Only an admin or the uploader can change this file', 'forbidden', 403);
  if (row.retain_until && row.retain_until > now) throw new MediaLibraryError('This file is retained', 'retained', 409);
  if ((await findMediaReferences(tx, accountId, bucket, objectKey, now)).length) throw new MediaLibraryError('This file is still in use', 'in_use', 409);
}
