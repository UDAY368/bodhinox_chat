// ============================================================
// AI activity log (ai_reply_events): one row per customer message the
// WhatsApp auto-reply agent handled after its first eligibility check, with
// the outcome, a reason code, the customer's question, the reply, the
// knowledge sources, confidence, guard flags, model, tokens and latency.
//
// Roles (enforced by RLS on ai_reply_events):
//   worker        records rows (recordReplyEvent, from auto-reply.ts)
//   admin and up  lists and reads them (GET /api/ai/activity)
// Customer text and replies are stored capped, never logged: a failed write
// logs its reason code and the error class name only (./log). Rows are
// deleted after 90 days (./retention).
// ============================================================

import { getWorkerPrisma } from '@/lib/db/prisma'
import { withTenant, type TenantContext } from '@/lib/db/tenant'
import { logAiEvent } from './log'
import { REASON_CODE, isReplyEventOutcome, type ReplyEventOutcome } from './reply-event-codes'

export const MAX_CUSTOMER_TEXT_CHARS = 2000
export const MAX_REPLY_TEXT_CHARS = 4096
export const MAX_SOURCES = 5
const MAX_TITLE_CHARS = 200
const MAX_FLAGS = 16
const MAX_INT = 2_147_483_647
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FLAG = /^[a-z0-9_.:-]{1,64}$/i

export interface ReplyEventSource {
  document_id: string
  title: string | null
}

export interface ReplyEventInput {
  accountId: string
  conversationId?: string | null
  contactId?: string | null
  inboundMessageId?: string | null
  outcome: ReplyEventOutcome
  reason: string
  customerText?: string | null
  replyText?: string | null
  /** Citations of the retrieved knowledge; only document id and title are kept. */
  sources?: readonly { document_id: string | null; title: string | null }[] | null
  confidence?: number | null
  guardFlags?: readonly string[] | null
  provider?: string | null
  model?: string | null
  promptTokens?: number | null
  completionTokens?: number | null
  totalTokens?: number | null
  latencyMs?: number | null
  /** The AI agent that handled the message (null: the legacy single agent). */
  agentId?: string | null
}

/** The row written for one event: every field capped to the table's limits. */
export interface ReplyEventRow {
  account_id: string
  conversation_id: string | null
  contact_id: string | null
  inbound_message_id: string | null
  outcome: ReplyEventOutcome
  reason: string
  customer_text: string | null
  reply_text: string | null
  sources: ReplyEventSource[]
  confidence: number | null
  guard_flags: string[]
  provider: string | null
  model: string | null
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  latency_ms: number | null
  agent_id: string | null
}

/** At most `max` characters (code points, as PostgreSQL counts them), no NUL bytes; null when blank. */
export function capText(value: string | null | undefined, max: number): string | null {
  if (typeof value !== 'string') return null
  const clean = value.replace(/\u0000/g, '')
  if (!clean.trim()) return null
  const chars = Array.from(clean)
  return chars.length > max ? chars.slice(0, max).join('') : clean
}

const uuidOrNull = (value: string | null | undefined) => (typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null)
const count = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(MAX_INT, Math.max(0, Math.round(value))) : 0

/** Up to MAX_SOURCES distinct documents as {document_id, title}; never chunk text or urls. */
export function trimSources(sources: ReplyEventInput['sources']): ReplyEventSource[] {
  const out: ReplyEventSource[] = []
  const seen = new Set<string>()
  for (const source of sources ?? []) {
    const id = typeof source?.document_id === 'string' ? source.document_id.slice(0, 64) : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({ document_id: id, title: capText(source.title, MAX_TITLE_CHARS) })
    if (out.length >= MAX_SOURCES) break
  }
  return out
}

export function replyEventRow(input: ReplyEventInput): ReplyEventRow {
  const confidence = typeof input.confidence === 'number' && Number.isFinite(input.confidence)
    ? Math.min(1, Math.max(0, input.confidence)) : null
  const latency = typeof input.latencyMs === 'number' && Number.isFinite(input.latencyMs) ? count(input.latencyMs) : null
  return {
    account_id: input.accountId,
    conversation_id: uuidOrNull(input.conversationId),
    contact_id: uuidOrNull(input.contactId),
    inbound_message_id: capText(input.inboundMessageId, 256),
    outcome: input.outcome,
    reason: REASON_CODE.test(input.reason) ? input.reason : 'unknown',
    customer_text: capText(input.customerText, MAX_CUSTOMER_TEXT_CHARS),
    reply_text: capText(input.replyText, MAX_REPLY_TEXT_CHARS),
    sources: trimSources(input.sources),
    confidence,
    guard_flags: [...new Set((input.guardFlags ?? []).filter((f) => typeof f === 'string' && FLAG.test(f)))].slice(0, MAX_FLAGS),
    provider: capText(input.provider, 32),
    model: capText(input.model, 200),
    prompt_tokens: count(input.promptTokens),
    completion_tokens: count(input.completionTokens),
    total_tokens: count(input.totalTokens),
    latency_ms: latency,
    agent_id: uuidOrNull(input.agentId),
  }
}

/**
 * Write one activity row on the worker role. Best-effort: never throws, and a
 * failure logs only a reason code and the error class name.
 */
export async function recordReplyEvent(input: ReplyEventInput): Promise<void> {
  try {
    if (!isReplyEventOutcome(input.outcome)) return
    const r = replyEventRow(input)
    await withTenant({ accountId: input.accountId, role: 'owner' }, (tx) => tx.$executeRaw`INSERT INTO ai_reply_events(
        account_id, conversation_id, contact_id, inbound_message_id, outcome, reason, customer_text, reply_text,
        sources, confidence, guard_flags, provider, model, prompt_tokens, completion_tokens, total_tokens, latency_ms, agent_id)
      VALUES (${r.account_id}::uuid, ${r.conversation_id}::uuid, ${r.contact_id}::uuid, ${r.inbound_message_id}, ${r.outcome},
        ${r.reason}, ${r.customer_text}, ${r.reply_text}, ${JSON.stringify(r.sources)}::jsonb, ${r.confidence}::real,
        ${r.guard_flags}::text[], ${r.provider}, ${r.model}, ${r.prompt_tokens}::int, ${r.completion_tokens}::int,
        ${r.total_tokens}::int, ${r.latency_ms}::int, ${r.agent_id}::uuid)`, getWorkerPrisma())
  } catch (error) {
    logAiEvent({ feature: 'reply_events', reason: 'insert_failed', accountId: input.accountId, error })
  }
}

// ------------------------------------------------------------ read side (admin)

export const ACTIVITY_PAGE_DEFAULT = 50
export const ACTIVITY_PAGE_MAX = 100
export const PREVIEW_CHARS = 160

export class ActivityQueryError extends Error {
  constructor() {
    super('invalid_query')
    this.name = 'ActivityQueryError'
  }
}

export interface ActivityQuery {
  outcome?: ReplyEventOutcome
  reason?: string
  contactId?: string
  from?: Date
  to?: Date
  /** at: the row's created_at as PostgreSQL text (microsecond precision). */
  cursor?: { at: string; id: string }
  limit: number
}

export interface ActivityContact { id: string; name: string | null; phone: string | null }

export interface ActivityListItem {
  id: string
  created_at: string
  conversation_id: string | null
  contact: ActivityContact | null
  outcome: ReplyEventOutcome
  reason: string
  preview: string | null
  has_reply: boolean
  model: string | null
  total_tokens: number
  latency_ms: number | null
}

export interface ActivityDetail extends Omit<ActivityListItem, 'preview' | 'has_reply'> {
  inbound_message_id: string | null
  customer_text: string | null
  reply_text: string | null
  sources: ReplyEventSource[]
  confidence: number | null
  guard_flags: string[]
  provider: string | null
  prompt_tokens: number
  completion_tokens: number
}

const CURSOR_AT = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-](\d{2})(?::?(\d{2}))?)?$/

/** A real calendar date and clock time (what PostgreSQL printed), so a forged cursor never reaches ::timestamptz. */
function validCursorAt(at: string): boolean {
  const m = CURSOR_AT.exec(at)
  if (!m) return false
  const [y, mo, d, hh, mi, ss, oh, om] = m.slice(1).map((part) => Number(part ?? 0))
  const day = new Date(Date.UTC(y, mo - 1, d))
  return day.getUTCFullYear() === y && day.getUTCMonth() === mo - 1 && day.getUTCDate() === d
    && hh < 24 && mi < 60 && ss < 60 && oh <= 15 && om < 60
}

export function encodeActivityCursor(at: string, id: string): string {
  return Buffer.from(`${at}|${id}`, 'utf8').toString('base64url')
}

export function decodeActivityCursor(raw: string): { at: string; id: string } {
  const [at, id, extra] = Buffer.from(raw, 'base64url').toString('utf8').split('|')
  if (extra !== undefined || !validCursorAt(at ?? '') || !UUID.test(id ?? '')) throw new ActivityQueryError()
  return { at, id: id.toLowerCase() }
}

function parseDate(raw: string | null): Date | undefined {
  if (!raw) return undefined
  if (raw.length > 40) throw new ActivityQueryError()
  const at = new Date(raw)
  if (!Number.isFinite(at.getTime())) throw new ActivityQueryError()
  return at
}

export function parseActivityQuery(params: URLSearchParams): ActivityQuery {
  const outcome = params.get('outcome') || undefined
  if (outcome !== undefined && !isReplyEventOutcome(outcome)) throw new ActivityQueryError()
  const reason = params.get('reason') || undefined
  if (reason !== undefined && !REASON_CODE.test(reason)) throw new ActivityQueryError()
  const contactId = params.get('contact_id') || undefined
  if (contactId !== undefined && !UUID.test(contactId)) throw new ActivityQueryError()
  const from = parseDate(params.get('from'))
  const to = parseDate(params.get('to'))
  if (from && to && from > to) throw new ActivityQueryError()
  const cursorRaw = params.get('cursor')
  if (cursorRaw && cursorRaw.length > 200) throw new ActivityQueryError()
  const limitRaw = params.get('limit')
  const limit = limitRaw === null || limitRaw === '' ? ACTIVITY_PAGE_DEFAULT : Number(limitRaw)
  if (!Number.isInteger(limit) || limit < 1 || limit > ACTIVITY_PAGE_MAX) throw new ActivityQueryError()
  return {
    outcome, reason, contactId: contactId?.toLowerCase(), from, to,
    cursor: cursorRaw ? decodeActivityCursor(cursorRaw) : undefined, limit,
  }
}

type ListRow = {
  id: string; at_key: string; created_at: Date; conversation_id: string | null; contact_id: string | null
  contact_name: string | null; contact_phone: string | null; outcome: ReplyEventOutcome; reason: string
  preview: string | null; has_reply: boolean; model: string | null; total_tokens: number; latency_ms: number | null
}

const contactOf = (row: { contact_id: string | null; contact_name: string | null; contact_phone: string | null }): ActivityContact | null =>
  row.contact_id ? { id: row.contact_id, name: row.contact_name, phone: row.contact_phone } : null

/** One page of the workspace's activity, newest first (keyset on created_at, id). RLS limits it to admins. */
export async function listReplyEvents(
  tenant: TenantContext,
  query: ActivityQuery,
): Promise<{ events: ActivityListItem[]; next_cursor: string | null }> {
  return withTenant(tenant, async (tx) => {
    const rows = await tx.$queryRaw<ListRow[]>`SELECT e.id::text AS id, e.created_at::text AS at_key, e.created_at,
        e.conversation_id::text AS conversation_id, e.contact_id::text AS contact_id, c.name AS contact_name, c.phone AS contact_phone,
        e.outcome, e.reason, left(e.customer_text, ${PREVIEW_CHARS}::int) AS preview, (e.reply_text IS NOT NULL) AS has_reply,
        e.model, e.total_tokens, e.latency_ms
      FROM ai_reply_events e
      LEFT JOIN contacts c ON c.account_id = e.account_id AND c.id = e.contact_id
      WHERE e.account_id=${tenant.accountId}::uuid
        AND (${query.outcome ?? null}::text IS NULL OR e.outcome=${query.outcome ?? null})
        AND (${query.reason ?? null}::text IS NULL OR e.reason=${query.reason ?? null})
        AND (${query.contactId ?? null}::uuid IS NULL OR e.contact_id=${query.contactId ?? null}::uuid)
        AND (${query.from ?? null}::timestamptz IS NULL OR e.created_at>=${query.from ?? null})
        AND (${query.to ?? null}::timestamptz IS NULL OR e.created_at<=${query.to ?? null})
        AND (${query.cursor?.at ?? null}::text IS NULL
          OR (e.created_at,e.id)<(${query.cursor?.at ?? null}::timestamptz,${query.cursor?.id ?? null}::uuid))
      ORDER BY e.created_at DESC, e.id DESC LIMIT ${query.limit + 1}`
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return {
      events: page.map((row) => ({
        id: row.id,
        created_at: row.created_at.toISOString(),
        conversation_id: row.conversation_id,
        contact: contactOf(row),
        outcome: row.outcome,
        reason: row.reason,
        preview: row.preview,
        has_reply: row.has_reply,
        model: row.model,
        total_tokens: Number(row.total_tokens),
        latency_ms: row.latency_ms === null ? null : Number(row.latency_ms),
      })),
      next_cursor: rows.length > query.limit && last ? encodeActivityCursor(last.at_key, last.id) : null,
    }
  })
}

type DetailRow = Omit<ListRow, 'at_key' | 'preview' | 'has_reply'> & {
  inbound_message_id: string | null; customer_text: string | null; reply_text: string | null; sources: unknown
  confidence: number | null; guard_flags: string[] | null; provider: string | null; prompt_tokens: number; completion_tokens: number
}

/** One activity row in full, or null when it is not in the caller's workspace. */
export async function getReplyEvent(tenant: TenantContext, id: string): Promise<ActivityDetail | null> {
  if (!UUID.test(id)) return null
  return withTenant(tenant, async (tx) => {
    const [row] = await tx.$queryRaw<DetailRow[]>`SELECT e.id::text AS id, e.created_at,
        e.conversation_id::text AS conversation_id, e.contact_id::text AS contact_id, c.name AS contact_name, c.phone AS contact_phone,
        e.inbound_message_id, e.outcome, e.reason, e.customer_text, e.reply_text, e.sources, e.confidence, e.guard_flags,
        e.provider, e.model, e.prompt_tokens, e.completion_tokens, e.total_tokens, e.latency_ms
      FROM ai_reply_events e
      LEFT JOIN contacts c ON c.account_id = e.account_id AND c.id = e.contact_id
      WHERE e.account_id=${tenant.accountId}::uuid AND e.id=${id.toLowerCase()}::uuid`
    if (!row) return null
    return {
      id: row.id,
      created_at: row.created_at.toISOString(),
      conversation_id: row.conversation_id,
      contact: contactOf(row),
      inbound_message_id: row.inbound_message_id,
      outcome: row.outcome,
      reason: row.reason,
      customer_text: row.customer_text,
      reply_text: row.reply_text,
      sources: trimSources(Array.isArray(row.sources) ? row.sources as ReplyEventInput['sources'] : []),
      confidence: row.confidence === null ? null : Number(row.confidence),
      guard_flags: row.guard_flags ?? [],
      provider: row.provider,
      model: row.model,
      prompt_tokens: Number(row.prompt_tokens),
      completion_tokens: Number(row.completion_tokens),
      total_tokens: Number(row.total_tokens),
      latency_ms: row.latency_ms === null ? null : Number(row.latency_ms),
    }
  })
}
