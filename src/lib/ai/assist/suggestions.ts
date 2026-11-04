// Storage for staff-reviewed AI output (ai_suggestions).
//
// A member creates suggestions as themselves (the row's created_by) and can
// only ever decide one that is still 'shown'; the model output itself can
// never be rewritten (no UPDATE grant on output or citations). The send route
// records which message used a suggested reply after the send has completed.
// Nothing here sends anything.

import { Prisma } from '@prisma/client';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import type { KnowledgeCitation } from '../types';

export type SuggestionKind = 'summary' | 'reply' | 'route_to_staff';

export interface NewSuggestion {
  conversationId: string;
  kind: SuggestionKind;
  output: Record<string, unknown>;
  citations?: readonly KnowledgeCitation[];
  guardFlags?: readonly string[];
  provider?: string | null;
  model?: string | null;
  promptVersion: string;
}

const MAX_CITATIONS = 5;
const MAX_FLAGS = 16;

const citationJson = (citations: readonly KnowledgeCitation[] = []) => JSON.stringify(citations.slice(0, MAX_CITATIONS).map((c) => ({
  chunk_id: c.chunk_id, document_id: c.document_id, source_id: c.source_id,
  title: c.title ? c.title.slice(0, 120) : null, source_url: c.source_url ? c.source_url.slice(0, 500) : null,
})));

/** Inserts suggestions as the member (`ctx.userId`) inside their tenant transaction; returns the ids in order. */
export async function insertSuggestions(
  tx: TenantTransaction,
  ctx: { accountId: string; userId: string },
  rows: readonly NewSuggestion[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const row of rows) {
    const flags = [...new Set(row.guardFlags ?? [])].slice(0, MAX_FLAGS);
    const [inserted] = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      INSERT INTO ai_suggestions(account_id, conversation_id, kind, output, citations, guard_flags, provider, model, prompt_version, created_by)
      VALUES(${ctx.accountId}::uuid, ${row.conversationId}::uuid, ${row.kind}, ${JSON.stringify(row.output)}::jsonb,
        ${citationJson(row.citations)}::jsonb, ${flags}::text[], ${row.provider ?? null}, ${row.model ?? null},
        ${row.promptVersion}, ${ctx.userId}::uuid)
      RETURNING id`);
    ids.push(inserted.id);
  }
  return ids;
}

export type DecisionResult = 'ok' | 'not_found' | 'already_decided';

/** Records the member's rejection of a suggestion that is still 'shown'. */
export async function rejectSuggestion(
  tx: TenantTransaction,
  ctx: { accountId: string; userId: string },
  suggestionId: string,
): Promise<DecisionResult> {
  const updated = await tx.$queryRaw<{ id: string }[]>`
    UPDATE ai_suggestions SET status='rejected', decided_by=${ctx.userId}::uuid, decided_at=now()
    WHERE account_id=${ctx.accountId}::uuid AND id=${suggestionId}::uuid AND status='shown' RETURNING id`;
  if (updated.length) return 'ok';
  const [existing] = await tx.$queryRaw<{ status: string }[]>`
    SELECT status FROM ai_suggestions WHERE account_id=${ctx.accountId}::uuid AND id=${suggestionId}::uuid`;
  return existing ? 'already_decided' : 'not_found';
}

const MAX_DISTANCE_CHARS = 2_000;

/** Levenshtein distance between `a` and `b` (each cut to 2k characters), normalised to 0..1000. */
export function normalizedEditDistance(a: string, b: string): number {
  const x = [...a.trim().slice(0, MAX_DISTANCE_CHARS)];
  const y = [...b.trim().slice(0, MAX_DISTANCE_CHARS)];
  const longest = Math.max(x.length, y.length);
  if (longest === 0) return 0;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return Math.round((prev[y.length] / longest) * 1000);
}

export type SuggestionUse = { status: 'accepted' | 'edited'; editDistance: number } | null;

/**
 * After a send: marks the reply suggestion the message came from as accepted
 * (sent unchanged) or edited, links the sent message and audits
 * 'ai.suggestion_used'. Matches only a 'shown' reply suggestion of this
 * conversation in this workspace. Runs in its own tenant transaction as the
 * sending member; null when nothing matched.
 */
export async function recordSuggestionUse(
  tenant: TenantContext & { userId: string },
  args: { suggestionId: string; conversationId: string; messageId: string; sentText: string },
): Promise<SuggestionUse> {
  return withTenant(tenant, async (tx) => {
    const [row] = await tx.$queryRaw<{ text: string | null }[]>`
      SELECT output->>'text' AS text FROM ai_suggestions
      WHERE account_id=${tenant.accountId}::uuid AND id=${args.suggestionId}::uuid
        AND conversation_id=${args.conversationId}::uuid AND kind='reply' AND status='shown'`;
    if (!row) return null;
    const editDistance = normalizedEditDistance(row.text ?? '', args.sentText);
    const status = editDistance === 0 ? 'accepted' : 'edited';
    const updated = await tx.$queryRaw<{ id: string }[]>`
      UPDATE ai_suggestions SET status=${status}, sent_message_id=${args.messageId}::uuid, edit_distance=${editDistance},
        decided_by=${tenant.userId}::uuid, decided_at=now()
      WHERE account_id=${tenant.accountId}::uuid AND id=${args.suggestionId}::uuid AND conversation_id=${args.conversationId}::uuid
        AND kind='reply' AND status='shown'
      RETURNING id`;
    if (!updated.length) return null;
    await tx.$executeRaw`INSERT INTO audit_logs(account_id, user_id, action, resource_id, metadata)
      VALUES(${tenant.accountId}::uuid, ${tenant.userId}::uuid, 'ai.suggestion_used', ${args.suggestionId},
        ${JSON.stringify({ status, edit_distance: editDistance, conversation_id: args.conversationId })}::jsonb)`;
    return { status, editDistance };
  });
}
