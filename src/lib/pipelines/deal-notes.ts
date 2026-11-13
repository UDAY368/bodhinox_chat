// Team notes on a deal (the Sales pipeline deal panel). Each note is an
// internal, author-stamped text; it is never sent to the customer. Every query
// runs in the member's own tenant transaction (RLS: agents and above add, the
// author or an admin deletes, viewers read). Audit rows hold ids only.
import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/auth/account';
import { withTenant, type TenantContext } from '@/lib/db/tenant';

export const DEAL_NOTE_MAX = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type DealNoteErrorCode = 'invalid' | 'not_found' | 'forbidden';
export class DealNoteError extends Error {
  constructor(readonly code: DealNoteErrorCode, readonly status: number) {
    super(code);
    this.name = 'DealNoteError';
  }
}

/** DealNoteError -> { error, code } with its status; auth errors as usual; anything else a generic 500. */
export function dealNoteErrorResponse(error: unknown): NextResponse {
  if (error instanceof DealNoteError) return NextResponse.json({ error: error.code, code: error.code }, { status: error.status });
  return toErrorResponse(error);
}

export interface DealNote {
  id: string;
  deal_id: string;
  body: string;
  created_by: string | null;
  author_name: string | null;
  created_at: string;
}

type Member = TenantContext & { userId: string };

/** The note text, trimmed; throws invalid when empty or too long. */
export function parseDealNoteBody(raw: unknown): string {
  const body = typeof raw === 'string' ? raw.trim() : '';
  if (!body || body.length > DEAL_NOTE_MAX) throw new DealNoteError('invalid', 400);
  return body;
}

export const isDealId = (id: string): boolean => UUID.test(id);

type Row = { id: string; deal_id: string; body: string; created_by: string | null; author_name: string | null; created_at: Date };
const toNote = (r: Row): DealNote => ({ ...r, created_at: r.created_at.toISOString() });

/** Newest first. 404 when the deal is not in this workspace. */
export async function listDealNotes(ctx: TenantContext, dealId: string): Promise<DealNote[]> {
  if (!isDealId(dealId)) throw new DealNoteError('not_found', 404);
  return withTenant(ctx, async (tx) => {
    const deal = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM deals
      WHERE account_id=${ctx.accountId}::uuid AND id=${dealId}::uuid`;
    if (!deal[0]) throw new DealNoteError('not_found', 404);
    const rows = await tx.$queryRaw<Row[]>`
      SELECT n.id::text AS id, n.deal_id::text AS deal_id, n.body, n.created_by::text AS created_by,
        p.full_name AS author_name, n.created_at
      FROM deal_notes n LEFT JOIN profiles p ON p.id=n.created_by
      WHERE n.account_id=${ctx.accountId}::uuid AND n.deal_id=${dealId}::uuid
      ORDER BY n.created_at DESC, n.id DESC LIMIT 200`;
    return rows.map(toNote);
  });
}

/** Add a note as the signed-in member (agent and above). */
export async function addDealNote(ctx: Member, dealId: string, rawBody: unknown): Promise<DealNote> {
  if (!isDealId(dealId)) throw new DealNoteError('not_found', 404);
  const body = parseDealNoteBody(rawBody);
  return withTenant(ctx, async (tx) => {
    const deal = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM deals
      WHERE account_id=${ctx.accountId}::uuid AND id=${dealId}::uuid`;
    if (!deal[0]) throw new DealNoteError('not_found', 404);
    const [row] = await tx.$queryRaw<Row[]>`
      INSERT INTO deal_notes(account_id, deal_id, body, created_by)
      VALUES(${ctx.accountId}::uuid, ${dealId}::uuid, ${body}, ${ctx.userId}::uuid)
      RETURNING id::text AS id, deal_id::text AS deal_id, body, created_by::text AS created_by, NULL::text AS author_name, created_at`;
    await tx.$executeRaw`INSERT INTO audit_logs(account_id, user_id, action, resource_id, metadata)
      VALUES(${ctx.accountId}::uuid, ${ctx.userId}::uuid, 'deal.note_added', ${row.id}, ${JSON.stringify({ deal_id: dealId })}::jsonb)`;
    const [author] = await tx.$queryRaw<{ full_name: string | null }[]>`SELECT full_name FROM profiles WHERE id=${ctx.userId}::uuid`;
    return toNote({ ...row, author_name: author?.full_name ?? null });
  });
}

/** Delete a note: its author, or an admin. 404 when it is not on this deal in this workspace. */
export async function deleteDealNote(ctx: Member, dealId: string, noteId: string): Promise<void> {
  if (!isDealId(dealId) || !isDealId(noteId)) throw new DealNoteError('not_found', 404);
  await withTenant(ctx, async (tx) => {
    const [note] = await tx.$queryRaw<{ created_by: string | null }[]>`SELECT created_by::text AS created_by FROM deal_notes
      WHERE account_id=${ctx.accountId}::uuid AND deal_id=${dealId}::uuid AND id=${noteId}::uuid FOR UPDATE`;
    if (!note) throw new DealNoteError('not_found', 404);
    const admin = ctx.role === 'owner' || ctx.role === 'admin';
    if (note.created_by !== ctx.userId && !admin) throw new DealNoteError('forbidden', 403);
    const removed = await tx.$executeRaw`DELETE FROM deal_notes
      WHERE account_id=${ctx.accountId}::uuid AND deal_id=${dealId}::uuid AND id=${noteId}::uuid`;
    if (removed !== 1) throw new DealNoteError('forbidden', 403);
    await tx.$executeRaw`INSERT INTO audit_logs(account_id, user_id, action, resource_id, metadata)
      VALUES(${ctx.accountId}::uuid, ${ctx.userId}::uuid, 'deal.note_deleted', ${noteId}, ${JSON.stringify({ deal_id: dealId })}::jsonb)`;
  });
}
