// Stage 5 (5E): conversation labels, applied by hand. Labels are per workspace
// (at most 20, a database trigger counts them under a per-workspace lock), unique
// by name without case, with a colour from a fixed palette of theme tokens.
// Agents and above create, rename, delete and apply them (RLS write 'agent');
// every member reads them. Applying a label, and the label links a member reads,
// go through the agent-visibility predicate (inbox-scope.ts): a conversation the
// member may not see is 404 and never listed. Every query runs inside withTenant
// as the live member, with an explicit account_id beside RLS.
import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { toErrorResponse } from '@/lib/auth/account';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { LABEL_COLORS, STAGE5_LIMITS, type LabelColor } from '@/types';
import { conversationVisibleSql } from './inbox-scope';

export interface ConversationLabel {
  id: string;
  name: string;
  color: LabelColor;
}

export interface LabelLink {
  conversation_id: string;
  label_id: string;
}

export type LabelErrorCode = 'invalid_body' | 'invalid_name' | 'invalid_color' | 'name_taken' | 'limit' | 'not_found';

export class LabelError extends Error {
  constructor(readonly code: LabelErrorCode, readonly status: 400 | 404 | 409) {
    super(code);
    this.name = 'LabelError';
  }
}

/** 400/404/409 with the code; anything else goes through toErrorResponse. */
export function labelErrorResponse(error: unknown): NextResponse {
  if (error instanceof LabelError) return NextResponse.json({ error: error.code, code: error.code }, { status: error.status });
  return toErrorResponse(error);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

/** Per-member write budget for labels and favourites. */
export const LABEL_WRITE_LIMIT = { limit: 60, windowMs: 60_000 };

/** A trimmed, whitespace-collapsed label name of 1 to 40 characters, or null. */
export function parseLabelName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.normalize('NFC').replace(/\s+/g, ' ').trim();
  return name.length >= 1 && name.length <= STAGE5_LIMITS.labelNameChars ? name : null;
}

export function parseLabelColor(value: unknown): LabelColor | null {
  return (LABEL_COLORS as readonly unknown[]).includes(value) ? (value as LabelColor) : null;
}

/** Validates a create body `{ name, color? }` (colour defaults to gray). */
export function parseLabelCreate(body: unknown): { name: string; color: LabelColor } {
  const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const name = parseLabelName(input.name);
  if (!name) throw new LabelError('invalid_name', 400);
  const color = input.color === undefined ? 'gray' : parseLabelColor(input.color);
  if (!color) throw new LabelError('invalid_color', 400);
  return { name, color };
}

/** Validates a patch body: `{ name?, color? }`, at least one. */
export function parseLabelPatch(body: unknown): { name?: string; color?: LabelColor } {
  const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const out: { name?: string; color?: LabelColor } = {};
  if (input.name !== undefined) {
    const name = parseLabelName(input.name);
    if (!name) throw new LabelError('invalid_name', 400);
    out.name = name;
  }
  if (input.color !== undefined) {
    const color = parseLabelColor(input.color);
    if (!color) throw new LabelError('invalid_color', 400);
    out.color = color;
  }
  if (out.name === undefined && out.color === undefined) throw new LabelError('invalid_name', 400);
  return out;
}

/** Maps the table's own refusals onto label errors (duplicate name, the 20-label cap). */
function mapDatabaseError(error: unknown): never {
  const code = (error as { code?: string; meta?: { code?: string } })?.meta?.code ?? (error as { code?: string })?.code;
  const message = error instanceof Error ? error.message : '';
  if (code === '23505' || /conversation_labels_name_key/.test(message)) throw new LabelError('name_taken', 409);
  if (/conversation_labels_limit/.test(message)) throw new LabelError('limit', 409);
  throw error;
}

type LabelRow = { id: string; name: string; color: string };
const toLabel = (row: LabelRow): ConversationLabel => ({ id: row.id, name: row.name, color: parseLabelColor(row.color) ?? 'gray' });

export async function listLabels(tenant: TenantContext): Promise<ConversationLabel[]> {
  const rows = await withTenant(tenant, (tx) => tx.$queryRaw<LabelRow[]>`SELECT id::text AS id,name,color FROM conversation_labels
    WHERE account_id=${tenant.accountId}::uuid ORDER BY lower(name),id`);
  return rows.map(toLabel);
}

/**
 * Label links of the conversations the member may see (all of them for an
 * owner or admin, or with visibility 'all'), optionally for one channel.
 */
export async function listLabelLinks(tenant: TenantContext, channel?: 'whatsapp' | 'instagram'): Promise<LabelLink[]> {
  return withTenant(tenant, (tx) => tx.$queryRaw<LabelLink[]>(Prisma.sql`
    SELECT l.conversation_id::text AS conversation_id, l.label_id::text AS label_id
    FROM conversation_label_links l
    JOIN conversations c ON c.account_id = l.account_id AND c.id = l.conversation_id
    WHERE l.account_id=${tenant.accountId}::uuid
      ${channel ? Prisma.sql`AND c.channel = ${channel}` : Prisma.empty}
      AND ${Prisma.raw(conversationVisibleSql('c'))}
    ORDER BY l.conversation_id, l.label_id`));
}

export async function createLabel(tenant: TenantContext, input: { name: string; color: LabelColor }): Promise<ConversationLabel> {
  try {
    const rows = await withTenant(tenant, (tx) => tx.$queryRaw<LabelRow[]>`INSERT INTO conversation_labels(account_id,name,color)
      VALUES(${tenant.accountId}::uuid,${input.name},${input.color}) RETURNING id::text AS id,name,color`);
    return toLabel(rows[0]);
  } catch (error) {
    return mapDatabaseError(error);
  }
}

export async function updateLabel(tenant: TenantContext, id: string, patch: { name?: string; color?: LabelColor }): Promise<ConversationLabel> {
  if (!isUuid(id)) throw new LabelError('not_found', 404);
  let rows: LabelRow[];
  try {
    rows = await withTenant(tenant, (tx) => tx.$queryRaw<LabelRow[]>`UPDATE conversation_labels
      SET name=COALESCE(${patch.name ?? null}::text,name), color=COALESCE(${patch.color ?? null}::text,color)
      WHERE account_id=${tenant.accountId}::uuid AND id=${id}::uuid RETURNING id::text AS id,name,color`);
  } catch (error) {
    return mapDatabaseError(error);
  }
  if (!rows[0]) throw new LabelError('not_found', 404);
  return toLabel(rows[0]);
}

/** Deletes the label; its links go with it (foreign key cascade). */
export async function deleteLabel(tenant: TenantContext, id: string): Promise<void> {
  if (!isUuid(id)) throw new LabelError('not_found', 404);
  const deleted = await withTenant(tenant, (tx) => tx.$executeRaw`DELETE FROM conversation_labels
    WHERE account_id=${tenant.accountId}::uuid AND id=${id}::uuid`);
  if (!deleted) throw new LabelError('not_found', 404);
}

/** The conversation is in this workspace and the member may see it; otherwise 404. */
export async function assertConversationVisible(tx: TenantTransaction, accountId: string, conversationId: string): Promise<void> {
  if (!isUuid(conversationId)) throw new LabelError('not_found', 404);
  const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT c.id::text AS id FROM conversations c
    WHERE c.account_id=${accountId}::uuid AND c.id=${conversationId}::uuid AND ${Prisma.raw(conversationVisibleSql('c'))}`);
  if (!rows[0]) throw new LabelError('not_found', 404);
}

/**
 * Applies (`on`) or removes a label on a conversation. Idempotent: applying an
 * applied label or removing an absent one succeeds. An unknown label or a
 * conversation the member may not see is 404.
 */
export async function setConversationLabel(tenant: TenantContext, labelId: string, conversationId: string, on: boolean): Promise<void> {
  if (!isUuid(labelId)) throw new LabelError('not_found', 404);
  await withTenant(tenant, async (tx) => {
    await assertConversationVisible(tx, tenant.accountId, conversationId);
    const label = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM conversation_labels
      WHERE account_id=${tenant.accountId}::uuid AND id=${labelId}::uuid`;
    if (!label[0]) throw new LabelError('not_found', 404);
    if (on)
      await tx.$executeRaw`INSERT INTO conversation_label_links(account_id,conversation_id,label_id)
        VALUES(${tenant.accountId}::uuid,${conversationId}::uuid,${labelId}::uuid) ON CONFLICT DO NOTHING`;
    else
      await tx.$executeRaw`DELETE FROM conversation_label_links WHERE account_id=${tenant.accountId}::uuid
        AND conversation_id=${conversationId}::uuid AND label_id=${labelId}::uuid`;
  });
}
