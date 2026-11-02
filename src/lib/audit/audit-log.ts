import { withTenant, type TenantContext } from '@/lib/db/tenant';

/**
 * Read side of audit_logs for the admin viewer (Settings → Audit log).
 *
 * RLS already limits reads to the caller's workspace and to admins/owners.
 * Rows are newest first with keyset pagination. Only a fixed projection
 * leaves: metadata is reduced to flat key/value pairs whose values are
 * numbers, booleans or short identifier-like strings, so free text, e-mail
 * addresses, message bodies or nested payloads never reach the browser.
 */

export const AUDIT_PAGE_DEFAULT = 50;
export const AUDIT_PAGE_MAX = 100;

export interface AuditEntry {
  id: string;
  action: string;
  actor: { user_id: string; name: string | null } | null;
  resource_id: string | null;
  metadata: Record<string, string | number | boolean | null>;
  created_at: string;
}

export interface AuditQuery {
  actor?: string;
  /** Exact action, or a prefix when it ends with '.' (e.g. "team."). */
  action?: string;
  from?: Date;
  to?: Date;
  /** at: the row's created_at as PostgreSQL text (microsecond precision). */
  cursor?: { at: string; id: string };
  limit: number;
}

export class AuditQueryError extends Error {
  constructor() {
    super('invalid_query');
    this.name = 'AuditQueryError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTION = /^[a-z0-9_.]{1,64}$/;
const SAFE_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const SAFE_VALUE = /^[A-Za-z0-9_.:-]{0,64}$/;
const MAX_METADATA_KEYS = 20;

/** Flat, identifier-only metadata; anything else is dropped. */
export function safeMetadata(value: unknown): AuditEntry['metadata'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: AuditEntry['metadata'] = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_METADATA_KEYS) break;
    if (!SAFE_KEY.test(key)) continue;
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[key] = v;
    else if (typeof v === 'string' && SAFE_VALUE.test(v)) out[key] = v;
  }
  return out;
}

export const safeResourceId = (value: string | null): string | null =>
  value && value.length <= 64 && SAFE_VALUE.test(value) ? value : null;

const CURSOR_AT = /^\d{4}-\d{2}-\d{2}[ T][0-9:.]{8,15}(Z|[+-]\d{2}(:?\d{2})?)?$/;

export function encodeCursor(at: string, id: string): string {
  return Buffer.from(`${at}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): { at: string; id: string } {
  const [at, id, extra] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  if (extra !== undefined || !CURSOR_AT.test(at ?? '') || !UUID.test(id ?? '')) throw new AuditQueryError();
  return { at, id: id.toLowerCase() };
}

function parseDate(raw: string | null): Date | undefined {
  if (!raw) return undefined;
  if (raw.length > 40) throw new AuditQueryError();
  const at = new Date(raw);
  if (!Number.isFinite(at.getTime())) throw new AuditQueryError();
  return at;
}

export function parseAuditQuery(params: URLSearchParams): AuditQuery {
  const actor = params.get('actor') || undefined;
  if (actor && !UUID.test(actor)) throw new AuditQueryError();
  const action = params.get('action') || undefined;
  if (action && !ACTION.test(action)) throw new AuditQueryError();
  const from = parseDate(params.get('from'));
  const to = parseDate(params.get('to'));
  if (from && to && from > to) throw new AuditQueryError();
  const cursorRaw = params.get('cursor');
  if (cursorRaw && cursorRaw.length > 200) throw new AuditQueryError();
  const limitRaw = params.get('limit');
  const limit = limitRaw === null ? AUDIT_PAGE_DEFAULT : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > AUDIT_PAGE_MAX) throw new AuditQueryError();
  return { actor: actor?.toLowerCase(), action, from, to, cursor: cursorRaw ? decodeCursor(cursorRaw) : undefined, limit };
}

type Row = { id: string; at_key: string; action: string; user_id: string | null; name: string | null; resource_id: string | null; metadata: unknown; created_at: Date };

export async function listAuditLog(
  tenant: TenantContext,
  query: AuditQuery,
): Promise<{ entries: AuditEntry[]; next_cursor: string | null; actions?: string[] }> {
  const prefix = query.action?.endsWith('.') ? `${query.action.replace(/_/g, '\\_')}%` : null;
  const exact = query.action && !prefix ? query.action : null;
  return withTenant(tenant, async (tx) => {
    const rows = await tx.$queryRaw<Row[]>`SELECT a.id::text AS id,a.created_at::text AS at_key,a.action,a.user_id::text AS user_id,a.resource_id,a.metadata,a.created_at,
        (SELECT p.full_name FROM profiles p WHERE p.user_id=a.user_id LIMIT 1) AS name
      FROM audit_logs a
      WHERE a.account_id=${tenant.accountId}::uuid
        AND (${query.actor ?? null}::uuid IS NULL OR a.user_id=${query.actor ?? null}::uuid)
        AND (${exact}::text IS NULL OR a.action=${exact})
        AND (${prefix}::text IS NULL OR a.action LIKE ${prefix})
        AND (${query.from ?? null}::timestamptz IS NULL OR a.created_at>=${query.from ?? null})
        AND (${query.to ?? null}::timestamptz IS NULL OR a.created_at<=${query.to ?? null})
        AND (${query.cursor?.at ?? null}::text IS NULL
          OR (a.created_at,a.id)<(${query.cursor?.at ?? null}::timestamptz,${query.cursor?.id ?? null}::uuid))
      ORDER BY a.created_at DESC,a.id DESC LIMIT ${query.limit + 1}`;
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const actions = query.cursor
      ? undefined
      : (await tx.$queryRaw<{ action: string }[]>`SELECT DISTINCT action FROM audit_logs
          WHERE account_id=${tenant.accountId}::uuid ORDER BY action LIMIT 200`).map((r) => r.action);
    return {
      entries: page.map((row) => ({
        id: row.id,
        action: row.action,
        actor: row.user_id ? { user_id: row.user_id, name: row.name } : null,
        resource_id: safeResourceId(row.resource_id),
        metadata: safeMetadata(row.metadata),
        created_at: row.created_at.toISOString(),
      })),
      next_cursor: rows.length > query.limit && last ? encodeCursor(last.at_key, last.id) : null,
      ...(actions ? { actions } : {}),
    };
  });
}
