/**
 * Pure rules behind the trigger editors (Stage 2, 2D; Stage 3 adds Live
 * comments and ref links): each trigger's starting settings, the keyword /
 * post / story-id / ref-key lists with their limits, and the switch to a
 * comment trigger, which makes a private reply the flow's first step. No React and no I/O; the publish validator checks the
 * same limits again on the server.
 */

import {
  FLOW_TRIGGER_LIMITS,
  IG_TRIGGER_LIMITS,
  startsFromComment,
  type FlowTriggerType,
  type IgKeywordMode,
  type IgPostScope,
  type TriggerFrequency,
} from "@/lib/flows/types";
import { INSTAGRAM_LIMITS } from "@/lib/instagram/graph-limits";
import { toRefKey } from "@/lib/instagram/ref-links";
import { NODE_META, slugify } from "../shared";
import { defaultConfigFor, uniqueNodeKey, type BuilderState } from "../flow-editor-state";
import { clipChars, firstPrivateReplies, withPrivateReplyEntry } from "../nodes/ig-node-config";

type Config = Record<string, unknown>;

/** The settings a trigger starts with when the author picks it. */
export function defaultTriggerConfig(type: FlowTriggerType): Config {
  switch (type) {
    case "keyword":
      return { keywords: [] };
    case "template_reply":
      return { template_name: "", buttons: [] };
    case "default_reply":
    case "ig_story_mention":
    case "ig_share_to_story":
      return { frequency: "every_time" satisfies TriggerFrequency };
    case "ig_comment":
      return {
        post_scope: "any" satisfies IgPostScope,
        include_keywords: [], include_mode: "contains" satisfies IgKeywordMode,
        exclude_keywords: [], exclude_mode: "contains" satisfies IgKeywordMode,
        public_replies: [],
      };
    case "ig_story_reply":
      return { keywords: [], match_mode: "contains" satisfies IgKeywordMode, reactions: false };
    case "ig_live_comment":
      return { keywords: [], match_mode: "contains" satisfies IgKeywordMode };
    case "ig_ref":
      return { refs: [] };
    case "first_inbound_message":
    case "order_received":
    case "ad_click":
    case "manual":
      return {};
  }
}

/**
 * The state after the author picks `type` in the trigger picker: its
 * starting settings, and for a comment trigger (post or Live) a private reply
 * as the first step (added when the flow has none, made the entry when it has
 * one that a run does not already reach first).
 */
export function applyTriggerType(state: BuilderState, type: FlowTriggerType): BuilderState {
  const next: BuilderState = { ...state, trigger_type: type, trigger_config: defaultTriggerConfig(type) };
  if (!startsFromComment(type)) return next;
  return placePrivateReply(next);
}

/**
 * Makes a private reply the flow's first step (added when the flow has none),
 * as a comment trigger needs. Stage 5 also calls it when a comment trigger is
 * added beside the primary one.
 */
export function placePrivateReply(next: BuilderState): BuilderState {
  let nodes = next.nodes;
  let key = nodes.find((n) => n.node_type === "ig_private_reply")?.node_key;
  if (!key) {
    key = uniqueNodeKey(slugify(NODE_META.ig_private_reply.slugSeed, "ig_private_reply"), nodes);
    nodes = [...nodes, { node_key: key, node_type: "ig_private_reply", config: defaultConfigFor("ig_private_reply") }];
  }
  // Already first (for example behind a template's start step): leave the steps as they are.
  if (firstPrivateReplies(nodes, next.entry_node_id).has(key)) return { ...next, nodes };
  const placed = withPrivateReplyEntry(nodes, next.entry_node_id, key);
  return { ...next, nodes: placed.nodes, entry_node_id: placed.entry };
}

// ------------------------------------------------------------ reply delay (Stage 5)

export type ReplyDelayUnit = "seconds" | "minutes";

/** Seconds shown in the unit that divides them evenly (minutes when it can). */
export function replyDelayParts(value: unknown): { amount: number; unit: ReplyDelayUnit } {
  const seconds = typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  return seconds > 0 && seconds % 60 === 0 ? { amount: seconds / 60, unit: "minutes" } : { amount: seconds, unit: "seconds" };
}

/**
 * Stores "wait before replying" on a comment trigger: whole seconds, at most
 * FLOW_TRIGGER_LIMITS.replyDelaySecondsMax; nothing (or 0) removes the wait.
 */
export function setReplyDelay(config: Config, amount: number | null, unit: ReplyDelayUnit): Config {
  const next = { ...config };
  const seconds = amount === null || !Number.isFinite(amount) ? 0 : Math.trunc(amount) * (unit === "minutes" ? 60 : 1);
  if (seconds <= 0) delete next.reply_delay_seconds;
  else next.reply_delay_seconds = Math.min(seconds, FLOW_TRIGGER_LIMITS.replyDelaySecondsMax);
  return next;
}

// ------------------------------------------------------------ lists

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
export const readStrings = strings;

/**
 * Adds comma-separated keywords: trimmed, cut to 100 characters, without
 * case-insensitive duplicates, at most 50 in all.
 */
export function addKeywords(existing: readonly string[], text: string): string[] {
  const seen = new Set(existing.map((k) => k.toLowerCase()));
  const out = [...existing];
  for (const raw of text.split(",")) {
    const keyword = clipChars(raw.trim(), IG_TRIGGER_LIMITS.keywordChars);
    if (!keyword || seen.has(keyword.toLowerCase()) || out.length >= IG_TRIGGER_LIMITS.keywords) continue;
    seen.add(keyword.toLowerCase());
    out.push(keyword);
  }
  return out;
}

/** Adds Instagram ids (digits) from pasted text, without duplicates, at most `max`. */
export function addIds(existing: readonly string[], text: string, max: number): string[] {
  const out = [...existing];
  for (const raw of text.split(/[\s,]+/)) {
    const id = raw.trim();
    if (!/^\d{1,32}$/.test(id) || out.includes(id) || out.length >= max) continue;
    out.push(id);
  }
  return out;
}

/** Picks or un-picks a post, at most 50 picked. */
export function toggleMedia(config: Config, mediaId: string): Config {
  const ids = strings(config.media_ids);
  if (ids.includes(mediaId)) return { ...config, media_ids: ids.filter((id) => id !== mediaId) };
  if (ids.length >= IG_TRIGGER_LIMITS.mediaIds || !/^\d{1,32}$/.test(mediaId)) return config;
  return { ...config, media_ids: [...ids, mediaId] };
}

/**
 * Changes which posts a comment trigger listens on. `next` records when the
 * choice was made (the engine resolves the first post published after it);
 * picking it again later restarts that wait. Settings the new scope does not
 * use are dropped.
 */
export function setPostScope(config: Config, scope: IgPostScope, now: Date = new Date()): Config {
  const { media_ids: mediaIds, next_after: _after, resolved_media_id: _resolved, ...rest } = config;
  void _after;
  void _resolved;
  if (scope === "specific") return { ...rest, post_scope: scope, media_ids: strings(mediaIds) };
  if (scope === "next") return { ...rest, post_scope: scope, next_after: now.toISOString() };
  return { ...rest, post_scope: scope };
}

/**
 * Sets which Instagram account a trigger listens on (`null`: every connected
 * account). Posts belong to one account, so moving from one account to
 * another drops the posts chosen on the first; they would never be
 * commented on through the second.
 */
export function setTriggerAccount(config: Config, accountId: string | null): Config {
  const { instagram_account_id: previous, ...rest } = config;
  if (accountId === null) return rest;
  const next: Config = { ...rest, instagram_account_id: accountId };
  if (typeof previous === "string" && previous !== accountId && "media_ids" in next) next.media_ids = [];
  return next;
}

/** Public replies posted under the comment: at most 3, each within the comment cap; blanks are kept while typing. */
export function setPublicReplies(replies: readonly string[]): string[] {
  return replies.slice(0, IG_TRIGGER_LIMITS.publicReplies).map((r) => clipChars(r, INSTAGRAM_LIMITS.commentReplyChars));
}

/**
 * Adds comma-separated ref keys (Stage 3, ig_ref): each made link-safe with
 * toRefKey (spaces become hyphens), without case-insensitive duplicates, at
 * most IG_TRIGGER_LIMITS.refs in all.
 */
export function addRefKeys(existing: readonly string[], text: string): string[] {
  const seen = new Set(existing.map((k) => k.toLowerCase()));
  const out = [...existing];
  for (const raw of text.split(",")) {
    const key = toRefKey(raw);
    if (!key || seen.has(key.toLowerCase()) || out.length >= IG_TRIGGER_LIMITS.refs) continue;
    seen.add(key.toLowerCase());
    out.push(key);
  }
  return out;
}

