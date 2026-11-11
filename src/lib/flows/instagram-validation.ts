// Publish checks for the Stage 2 Instagram triggers and steps (validate.ts
// calls these). Pure and client-safe, like validate.ts: the builder shows the
// same issues the server refuses on publish. Limits come from
// src/lib/instagram/graph-limits.ts (what graph.ts enforces before a request)
// and IG_TRIGGER_LIMITS, so publish and send never disagree.
//
// Comment flows (ig_comment, and from Stage 3 ig_live_comment): every path from the entry reaches exactly one
// ig_private_reply before any other step that messages the customer (Meta
// allows one private reply per comment, and nothing else until the person
// answers). Only tags, fields, conditions, agent assignment, API calls and the
// public comment reply may come first. The private reply itself takes no
// delay, and without an opening button no direct message may follow it.
import { getT } from "@/lib/i18n/translate";
import { INSTAGRAM_LIMITS, charLength, utf8Bytes, validCommentReply, validHttpsUrl } from "@/lib/instagram/graph-limits";
import { scopeIncludes } from "@/lib/channels/capabilities";
import { isRefKey } from "@/lib/instagram/ref-links";
import { IG_PROFILE_FACTS, IG_TRIGGER_LIMITS, startsFromComment, type FlowChannelScope, type FlowTriggerType } from "./types";

const tTriggers = getT("Flows.triggers");
const tNodes = getT("Flows.nodes");
const tFlows = getT("Validation.flows");

export interface IgIssue {
  severity: "error" | "warning";
  scope: "flow" | "trigger" | "node";
  node_key?: string;
  field?: string;
  message: string;
}

interface NodeInput {
  node_key: string;
  node_type: string;
  config: Record<string, unknown>;
}

/**
 * Steps that message the customer in the DM thread, so an Instagram run checks
 * the 24-hour window before each one (engine.ts). The rest touch no thread
 * (logic, tags, the public comment reply) or follow their own window (the
 * private reply answers the comment, within 7 days of it).
 */
const NO_DM_STEPS: ReadonlySet<string> = new Set([
  "start", "condition", "set_tag", "set_attribute", "api_request", "assign_agent", "connect_flow", "conversion_event",
  "handoff", "end", "ig_comment_reply", "ig_private_reply",
]);
export function needsMessagingWindow(nodeType: string): boolean {
  return !NO_DM_STEPS.has(nodeType);
}

/** Steps a comment flow may run before its private reply. */
const BEFORE_PRIVATE_REPLY: ReadonlySet<string> = new Set([
  "start", "condition", "set_tag", "set_attribute", "api_request", "assign_agent", "ig_comment_reply",
]);

const IG_ID = /^\d{1,32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODES = ["contains", "exact"];
const FREQUENCIES = ["every_time", "once_per_24h"];

const stringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === "string");

/** A keyword list fits: at most `max` words, each at most IG_TRIGGER_LIMITS.keywordChars. */
const keywordsFit = (value: unknown): boolean => value === undefined || (stringList(value) &&
  value.length <= IG_TRIGGER_LIMITS.keywords && value.every((k) => charLength(k) <= IG_TRIGGER_LIMITS.keywordChars));

/** Trigger config checks for the Stage 2 triggers; other triggers get none here. */
export function igTriggerIssues(triggerType: FlowTriggerType, config: Record<string, unknown>): IgIssue[] {
  const issues: IgIssue[] = [];
  const at = (field: string, message: string) => issues.push({ severity: "error", scope: "trigger", field: `trigger_config.${field}`, message });
  if (triggerType === "ig_comment") {
    if (config.instagram_account_id !== undefined && (typeof config.instagram_account_id !== "string" || !UUID.test(config.instagram_account_id)))
      at("instagram_account_id", tTriggers("igComment.badAccount"));
    const scope = config.post_scope;
    if (scope !== "any" && scope !== "specific" && scope !== "next") at("post_scope", tTriggers("igComment.badPostScope"));
    if (scope === "specific") {
      const ids = config.media_ids;
      if (!Array.isArray(ids) || ids.length === 0) at("media_ids", tTriggers("igComment.needsPosts"));
      else if (ids.length > IG_TRIGGER_LIMITS.mediaIds || ids.some((id) => typeof id !== "string" || !IG_ID.test(id)))
        at("media_ids", tTriggers("igComment.badPostIds", { max: IG_TRIGGER_LIMITS.mediaIds }));
    }
    if (scope === "next" && !(typeof config.next_after === "string" && Number.isFinite(Date.parse(config.next_after))))
      at("next_after", tTriggers("igComment.needsNextAfter"));
    if (config.resolved_media_id !== undefined && (typeof config.resolved_media_id !== "string" || !IG_ID.test(config.resolved_media_id)))
      at("resolved_media_id", tTriggers("igComment.badPostIds", { max: 1 }));
    for (const list of ["include_keywords", "exclude_keywords"] as const) {
      const value = config[list];
      if (value !== undefined && (!stringList(value) || value.length > IG_TRIGGER_LIMITS.keywords))
        at(list, tTriggers("igComment.tooManyKeywords", { max: IG_TRIGGER_LIMITS.keywords }));
      else if (!keywordsFit(value)) at(list, tTriggers("igComment.keywordTooLong", { max: IG_TRIGGER_LIMITS.keywordChars }));
    }
    for (const mode of ["include_mode", "exclude_mode"] as const) {
      if (config[mode] !== undefined && !MODES.includes(config[mode] as string)) at(mode, tTriggers("igComment.badPostScope"));
    }
    const replies = config.public_replies;
    if (replies !== undefined) {
      if (!Array.isArray(replies) || replies.length > IG_TRIGGER_LIMITS.publicReplies)
        at("public_replies", tTriggers("igComment.tooManyPublicReplies", { max: IG_TRIGGER_LIMITS.publicReplies }));
      else if (replies.some((r) => !validCommentReply(r)))
        at("public_replies", tTriggers("igComment.publicReplyTooLong", { max: INSTAGRAM_LIMITS.commentReplyChars }));
    }
  } else if (triggerType === "ig_story_reply") {
    const ids = config.story_ids;
    if (ids !== undefined && (!Array.isArray(ids) || ids.length > IG_TRIGGER_LIMITS.storyIds || ids.some((id) => typeof id !== "string" || !IG_ID.test(id))))
      at("story_ids", tTriggers("igStoryReply.badStoryIds", { max: IG_TRIGGER_LIMITS.storyIds }));
    if (!keywordsFit(config.keywords))
      at("keywords", tTriggers("igStoryReply.badKeywords", { max: IG_TRIGGER_LIMITS.keywords, chars: IG_TRIGGER_LIMITS.keywordChars }));
    if (config.match_mode !== undefined && !MODES.includes(config.match_mode as string))
      at("match_mode", tTriggers("igStoryReply.badKeywords", { max: IG_TRIGGER_LIMITS.keywords, chars: IG_TRIGGER_LIMITS.keywordChars }));
    if (config.reactions !== undefined && typeof config.reactions !== "boolean") at("reactions", tTriggers("igStoryReply.badStoryIds", { max: IG_TRIGGER_LIMITS.storyIds }));
  } else if (triggerType === "ig_live_comment") {
    if (config.instagram_account_id !== undefined && (typeof config.instagram_account_id !== "string" || !UUID.test(config.instagram_account_id)))
      at("instagram_account_id", tTriggers("igLiveComment.badAccount"));
    if (!keywordsFit(config.keywords))
      at("keywords", tTriggers("igLiveComment.badKeywords", { max: IG_TRIGGER_LIMITS.keywords, chars: IG_TRIGGER_LIMITS.keywordChars }));
    if (config.match_mode !== undefined && !MODES.includes(config.match_mode as string))
      at("match_mode", tTriggers("igLiveComment.badKeywords", { max: IG_TRIGGER_LIMITS.keywords, chars: IG_TRIGGER_LIMITS.keywordChars }));
  } else if (triggerType === "ig_ref") {
    if (config.instagram_account_id !== undefined && (typeof config.instagram_account_id !== "string" || !UUID.test(config.instagram_account_id)))
      at("instagram_account_id", tTriggers("igRef.badAccount"));
    const refs = config.refs;
    if (!Array.isArray(refs) || refs.length === 0) at("refs", tTriggers("igRef.needsKeys"));
    else if (refs.length > IG_TRIGGER_LIMITS.refs) at("refs", tTriggers("igRef.tooManyKeys", { max: IG_TRIGGER_LIMITS.refs }));
    else if (!refs.every(isRefKey)) at("refs", tTriggers("igRef.badKeys", { max: IG_TRIGGER_LIMITS.refs }));
    else if (new Set(refs.map((r) => r.toLowerCase())).size !== refs.length) at("refs", tTriggers("igRef.badKeys", { max: IG_TRIGGER_LIMITS.refs }));
  } else if (triggerType === "ig_story_mention") {
    if (!FREQUENCIES.includes(config.frequency as string)) at("frequency", tTriggers("igStoryMention.badFrequency"));
  } else if (triggerType === "default_reply") {
    if (config.frequency !== undefined && !FREQUENCIES.includes(config.frequency as string)) at("frequency", tTriggers("igStoryMention.badFrequency"));
  }
  return issues;
}

/** The port issue validate.ts uses for every "next" link. */
function nextIssues(node: NodeInput, knownKeys: ReadonlySet<string>, field: string, required: boolean): IgIssue[] {
  const key = node.config[field];
  if (!key) return required ? [{ severity: "error", scope: "node", node_key: node.node_key, field, message: tFlows("nodeNeedsNext") }] : [];
  if (typeof key !== "string" || !knownKeys.has(key))
    return [{ severity: "error", scope: "node", node_key: node.node_key, field, message: tFlows("nodeMissingNext", { key: String(key) }) }];
  return [];
}

/** The cards of a send_card / send_gallery node (raw config). */
export function configCards(node: NodeInput): Array<Record<string, unknown>> {
  if (node.node_type === "send_card") return node.config.card && typeof node.config.card === "object" ? [node.config.card as Record<string, unknown>] : [];
  return Array.isArray(node.config.cards) ? (node.config.cards as unknown[]).map((c) => (c && typeof c === "object" ? c as Record<string, unknown> : {})) : [];
}

/** Routed postback buttons of a card node (their next_node_key), in order. */
export function cardRouteTargets(node: NodeInput): string[] {
  return configCards(node).flatMap((card) => (Array.isArray(card.buttons) ? card.buttons as Array<Record<string, unknown>> : []))
    .filter((b) => b && b.type === "postback" && typeof b.next_node_key === "string" && b.next_node_key)
    .map((b) => b.next_node_key as string);
}

/** A private reply with an opening button waits for the tap. */
export const privateReplyWaits = (config: Record<string, unknown>): boolean =>
  typeof config.opt_in_label === "string" && config.opt_in_label.trim() !== "";

function cardIssues(node: NodeInput, knownKeys: ReadonlySet<string>): IgIssue[] {
  const issues: IgIssue[] = [];
  const at = (field: string, message: string) => issues.push({ severity: "error", scope: "node", node_key: node.node_key, field, message });
  const cards = configCards(node);
  const base = node.node_type === "send_card" ? "card" : "cards";
  if (node.node_type === "send_gallery") {
    if (!Array.isArray(node.config.cards) || cards.length === 0) at("cards", tNodes("gallery.needsCard"));
    else if (cards.length > INSTAGRAM_LIMITS.genericCards) at("cards", tNodes("gallery.maxCards", { max: INSTAGRAM_LIMITS.genericCards }));
  } else if (!cards.length) at("card", tNodes("card.titleRequired"));
  const replyIds = new Set<string>();
  cards.forEach((card, i) => {
    const prefix = node.node_type === "send_card" ? "card" : `${base}.${i}`;
    const title = card.title;
    if (typeof title !== "string" || !title.trim()) at(`${prefix}.title`, tNodes("card.titleRequired"));
    else if (charLength(title) > INSTAGRAM_LIMITS.cardTitleChars) at(`${prefix}.title`, tNodes("card.titleTooLong", { max: INSTAGRAM_LIMITS.cardTitleChars }));
    if (card.subtitle !== undefined && card.subtitle !== "" &&
      (typeof card.subtitle !== "string" || charLength(card.subtitle) > INSTAGRAM_LIMITS.cardSubtitleChars))
      at(`${prefix}.subtitle`, tNodes("card.subtitleTooLong", { max: INSTAGRAM_LIMITS.cardSubtitleChars }));
    for (const field of ["image_url", "default_url"] as const) {
      if (card[field] !== undefined && card[field] !== "" && !validHttpsUrl(card[field])) at(`${prefix}.${field}`, tNodes("card.badUrl"));
    }
    const buttons = card.buttons;
    if (buttons === undefined) return;
    if (!Array.isArray(buttons) || buttons.length > INSTAGRAM_LIMITS.buttons) {
      at(`${prefix}.buttons`, tNodes("card.maxButtons", { max: INSTAGRAM_LIMITS.buttons }));
      return;
    }
    buttons.forEach((raw, j) => {
      const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const field = `${prefix}.buttons.${j}`;
      const titled = typeof b.title === "string" && b.title.trim() !== "" && charLength(b.title) <= INSTAGRAM_LIMITS.buttonTitleChars;
      if (b.type === "web_url") {
        if (!titled || !validHttpsUrl(b.url)) at(field, tNodes("card.buttonInvalid", { max: INSTAGRAM_LIMITS.buttonTitleChars }));
      } else if (b.type === "postback") {
        const id = typeof b.reply_id === "string" ? b.reply_id : "";
        if (!titled || !id.trim() || id.length > INSTAGRAM_LIMITS.postbackPayloadChars) at(field, tNodes("card.buttonInvalid", { max: INSTAGRAM_LIMITS.buttonTitleChars }));
        else if (replyIds.has(id)) at(`${field}.reply_id`, tFlows("duplicateButtonReplyId", { id }));
        replyIds.add(id);
        const next = b.next_node_key;
        if (!next) at(`${field}.next_node_key`, tFlows("buttonNeedsNext", { n: j + 1 }));
        else if (typeof next !== "string" || !knownKeys.has(next)) at(`${field}.next_node_key`, tFlows("buttonMissingNext", { n: j + 1, key: String(next) }));
      } else {
        at(field, tNodes("card.buttonInvalid", { max: INSTAGRAM_LIMITS.buttonTitleChars }));
      }
    });
  });
  const routed = cardRouteTargets(node).length > 0;
  if (routed && node.config.next_node_key) at("next_node_key", tNodes("card.routesAndNext"));
  if (!routed) issues.push(...nextIssues(node, knownKeys, "next_node_key", false));
  return issues;
}

/** Config checks for the Instagram-only steps and Instagram link buttons. */
export function igNodeIssues(node: NodeInput, knownKeys: ReadonlySet<string>): IgIssue[] {
  const cfg = node.config;
  const issues: IgIssue[] = [];
  const at = (field: string, message: string, severity: "error" | "warning" = "error") =>
    issues.push({ severity, scope: "node", node_key: node.node_key, field, message });
  switch (node.node_type) {
    case "ig_comment_reply": {
      const replies = cfg.replies;
      if (!Array.isArray(replies) || replies.length === 0) at("replies", tNodes("igCommentReply.needsReply"));
      else if (replies.length > IG_TRIGGER_LIMITS.publicReplies) at("replies", tNodes("igCommentReply.maxReplies", { max: IG_TRIGGER_LIMITS.publicReplies }));
      else if (replies.some((r) => !validCommentReply(r))) at("replies", tNodes("igCommentReply.tooLong", { max: INSTAGRAM_LIMITS.commentReplyChars }));
      issues.push(...nextIssues(node, knownKeys, "next_node_key", false));
      break;
    }
    case "ig_private_reply": {
      if (typeof cfg.text !== "string" || !cfg.text.trim()) at("text", tNodes("igPrivateReply.textRequired"));
      else if (utf8Bytes(cfg.text) > INSTAGRAM_LIMITS.textBytes) at("text", tNodes("igPrivateReply.textTooLong", { max: INSTAGRAM_LIMITS.textBytes }));
      const label = cfg.opt_in_label;
      if (label !== undefined && label !== "" && (typeof label !== "string" || charLength(label.trim()) > INSTAGRAM_LIMITS.quickReplyTitleChars))
        at("opt_in_label", tNodes("igPrivateReply.optInTooLong", { max: INSTAGRAM_LIMITS.quickReplyTitleChars }));
      // No typing delay before the private reply (Meta: one message, sent as the reply to the comment).
      if (cfg.delay_seconds !== undefined && cfg.delay_seconds !== null) at("delay_seconds", tNodes("igPrivateReply.noInput"));
      issues.push(...nextIssues(node, knownKeys, "next_node_key", privateReplyWaits(cfg)));
      break;
    }
    case "send_card":
    case "send_gallery":
      issues.push(...cardIssues(node, knownKeys));
      break;
    case "send_buttons": {
      const links = cfg.link_buttons;
      if (links === undefined) break;
      const reply = Array.isArray(cfg.buttons) ? cfg.buttons.length : 0;
      if (!Array.isArray(links) || reply + links.length > INSTAGRAM_LIMITS.buttons) {
        at("link_buttons", tNodes("buttons.maxButtons", { max: INSTAGRAM_LIMITS.buttons }));
        break;
      }
      links.forEach((raw, i) => {
        const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
        if (typeof b.title !== "string" || !b.title.trim() || charLength(b.title) > INSTAGRAM_LIMITS.buttonTitleChars || !validHttpsUrl(b.url))
          at(`link_buttons.${i}`, tNodes("buttons.badLink", { max: INSTAGRAM_LIMITS.buttonTitleChars }));
      });
      const text = [cfg.header_text, cfg.text, cfg.footer_text].filter((p): p is string => typeof p === "string" && p.trim() !== "").join("\n\n");
      if (links.length && charLength(text) > INSTAGRAM_LIMITS.buttonTemplateTextChars)
        at("text", tNodes("buttons.textTooLong", { max: INSTAGRAM_LIMITS.buttonTemplateTextChars }));
      break;
    }
  }
  return issues;
}

/** The next nodes of a node for the comment-flow walk (every branch, plus a timeout port). */
type Successors = (node: NodeInput) => string[];

/**
 * Flow-level Instagram rules: link buttons and profile conditions only where
 * the flow runs on Instagram alone; the comment-reply step only in comment
 * flows; and the comment-flow private-reply shape described at the top.
 */
export function igFlowIssues(
  flow: { trigger_type: FlowTriggerType; entry_node_id: string | null; channel_scope?: FlowChannelScope | null },
  nodes: readonly NodeInput[],
  successors: Successors,
): IgIssue[] {
  const issues: IgIssue[] = [];
  const onWhatsApp = scopeIncludes(flow.channel_scope, "whatsapp");
  const comment = startsFromComment(flow.trigger_type);
  for (const node of nodes) {
    const at = (field: string, message: string) => issues.push({ severity: "error", scope: "node", node_key: node.node_key, field, message });
    if (onWhatsApp && node.node_type === "send_buttons" && Array.isArray(node.config.link_buttons) && node.config.link_buttons.length)
      at("link_buttons", tNodes("buttons.linkOnlyInstagram"));
    if (node.node_type === "condition") {
      const rules = Array.isArray(node.config.rules) ? node.config.rules as Array<Record<string, unknown>> : [node.config];
      rules.forEach((rule, i) => {
        if (rule?.subject !== "ig_profile") return;
        const field = Array.isArray(node.config.rules) ? `rules.${i}.subject` : "subject";
        if (onWhatsApp) at(field, tNodes("igProfile.onlyInstagram"));
        if (!(IG_PROFILE_FACTS as readonly unknown[]).includes(rule.subject_key)) at(field.replace(/subject$/, "subject_key"), tNodes("igProfile.badFact"));
      });
    }
    // A Live comment gets no public reply (Stage 3): that step stays in post-comment flows.
    if (node.node_type === "ig_comment_reply" && flow.trigger_type !== "ig_comment") at("node_type", tNodes("igCommentReply.onlyCommentFlows"));
    else if (!comment && node.node_type === "ig_private_reply") at("node_type", tNodes("igPrivateReply.firstOnly"));
  }
  if (!comment || !flow.entry_node_id) return issues;

  const byKey = new Map(nodes.map((n) => [n.node_key, n]));
  // Walk every path from the entry through the steps allowed before the private reply.
  const first = new Set<string>();
  const seen = new Set<string>();
  const pending = [flow.entry_node_id];
  let flowIssue = false;
  while (pending.length) {
    const key = pending.pop()!;
    if (seen.has(key)) continue;
    seen.add(key);
    const node = byKey.get(key);
    if (!node) continue;
    if (node.node_type === "ig_private_reply") {
      first.add(key);
      continue;
    }
    if (!BEFORE_PRIVATE_REPLY.has(node.node_type)) {
      // A path that messages the customer, waits or ends before the private reply.
      issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "node_type", message: tNodes("igPrivateReply.firstOnly") });
      flowIssue = true;
      continue;
    }
    pending.push(...successors(node));
  }
  if (!first.size && !flowIssue) issues.push({ severity: "error", scope: "flow", message: tNodes("igPrivateReply.firstOnly") });

  for (const node of nodes) {
    if (node.node_type !== "ig_private_reply") continue;
    if (!first.has(node.node_key)) {
      issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "node_type", message: tNodes("igPrivateReply.onlyOne") });
      continue;
    }
    // After the private reply: no direct message unless the opening button waits first.
    const waits = privateReplyWaits(node.config);
    const after = new Set<string>();
    const queue = successors(node);
    while (queue.length) {
      const key = queue.pop()!;
      if (after.has(key)) continue;
      after.add(key);
      const next = byKey.get(key);
      if (!next) continue;
      // A second private reply is reported above (it is not a first one).
      if (next.node_type === "ig_private_reply") continue;
      if (!waits && needsMessagingWindow(next.node_type)) {
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "opt_in_label", message: tNodes("igPrivateReply.noDmWithoutOptIn") });
        break;
      }
      queue.push(...successors(next));
    }
  }
  return issues;
}
