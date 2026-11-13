// Pure helpers for the AI page's Quality tab (unit-tested).

export const OUTCOMES = ['accepted', 'edited', 'rejected', 'unused'] as const
export type Outcome = (typeof OUTCOMES)[number]
export const REPLY_FILTERS = ['all', 'suggestion', 'agent', 'down', 'unrated'] as const
export type ReplyFilter = (typeof REPLY_FILTERS)[number]

export interface QualityReplyView {
  kind: 'suggestion' | 'agent'
  id: string
  created_at: string
  conversation_id: string | null
  contact_id: string | null
  contact_name: string | null
  question: string | null
  answer: string | null
  outcome: 'accepted' | 'edited' | 'rejected' | 'shown' | 'sent'
  by: string | null
  source: string | null
  my_vote: 'up' | 'down' | null
  up: number
  down: number
}

export interface QualityView {
  window_days: number
  outcomes: Record<Outcome, number>
  daily: { day: string; shown: number }[]
  safety: { check: string; count: number }[]
  ratings: { up: number; down: number }
  replies: QualityReplyView[]
}

/** A 0..100 share of `n` in `total` (0 without a total). */
export const share = (n: number, total: number): number => (total > 0 ? Math.round((n / total) * 100) : 0)

/**
 * The view after the member changed their rating of one reply: the reply's
 * own vote and counts, and the team totals, move together.
 */
export function applyVote(view: QualityView, id: string, next: 'up' | 'down' | null): QualityView {
  let { up, down } = view.ratings
  const replies = view.replies.map((r) => {
    if (r.id !== id) return r
    const prev = r.my_vote
    let rUp = r.up
    let rDown = r.down
    if (prev === 'up') { rUp--; up-- }
    if (prev === 'down') { rDown--; down-- }
    if (next === 'up') { rUp++; up++ }
    if (next === 'down') { rDown++; down++ }
    return { ...r, my_vote: next, up: Math.max(0, rUp), down: Math.max(0, rDown) }
  })
  return { ...view, replies, ratings: { up: Math.max(0, up), down: Math.max(0, down) } }
}
