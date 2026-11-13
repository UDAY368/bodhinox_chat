import { Prisma } from '@prisma/client';

import { withTenant, type TenantContext } from '@/lib/db/tenant';

/**
 * Read side of audit_logs for the admin viewer (Settings → Audit log).
 *
 * RLS already limits reads to the caller's workspace and to admins/owners.
 * Rows are newest first with keyset pagination. Only a fixed projection
 * leaves: metadata is reduced to flat key/value pairs whose values are
 * numbers, booleans or short identifier-like strings, so free text, e-mail
 * addresses, message bodies or nested payloads never reach the browser.
 * The same projection backs the CSV export, which is itself audited.
 */

export const AUDIT_PAGE_DEFAULT = 50;
export const AUDIT_PAGE_MAX = 100;
export const AUDIT_SEARCH_MAX = 80;
/** Rows in one CSV export. */
export const AUDIT_EXPORT_MAX = 5000;

/**
 * Category chips (Settings › Audit log): each is a fixed set of action
 * patterns (SQL LIKE; underscores are escaped by the query). An action that
 * matches none shows under All only.
 */
export const AUDIT_CATEGORIES = {
  team: ['team.%', 'member.%', 'membership.%', 'invitation.%', 'invite.%', 'role.%', 'permission%'],
  channels: ['channels.%', 'whatsapp%', 'instagram.%', 'templates.%', 'template.%'],
  billing: ['billing.%', 'plan.%', 'settings.billing%', 'subscription.%'],
  security: ['auth.%', 'support.%', 'mfa.%', 'session%', 'api_key%', 'security.%'],
  integrations: ['integrations.%', 'webhook%', 'shopify%', 'woocommerce%', 'razorpay%', 'payments.%', 'zoom%', 'meta_ads%', 'ads.%', 'google%'],
  settings: ['settings.%', 'workspace.%', 'account.%', 'inbox.%', 'quick_repl%', 'tags.%', 'custom_fields.%', 'audit_log.%'],
} as const;
export type AuditCategory = keyof typeof AUDIT_CATEGORIES;
export const AUDIT_CATEGORY_IDS = Object.keys(AUDIT_CATEGORIES) as AuditCategory[];

export const isAuditCategory = (value: unknown): value is AuditCategory =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(AUDIT_CATEGORIES, value);

/** The category an action belongs to, or null (pure; mirrors the SQL patterns, first match wins). */
export function categoryOf(action: string): AuditCategory | null {
  // settings.billing is Billing, not Settings: check the more specific categories first.
  for (const category of ['billing', 'team', 'channels', 'security', 'integrations', 'settings'] as AuditCategory[])
    if (AUDIT_CATEGORIES[category].some((pattern) => action.startsWith(pattern.replace(/%$/, '')))) return category;
  return null;
}

export interface AuditEntry {
  id: string;
  action: string;
  actor: { user_id: string; name: string | null } | null;
  resource_id: string | null;
  metadata: Record<string, string | number | boolean | null>;
  created_at: string;
}

export interface AuditQuery {
  /** Free text over action, member name and resource id. */
  q?: string;
  category?: AuditCategory;
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
const CONTROL = /[\u0000-\u001f\u007f]/;

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
  const q = params.get('q')?.trim() || undefined;
  if (q && (q.length > AUDIT_SEARCH_MAX || CONTROL.test(q))) throw new AuditQueryError();
  const category = params.get('category') || undefined;
  if (category !== undefined && !isAuditCategory(category)) throw new AuditQueryError();
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
  return { q, category, actor: actor?.toLowerCase(), action, from, to, cursor: cursorRaw ? decodeCursor(cursorRaw) : undefined, limit };
}

/** A LIKE pattern matching `text` anywhere, with \, % and _ escaped. */
export function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

type Row = { id: string; at_key: string; action: string; user_id: string | null; name: string | null; resource_id: string | null; metadata: unknown; created_at: Date };

/** The filtered rows, newest first; every value is a bound parameter. */
function auditRowsSql(tenant: TenantContext, query: AuditQuery, limit: number): Prisma.Sql {
  const prefix = query.action?.endsWith('.') ? `${query.action.replace(/_/g, '\\_')}%` : null;
  const exact = query.action && !prefix ? query.action : null;
  const search = query.q ? containsPattern(query.q) : null;
  const patterns = query.category ? AUDIT_CATEGORIES[query.category].map((p) => p.replace(/_/g, '\\_')) : null;
  return Prisma.sql`SELECT a.id::text AS id,a.created_at::text AS at_key,a.action,a.user_id::text AS user_id,a.resource_id,a.metadata,a.created_at,
        pn.name
      FROM audit_logs a
      LEFT JOIN LATERAL (SELECT p.full_name AS name FROM profiles p WHERE p.user_id=a.user_id LIMIT 1) pn ON true
      WHERE a.account_id=${tenant.accountId}::uuid
        AND (${search}::text IS NULL OR a.action ILIKE ${search} OR pn.name ILIKE ${search} OR a.resource_id ILIKE ${search})
        AND (${patterns}::text[] IS NULL OR a.action LIKE ANY(${patterns}::text[]))
        AND (${query.actor ?? null}::uuid IS NULL OR a.user_id=${query.actor ?? null}::uuid)
        AND (${exact}::text IS NULL OR a.action=${exact})
        AND (${prefix}::text IS NULL OR a.action LIKE ${prefix})
        AND (${query.from ?? null}::timestamptz IS NULL OR a.created_at>=${query.from ?? null})
        AND (${query.to ?? null}::timestamptz IS NULL OR a.created_at<=${query.to ?? null})
        AND (${query.cursor?.at ?? null}::text IS NULL
          OR (a.created_at,a.id)<(${query.cursor?.at ?? null}::timestamptz,${query.cursor?.id ?? null}::uuid))
      ORDER BY a.created_at DESC,a.id DESC LIMIT ${limit}`;
}

const toEntry = (row: Row): AuditEntry => ({
  id: row.id,
  action: row.action,
  actor: row.user_id ? { user_id: row.user_id, name: row.name } : null,
  resource_id: safeResourceId(row.resource_id),
  metadata: safeMetadata(row.metadata),
  created_at: row.created_at.toISOString(),
});

export async function listAuditLog(
  tenant: TenantContext,
  query: AuditQuery,
): Promise<{ entries: AuditEntry[]; next_cursor: string | null; actions?: string[] }> {
  return withTenant(tenant, async (tx) => {
    const rows = await tx.$queryRaw<Row[]>(auditRowsSql(tenant, query, query.limit + 1));
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const actions = query.cursor
      ? undefined
      : (await tx.$queryRaw<{ action: string }[]>`SELECT DISTINCT action FROM audit_logs
          WHERE account_id=${tenant.accountId}::uuid ORDER BY action LIMIT 200`).map((r) => r.action);
    return {
      entries: page.map(toEntry),
      next_cursor: rows.length > query.limit && last ? encodeCursor(last.at_key, last.id) : null,
      ...(actions ? { actions } : {}),
    };
  });
}

/** One CSV cell: quoted, and a leading = + - @ (or tab/CR) neutralised so a spreadsheet never runs it. */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * The filtered audit trail as CSV (newest first, at most AUDIT_EXPORT_MAX rows)
 * with the viewer's fixed projection. The export is recorded as audit_log.exported.
 */
export async function exportAuditLogCsv(
  tenant: TenantContext,
  query: Omit<AuditQuery, 'cursor' | 'limit'>,
): Promise<{ csv: string; rows: number; truncated: boolean }> {
  return withTenant(tenant, async (tx) => {
    const rows = await tx.$queryRaw<Row[]>(auditRowsSql(tenant, { ...query, limit: AUDIT_EXPORT_MAX }, AUDIT_EXPORT_MAX + 1));
    const truncated = rows.length > AUDIT_EXPORT_MAX;
    const entries = rows.slice(0, AUDIT_EXPORT_MAX).map(toEntry);
    const lines = [
      ['time', 'member', 'action', 'category', 'resource', 'details'].map(csvCell).join(','),
      ...entries.map((e) => [
        e.created_at,
        e.actor ? e.actor.name ?? e.actor.user_id : 'system',
        e.action,
        categoryOf(e.action) ?? '',
        e.resource_id ?? '',
        Object.entries(e.metadata).map(([k, v]) => `${k}=${v === null ? '' : String(v)}`).join('; '),
      ].map(csvCell).join(',')),
    ];
    await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
      VALUES(${tenant.accountId}::uuid,${tenant.userId ?? null}::uuid,'audit_log.exported',${tenant.accountId},
        ${JSON.stringify({ rows: entries.length, truncated, category: query.category ?? null, searched: Boolean(query.q) })}::jsonb)`;
    return { csv: `${lines.join('\r\n')}\r\n`, rows: entries.length, truncated };
  });
}
