// Which ig_comment flow a comment starts (Stage 2, plan item 2). Pure: no I/O.
//
// The webhook processor (process-webhook.ts) calls these inside its tenant
// transaction, where the comment text is still in memory; the text is never
// stored or logged. It ranks the workspace's live comment flows, and only a
// person's first comment on a post is offered to them at all.
//
// Post scope:
//   any       every post
//   specific  the listed media ids
//   next      the first post published after `next_after`. It is resolved by
//             the first comment that starts the flow on it (that comment's
//             event row links the run, so later comments read the media id
//             back). Until then a comment needs the post's publish time from
//             Graph, which only the private-reply job may fetch: such a flow is
//             a 'check' candidate, decided by isNextPost.
// Keywords: include (empty matches any comment) and exclude (wins over a
// match), each with its own mode, case-insensitive and trimmed.
import type { IgCommentTriggerConfig, IgKeywordMode } from '@/lib/flows/types';

export type PostMatch = 'yes' | 'no' | 'check';

export interface CommentFacts {
  instagramAccountId: string;
  mediaId: string | null;
  /** The comment text (memory only). */
  text: string;
}

const MEDIA_ID = /^\d{1,32}$/;

/** Lower-cased, Unicode-normalised and trimmed, so "PRICE " and "price" are the same word. */
export function normalizeForMatch(text: string): string {
  return text.normalize('NFKC').trim().toLowerCase();
}

const words = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((k): k is string => typeof k === 'string' && k.trim().length > 0).map(normalizeForMatch) : [];

/** Whether any keyword matches: `contains` anywhere in the text, `exact` the whole text. */
export function keywordListMatches(text: string, keywords: unknown, mode: IgKeywordMode | undefined): boolean {
  const list = words(keywords);
  if (!list.length) return false;
  const haystack = normalizeForMatch(text);
  return mode === 'exact' ? list.includes(haystack) : list.some((k) => haystack.includes(k));
}

/** True when the list has at least one usable keyword. */
export const hasKeywords = (value: unknown): boolean => words(value).length > 0;

/**
 * Whether the post fits the trigger's scope. `resolvedNext` is the post a
 * `next` flow already started on (read from its linked comment events).
 */
export function postScopeMatch(cfg: IgCommentTriggerConfig, mediaId: string | null, resolvedNext: string | null = null): PostMatch {
  if (cfg.post_scope === 'any') return 'yes';
  if (!mediaId || !MEDIA_ID.test(mediaId)) return 'no';
  if (cfg.post_scope === 'specific') return Array.isArray(cfg.media_ids) && cfg.media_ids.includes(mediaId) ? 'yes' : 'no';
  if (cfg.post_scope !== 'next') return 'no';
  const resolved = (typeof cfg.resolved_media_id === 'string' && cfg.resolved_media_id) || resolvedNext;
  if (resolved) return resolved === mediaId ? 'yes' : 'no';
  return typeof cfg.next_after === 'string' && Number.isFinite(Date.parse(cfg.next_after)) ? 'check' : 'no';
}

/** Whether a comment fits an ig_comment trigger ('check': only if its post is the next post). */
export function commentMatchesTrigger(cfg: IgCommentTriggerConfig, comment: CommentFacts, resolvedNext: string | null = null): PostMatch {
  if (cfg.instagram_account_id && cfg.instagram_account_id !== comment.instagramAccountId) return 'no';
  const post = postScopeMatch(cfg, comment.mediaId, resolvedNext);
  if (post === 'no') return 'no';
  if (hasKeywords(cfg.include_keywords) && !keywordListMatches(comment.text, cfg.include_keywords, cfg.include_mode)) return 'no';
  if (keywordListMatches(comment.text, cfg.exclude_keywords, cfg.exclude_mode)) return 'no';
  return post;
}

export interface CommentFlowCandidate {
  flowId: string;
  createdAt: string;
  config: IgCommentTriggerConfig;
}

const SCOPE_RANK: Record<string, number> = { specific: 0, next: 1, any: 2 };

/** Specific posts first, then the next post, then any post; the oldest flow first within each. */
export function rankCommentFlows<T extends CommentFlowCandidate>(flows: readonly T[]): T[] {
  return [...flows].sort((a, b) =>
    (SCOPE_RANK[a.config.post_scope] ?? 9) - (SCOPE_RANK[b.config.post_scope] ?? 9)
    || a.createdAt.localeCompare(b.createdAt) || a.flowId.localeCompare(b.flowId));
}

export interface MediaTime { id: string; timestamp: string | null }

/**
 * Whether `mediaId` is the first post published after `nextAfter`, among the
 * account's recent posts (newest 50 from Graph). Unknown times never match.
 */
export function isNextPost(mediaId: string | null, media: readonly MediaTime[], nextAfter: string | undefined): boolean {
  const after = typeof nextAfter === 'string' ? Date.parse(nextAfter) : NaN;
  if (!mediaId || !Number.isFinite(after)) return false;
  let first: { id: string; at: number } | null = null;
  for (const item of media) {
    const at = item.timestamp ? Date.parse(item.timestamp) : NaN;
    if (!Number.isFinite(at) || at <= after) continue;
    if (!first || at < first.at || (at === first.at && item.id < first.id)) first = { id: item.id, at };
  }
  return first?.id === mediaId;
}

/**
 * One of the public reply variants, rotated by the comment id. Deterministic,
 * so a retried job picks the same one; null when none is usable.
 */
export function pickPublicReply(replies: unknown, commentId: string, isValid: (text: string) => boolean): string | null {
  const usable = Array.isArray(replies) ? replies.filter((r): r is string => typeof r === 'string' && isValid(r)) : [];
  if (!usable.length) return null;
  let hash = 0;
  for (const ch of commentId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return usable[hash % usable.length];
}
