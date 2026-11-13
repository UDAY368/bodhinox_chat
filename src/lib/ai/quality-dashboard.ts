// The AI Quality tab (AI page): how the AI's replies did over the last 30
// days, only from data the app records:
//   - suggested replies (ai_suggestions, kind 'reply'): sent as written
//     (accepted), edited then sent, rejected, or shown and not used, per day;
//   - safety checks: sensitive questions routed to staff (assistant and agent),
//     answers the guards blocked, and the guard flags (claims replaced,
//     personal details hidden, links removed, instruction-like text);
//   - team ratings (ai_reply_ratings): helpful / not helpful;
//   - recent AI replies: suggestions and the agents' sent replies
//     (ai_reply_events, outcome 'replied'), newest first, with the member's
//     own rating and every member's totals.
// Admins only (the routes require 'ai.settings'): the list holds customer
// text. Every query runs inside the caller's withTenant transaction.

import type { TenantTransaction } from '@/lib/db/tenant'
import { BILLING_TIME_ZONE } from '@/lib/billing/usage'

export const QUALITY_WINDOW_DAYS = 30
export const RECENT_REPLIES_LIMIT = 50
export const REPLY_FILTERS = ['all', 'suggestion', 'agent', 'down', 'unrated'] as const
export type ReplyFilter = (typeof REPLY_FILTERS)[number]
export const SAFETY_CHECKS = ['sensitive_routed', 'guard_blocked', 'claims', 'personal_data', 'links', 'injection'] as const
export type SafetyCheck = (typeof SAFETY_CHECKS)[number]

export interface QualityReply {
  kind: 'suggestion' | 'agent'
  id: string
  created_at: string
  conversation_id: string | null
  contact_id: string | null
  contact_name: string | null
  question: string | null
  answer: string | null
  /** suggestion: accepted | edited | rejected | shown; agent: sent */
  outcome: 'accepted' | 'edited' | 'rejected' | 'shown' | 'sent'
  /** The member who was shown the suggestion, or the agent that replied. */
  by: string | null
  source: string | null
  my_vote: 'up' | 'down' | null
  up: number
  down: number
}

export interface QualityDashboard {
  window_days: number
  outcomes: { accepted: number; edited: number; rejected: number; unused: number }
  daily: { day: string; shown: number }[]
  safety: { check: SafetyCheck; count: number }[]
  ratings: { up: number; down: number }
  replies: QualityReply[]
}

export const parseReplyFilter = (value: string | null): ReplyFilter =>
  (REPLY_FILTERS as readonly string[]).includes(value ?? '') ? (value as ReplyFilter) : 'all'

/** Each guard flag's safety-check group (unknown flags are not counted). */
export function safetyGroup(flag: string): SafetyCheck | null {
  if (flag === 'sensitive_topic') return 'sensitive_routed'
  if (flag.startsWith('claim_')) return 'claims'
  if (flag === 'pii_redacted') return 'personal_data'
  if (flag === 'url_stripped') return 'links'
  if (flag === 'injection_marker') return 'injection'
  return null
}

/** A 0..100 share of `n` in `total` (0 without a total). */
export const share = (n: number, total: number): number => (total > 0 ? Math.round((n / total) * 100) : 0)

const window = QUALITY_WINDOW_DAYS

export async function readQualityDashboard(tx: TenantTransaction, accountId: string, userId: string, filter: ReplyFilter): Promise<QualityDashboard> {
  const [o] = await tx.$queryRaw<{ accepted: number; edited: number; rejected: number; shown: number }[]>`
    SELECT count(*) FILTER (WHERE status='accepted')::int AS accepted, count(*) FILTER (WHERE status='edited')::int AS edited,
      count(*) FILTER (WHERE status='rejected')::int AS rejected, count(*) FILTER (WHERE status='shown')::int AS shown
    FROM ai_suggestions WHERE account_id=${accountId}::uuid AND kind='reply'
      AND created_at >= now() - make_interval(days => ${window}::int)`

  const daily = await tx.$queryRaw<{ day: string; shown: number }[]>`
    SELECT to_char(d, 'YYYY-MM-DD') AS day, COALESCE(c.n, 0)::int AS shown
    FROM generate_series((now() AT TIME ZONE ${BILLING_TIME_ZONE})::date - ${window - 1}::int,
      (now() AT TIME ZONE ${BILLING_TIME_ZONE})::date, interval '1 day') d
    LEFT JOIN (SELECT (created_at AT TIME ZONE ${BILLING_TIME_ZONE})::date AS day, count(*)::int AS n FROM ai_suggestions
      WHERE account_id=${accountId}::uuid AND kind='reply' AND created_at >= now() - make_interval(days => ${window}::int)
      GROUP BY 1) c ON c.day = d::date
    ORDER BY d`

  const [routed] = await tx.$queryRaw<{ suggestions: number; events: number; blocked: number }[]>`
    SELECT (SELECT count(*)::int FROM ai_suggestions WHERE account_id=${accountId}::uuid AND kind='route_to_staff'
        AND created_at >= now() - make_interval(days => ${window}::int)) AS suggestions,
      (SELECT count(*)::int FROM ai_reply_events WHERE account_id=${accountId}::uuid AND reason='sensitive_topic'
        AND created_at >= now() - make_interval(days => ${window}::int)) AS events,
      (SELECT count(*)::int FROM ai_reply_events WHERE account_id=${accountId}::uuid AND reason='guard_blocked'
        AND created_at >= now() - make_interval(days => ${window}::int)) AS blocked`
  const flags = await tx.$queryRaw<{ flag: string; count: number }[]>`
    SELECT f AS flag, count(*)::int AS count FROM (
      SELECT unnest(guard_flags) AS f FROM ai_suggestions WHERE account_id=${accountId}::uuid AND kind <> 'route_to_staff'
        AND created_at >= now() - make_interval(days => ${window}::int)
      UNION ALL
      SELECT unnest(guard_flags) FROM ai_reply_events WHERE account_id=${accountId}::uuid
        AND created_at >= now() - make_interval(days => ${window}::int)) x
    GROUP BY f`
  const counts = new Map<SafetyCheck, number>([
    ['sensitive_routed', (routed?.suggestions ?? 0) + (routed?.events ?? 0)],
    ['guard_blocked', routed?.blocked ?? 0],
  ])
  for (const f of flags) {
    const group = safetyGroup(f.flag)
    if (group && group !== 'sensitive_routed') counts.set(group, (counts.get(group) ?? 0) + Number(f.count))
  }

  const [r] = await tx.$queryRaw<{ up: number; down: number }[]>`
    SELECT count(*) FILTER (WHERE vote='up')::int AS up, count(*) FILTER (WHERE vote='down')::int AS down FROM ai_reply_ratings
    WHERE account_id=${accountId}::uuid AND updated_at >= now() - make_interval(days => ${window}::int)`

  const replies = await tx.$queryRaw<(Omit<QualityReply, 'created_at'> & { created_at: Date })[]>`
    SELECT * FROM (
      SELECT 'suggestion'::text AS kind, s.id::text AS id, s.created_at, s.conversation_id::text AS conversation_id,
        cv.contact_id::text AS contact_id, ct.name AS contact_name,
        (SELECT left(m.content_text, 500) FROM messages m WHERE m.account_id=s.account_id AND m.conversation_id=s.conversation_id
          AND m.sender_type='customer' AND m.content_text IS NOT NULL AND m.created_at <= s.created_at
          ORDER BY m.created_at DESC LIMIT 1) AS question,
        left(s.output->>'text', 1000) AS answer, s.status AS outcome,
        (SELECT p.full_name FROM profiles p WHERE p.user_id=s.created_by LIMIT 1) AS by,
        s.citations->0->>'title' AS source,
        (SELECT vote FROM ai_reply_ratings rr WHERE rr.account_id=s.account_id AND rr.suggestion_id=s.id AND rr.user_id=${userId}::uuid) AS my_vote,
        (SELECT count(*)::int FROM ai_reply_ratings rr WHERE rr.account_id=s.account_id AND rr.suggestion_id=s.id AND rr.vote='up') AS up,
        (SELECT count(*)::int FROM ai_reply_ratings rr WHERE rr.account_id=s.account_id AND rr.suggestion_id=s.id AND rr.vote='down') AS down
      FROM ai_suggestions s
      LEFT JOIN conversations cv ON cv.account_id=s.account_id AND cv.id=s.conversation_id
      LEFT JOIN contacts ct ON ct.account_id=s.account_id AND ct.id=cv.contact_id
      WHERE s.account_id=${accountId}::uuid AND s.kind='reply' AND s.created_at >= now() - make_interval(days => ${window}::int)
        AND ${filter}::text IN ('all','suggestion','down','unrated')
      UNION ALL
      SELECT 'agent'::text, e.id::text, e.created_at, e.conversation_id::text, e.contact_id::text, ct.name,
        left(e.customer_text, 500), left(e.reply_text, 1000), 'sent'::text, ag.name, e.sources->0->>'title',
        (SELECT vote FROM ai_reply_ratings rr WHERE rr.account_id=e.account_id AND rr.reply_event_id=e.id AND rr.user_id=${userId}::uuid),
        (SELECT count(*)::int FROM ai_reply_ratings rr WHERE rr.account_id=e.account_id AND rr.reply_event_id=e.id AND rr.vote='up'),
        (SELECT count(*)::int FROM ai_reply_ratings rr WHERE rr.account_id=e.account_id AND rr.reply_event_id=e.id AND rr.vote='down')
      FROM ai_reply_events e
      LEFT JOIN contacts ct ON ct.account_id=e.account_id AND ct.id=e.contact_id
      LEFT JOIN ai_agents ag ON ag.account_id=e.account_id AND ag.id=e.agent_id
      WHERE e.account_id=${accountId}::uuid AND e.outcome='replied' AND e.created_at >= now() - make_interval(days => ${window}::int)
        AND ${filter}::text IN ('all','agent','down','unrated')
    ) x
    WHERE (${filter}::text <> 'down' OR x.down > 0) AND (${filter}::text <> 'unrated' OR (x.up = 0 AND x.down = 0))
    ORDER BY x.created_at DESC, x.id DESC LIMIT ${RECENT_REPLIES_LIMIT}::int`

  return {
    window_days: window,
    outcomes: { accepted: o?.accepted ?? 0, edited: o?.edited ?? 0, rejected: o?.rejected ?? 0, unused: o?.shown ?? 0 },
    daily: daily.map((d) => ({ day: d.day, shown: Number(d.shown) })),
    safety: SAFETY_CHECKS.map((check) => ({ check, count: counts.get(check) ?? 0 })),
    ratings: { up: r?.up ?? 0, down: r?.down ?? 0 },
    replies: replies.map((x) => ({
      ...x,
      created_at: x.created_at.toISOString(),
      my_vote: x.my_vote === 'up' || x.my_vote === 'down' ? x.my_vote : null,
      up: Number(x.up), down: Number(x.down),
    })),
  }
}

export type RatingTarget = { kind: 'suggestion' | 'agent'; id: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A rating body { kind, id, vote: 'up' | 'down' | null }, or null when invalid. */
export function parseRating(body: unknown): (RatingTarget & { vote: 'up' | 'down' | null }) | null {
  const b = body as { kind?: unknown; id?: unknown; vote?: unknown } | null
  if (!b || (b.kind !== 'suggestion' && b.kind !== 'agent') || typeof b.id !== 'string' || !UUID.test(b.id)) return null
  if (b.vote !== 'up' && b.vote !== 'down' && b.vote !== null) return null
  return { kind: b.kind, id: b.id.toLowerCase(), vote: b.vote }
}

/**
 * Sets (or clears, vote null) the member's rating of one AI reply. The reply
 * must be a reply suggestion or a sent agent reply of this workspace (false
 * otherwise). RLS lets a member write only their own rating.
 */
export async function setRating(tx: TenantTransaction, accountId: string, userId: string,
  target: RatingTarget, vote: 'up' | 'down' | null): Promise<boolean> {
  const exists = target.kind === 'suggestion'
    ? await tx.$queryRaw<{ ok: number }[]>`SELECT 1 AS ok FROM ai_suggestions WHERE account_id=${accountId}::uuid AND id=${target.id}::uuid AND kind='reply'`
    : await tx.$queryRaw<{ ok: number }[]>`SELECT 1 AS ok FROM ai_reply_events WHERE account_id=${accountId}::uuid AND id=${target.id}::uuid AND outcome='replied'`
  if (!exists.length) return false
  const suggestionId = target.kind === 'suggestion' ? target.id : null
  const eventId = target.kind === 'agent' ? target.id : null
  if (vote === null) {
    await tx.$executeRaw`DELETE FROM ai_reply_ratings WHERE account_id=${accountId}::uuid AND user_id=${userId}::uuid
      AND suggestion_id IS NOT DISTINCT FROM ${suggestionId}::uuid AND reply_event_id IS NOT DISTINCT FROM ${eventId}::uuid`
    return true
  }
  const updated = await tx.$executeRaw`UPDATE ai_reply_ratings SET vote=${vote} WHERE account_id=${accountId}::uuid AND user_id=${userId}::uuid
    AND suggestion_id IS NOT DISTINCT FROM ${suggestionId}::uuid AND reply_event_id IS NOT DISTINCT FROM ${eventId}::uuid`
  if (updated === 0) {
    await tx.$executeRaw`INSERT INTO ai_reply_ratings(account_id, suggestion_id, reply_event_id, user_id, vote)
      VALUES (${accountId}::uuid, ${suggestionId}::uuid, ${eventId}::uuid, ${userId}::uuid, ${vote})
      ON CONFLICT DO NOTHING`
  }
  return true
}
