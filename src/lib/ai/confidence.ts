// ============================================================
// Reply confidence: a simple, explainable signal for "should the AI
// agent send this, or hand the conversation to a person?"
//
// Two inputs, no extra model call:
//
// 1. The model's own judgement. The agent prompt teaches two control
//    phrases. NO_ANSWER_SENTINEL means "the knowledge does not cover
//    this"; HANDOFF_SENTINEL means "a person must take over". Either
//    one, or an empty reply, makes the turn not confident (score 0).
//
// 2. Retrieval evidence, from the knowledge-base match scores:
//      semantic  cosine distance d from match_ai_knowledge_semantic
//                (0 identical .. 2 opposite). similarity = 1 - d.
//                text-embedding-3-small puts on-topic passages around
//                0.4-0.7 similarity, so the best similarity is mapped
//                linearly from 0.2 (score 0) to 0.6 (score 1).
//      lexical   rank from match_ai_knowledge_fts (number of matched
//                keywords plus a fraction below 1). Mapped to
//                rank / (rank + 1) and weighted 0.8, because keyword
//                overlap is weaker evidence than meaning.
//    retrieval = the larger of the two, 0 when nothing matched.
//
// When the model answered without a control phrase:
//      score = 0.5 + 0.5 * retrieval            (0.5 .. 1)
// so an answer always scores at least 0.5. A threshold at or below
// 0.5 trusts the model's judgement (small talk with no knowledge hit
// still goes out); a threshold above 0.5 also demands knowledge-base
// support. confident = score >= threshold.
// ============================================================

import { HANDOFF_SENTINEL } from './defaults'

export const NO_ANSWER_SENTINEL = '[[NO_ANSWER]]'

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.35

const SEMANTIC_FLOOR = 0.2
const SEMANTIC_CEILING = 0.6
const LEXICAL_WEIGHT = 0.8

export interface RetrievalScores {
  /** Cosine distances of the semantic matches (lower is closer). */
  semanticDistances?: readonly number[]
  /** Ranks of the lexical matches (higher is better). */
  lexicalRanks?: readonly number[]
}

export type ConfidenceReason = 'answered' | 'no_answer' | 'handoff' | 'empty' | 'low_score'

export interface ConfidenceResult {
  confident: boolean
  /** 0..1, rounded to 3 decimals. */
  score: number
  reason: ConfidenceReason
  /** The reply with both control phrases removed. */
  text: string
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0)
const round = (n: number) => Math.round(n * 1000) / 1000

/** 0..1 strength of the best knowledge-base match. */
export function retrievalScore(scores: RetrievalScores | null | undefined): number {
  if (!scores) return 0
  let semantic = 0
  for (const d of scores.semanticDistances ?? []) {
    if (!Number.isFinite(d)) continue
    semantic = Math.max(semantic, clamp01((1 - d - SEMANTIC_FLOOR) / (SEMANTIC_CEILING - SEMANTIC_FLOOR)))
  }
  let lexical = 0
  for (const r of scores.lexicalRanks ?? []) {
    if (!Number.isFinite(r) || r <= 0) continue
    lexical = Math.max(lexical, (r / (r + 1)) * LEXICAL_WEIGHT)
  }
  return clamp01(Math.max(semantic, lexical))
}

/** Remove the control phrases (and whether each was present). */
export function stripSentinels(raw: string): { text: string; noAnswer: boolean; handoff: boolean } {
  const noAnswer = raw.includes(NO_ANSWER_SENTINEL)
  const handoff = raw.includes(HANDOFF_SENTINEL)
  const text = raw.split(NO_ANSWER_SENTINEL).join('').split(HANDOFF_SENTINEL).join('').trim()
  return { text, noAnswer, handoff }
}

/**
 * Decide whether a generated reply is confident enough to send.
 *
 * `reply` is the model text (raw, or already passed through
 * parseGeneration); `handoff` is parseGeneration's flag when the
 * caller has it, since parseGeneration strips HANDOFF_SENTINEL.
 */
export function assessConfidence(args: {
  reply: string
  handoff?: boolean
  /** parseGeneration's flag, since it strips NO_ANSWER_SENTINEL too. */
  noAnswer?: boolean
  retrieval?: RetrievalScores | null
  threshold?: number
}): ConfidenceResult {
  const { text, noAnswer, handoff: inText } = stripSentinels(args.reply ?? '')
  const threshold = clamp01(args.threshold ?? DEFAULT_CONFIDENCE_THRESHOLD)
  if (noAnswer || args.noAnswer) return { confident: false, score: 0, reason: 'no_answer', text }
  if (inText || args.handoff) return { confident: false, score: 0, reason: 'handoff', text }
  if (!text) return { confident: false, score: 0, reason: 'empty', text }
  const score = round(0.5 + 0.5 * retrievalScore(args.retrieval))
  const confident = score >= threshold
  return { confident, score, reason: confident ? 'answered' : 'low_score', text }
}
