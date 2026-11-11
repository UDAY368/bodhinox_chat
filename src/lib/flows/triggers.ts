// Which flow an inbound message starts, when the contact has no active run.
//
// Precedence, highest first (an active run always takes the message before
// any of this, and the AI auto-reply only gets what no flow or automation
// took):
//   0. order_received   a cart sent from the catalogue
//   0b. ad_click        a message from a click-to-WhatsApp ad (Stage 3: or a
//                       click-to-Instagram-Direct ad)
//   0c. ig_ref          (Stage 3, Instagram) a chat opened from a ref link
//   1. template_reply   a tap on a sent template's quick-reply button
//   2. keyword          exact, contains or regex
//   3. first_inbound_message
//   (Instagram, Stage 2) ig_story_mention and ig_story_reply sit just above
//   keyword: a story reply that also contains a keyword starts the story flow.
//   4. default_reply  only when nothing above matched (lowest tier)
//   (Instagram, Stage 4) ig_share_to_story sits between the two, behind its flag.
// ig_comment and ig_live_comment flows never start from a message: comments
// start them (process-webhook.ts and private-reply.ts).
// Within a tier a draft being tested wins for its testers, then the oldest
// flow. `manual` flows never start here. A draft starts only for one of
// its test numbers (Instagram, Stage 5: or one of its test usernames).
// Stage 5: a flow may listen on extra triggers (flow-triggers.ts); each is
// ranked by its own tier. A keyword trigger with match_type "intent" is asked
// (one AI call for all of them) only after every exact trigger failed, just
// before default_reply.

import { regexMatches } from "./input-validation";
import { hasKeywords, keywordListMatches } from "@/lib/instagram/comment-matching";
import { normalizeInboundRef, refKeyMatches } from "@/lib/instagram/ref-links";
import { IG_TEST_USERNAME } from "./types";
import type {
  AdClickTriggerConfig, FlowRow, IgLiveCommentTriggerConfig, IgRefTriggerConfig, IgShareToStoryTriggerConfig, IgStoryReplyTriggerConfig, KeywordTriggerConfig,
  ParsedInbound, TemplateReplyTriggerConfig,
} from "./types";

const TIER: Record<string, number> = {
  order_received: -1, ad_click: -0.5, ig_ref: -0.4, template_reply: 0, ig_story_mention: 0.5, ig_share_to_story: 0.55, ig_story_reply: 0.6, keyword: 1,
  first_inbound_message: 2, default_reply: 3,
};

/** Digits only, the form contacts.phone_normalized and flows.test_numbers use. */
export function phoneDigits(phone: string | null | undefined): string {
  return (phone ?? "").replace(/\D/g, "");
}

/** Whether this draft flow may run for the contact: its number is one of the flow's test numbers. */
export function isTestContact(flow: Pick<FlowRow, "status" | "test_numbers">, contactDigits: string): boolean {
  return flow.status === "draft" && Boolean(contactDigits) && (flow.test_numbers ?? []).includes(contactDigits);
}

/** An Instagram username as flows.test_usernames stores it: trimmed, no leading @, lowercase. */
export function normalizeTestUsername(username: string | null | undefined): string {
  return (username ?? "").trim().replace(/^@/, "").toLowerCase();
}

/**
 * Whether this draft Instagram flow may run for the contact (Stage 5): the
 * contact's stored Instagram username is one of the flow's test usernames.
 * WhatsApp test numbers (isTestContact) are unchanged.
 */
export function isTestUsername(flow: Pick<FlowRow, "status" | "test_usernames">, username: string | null | undefined): boolean {
  const name = normalizeTestUsername(username);
  return flow.status === "draft" && IG_TEST_USERNAME.test(name) && (flow.test_usernames ?? []).includes(name);
}

/**
 * Flows ordered by trigger precedence; within a tier a draft being tested
 * comes first (its tester should see it, not the live flow it replaces),
 * then the oldest.
 */
export function byPrecedence<T extends Pick<FlowRow, "trigger_type" | "created_at" | "status">>(flows: T[]): T[] {
  const draftFirst = (f: T) => (f.status === "draft" ? 0 : 1);
  return [...flows].sort((a, b) =>
    (TIER[a.trigger_type] ?? 9) - (TIER[b.trigger_type] ?? 9) || draftFirst(a) - draftFirst(b) || a.created_at.localeCompare(b.created_at));
}

/**
 * Case-insensitive contains/exact match against a list of keywords, or a
 * searched regex when `match_type` is "regex". Regexes run isolated with a
 * deadline (see regexMatches).
 */
export async function keywordTriggerMatches(text: string, cfg: KeywordTriggerConfig): Promise<boolean> {
  if (!text) return false;
  // Matched by meaning (Stage 5) in engine.ts through lib/ai/intent-match.ts, never by words.
  if (cfg.match_type === "intent") return false;
  if (cfg.match_type === "regex") {
    return typeof cfg.pattern === "string" && cfg.pattern.length > 0 &&
      regexMatches(cfg.pattern, text, { caseSensitive: Boolean(cfg.case_sensitive) });
  }
  if (!cfg.keywords?.length) return false;
  const exact = cfg.match_type === "exact";
  const haystack = cfg.case_sensitive ? text : text.toLowerCase();
  return cfg.keywords.some((raw) => {
    if (!raw) return false;
    const needle = cfg.case_sensitive ? raw : raw.toLowerCase();
    return exact ? haystack === needle : haystack.includes(needle);
  });
}

/** The variables a template-reply start sets, or null when the tap is not for this flow. */
export function templateReplyMatch(message: ParsedInbound, cfg: TemplateReplyTriggerConfig): Record<string, string> | null {
  if (message.kind !== "interactive_reply" || !cfg.template_name || message.context_template !== cfg.template_name) return null;
  const wanted = (cfg.buttons ?? []).filter(Boolean);
  if (wanted.length && !wanted.includes(message.reply_title) && !wanted.includes(message.reply_id)) return null;
  return { trigger_button: message.reply_title || message.reply_id };
}

/** The variables an order_received start sets, or null when the message is not a cart. */
export function orderReceivedMatch(message: ParsedInbound): Record<string, string> | null {
  return message.kind === "order" ? { ...message.vars } : null;
}

/**
 * The variables an ad_click start sets, or null when the message did not
 * come from a click-to-WhatsApp ad (or from another ad than the listed ones).
 * The click id is never a variable.
 */
export function adClickMatch(message: ParsedInbound, cfg: AdClickTriggerConfig | null | undefined): Record<string, string> | null {
  const referral = message.referral;
  if (!referral || referral.source_type !== "ad") return null;
  const wanted = Array.isArray(cfg?.ad_ids) ? cfg.ad_ids.filter((id) => typeof id === "string" && id) : [];
  if (wanted.length && (!referral.source_id || !wanted.includes(referral.source_id))) return null;
  return { ad_id: referral.source_id ?? "", ad_headline: referral.headline ?? "", ad_source_url: referral.source_url ?? "" };
}

/** What an Instagram message is, from its stored row (process-webhook.ts writes interactive_payload.ig). */
export interface InstagramInboundFacts {
  /** A reply to one of the account's stories. */
  storyReply?: { storyId: string | null; reaction: boolean };
  /** A mention of the account in the customer's story. */
  storyMention?: boolean;
  /**
   * The customer shared one of the account's posts or reels to their story
   * (Stage 4). Needs live capture: built against a documented fixture, and only
   * acted on while INSTAGRAM_SHARE_TO_STORY_ENABLED is on.
   */
  shareToStory?: boolean;
  /**
   * The ref link or ad the chat was opened from (Stage 3). `ref` is already
   * checked against what we store (normalizeInboundRef); `fromAd` is a
   * click-to-Direct ad (Meta's referral source ADS). Needs live capture: built
   * against Meta's documented referral shape.
   */
  referral?: { ref: string | null; fromAd: boolean; adId: string | null; adTitle: string | null };
}

/** The facts a stored message's interactive_payload carries (fixed keys only; anything else is ignored). */
export function instagramFactsFrom(payload: unknown): InstagramInboundFacts {
  const ig = payload && typeof payload === "object" ? (payload as { ig?: unknown }).ig : null;
  if (!ig || typeof ig !== "object") return {};
  const row = ig as Record<string, unknown>;
  const facts: InstagramInboundFacts = {};
  const referral = row.referral && typeof row.referral === "object" ? row.referral as Record<string, unknown> : null;
  if (referral) {
    const ref = normalizeInboundRef(referral.ref);
    const fromAd = typeof referral.source === "string" && referral.source.toUpperCase() === "ADS";
    const adId = typeof referral.ad_id === "string" && /^\d{1,32}$/.test(referral.ad_id) ? referral.ad_id : null;
    const adTitle = typeof referral.ad_title === "string" ? referral.ad_title.slice(0, 256) : null;
    if (ref || fromAd) facts.referral = { ref, fromAd, adId, adTitle };
  }
  if (row.share_to_story === true) return { ...facts, shareToStory: true };
  if (row.story_mention === true) return { ...facts, storyMention: true };
  if (row.story === true) {
    const storyId = typeof row.story_id === "string" && /^\d{1,32}$/.test(row.story_id) ? row.story_id : null;
    return { ...facts, storyReply: { storyId, reaction: row.reaction === true } };
  }
  return facts;
}

/**
 * The variables an ig_ref start sets, or null when the chat was not opened
 * from one of the trigger's ref keys (compared without case) or the trigger is
 * tied to another Instagram account. The ref is a label, never a secret.
 */
export function refTriggerMatch(facts: InstagramInboundFacts, cfg: IgRefTriggerConfig | null | undefined,
  instagramAccountId: string | null): Record<string, string> | null {
  const ref = facts.referral?.ref;
  if (!ref || !Array.isArray(cfg?.refs)) return null;
  if (cfg.instagram_account_id && cfg.instagram_account_id !== instagramAccountId) return null;
  return refKeyMatches(cfg.refs, ref) ? { ig_ref: ref } : null;
}

/**
 * The variables an ad_click start sets for an Instagram conversation, or null
 * when the message did not come from a click-to-Direct ad (or from another ad
 * than the listed ones). Mirrors adClickMatch; the click id is never kept.
 */
export function igAdClickMatch(facts: InstagramInboundFacts, cfg: AdClickTriggerConfig | null | undefined): Record<string, string> | null {
  const referral = facts.referral;
  if (!referral?.fromAd) return null;
  const wanted = Array.isArray(cfg?.ad_ids) ? cfg.ad_ids.filter((id) => typeof id === "string" && id) : [];
  if (wanted.length && (!referral.adId || !wanted.includes(referral.adId))) return null;
  return { ad_id: referral.adId ?? "", ad_headline: referral.adTitle ?? "", ad_source_url: "" };
}

/**
 * Whether a Live comment starts an ig_live_comment flow: the trigger is for
 * this account (or any), and the comment holds one of its keywords (any
 * comment when none are set). Live comments are matched only against
 * ig_live_comment flows, post comments only against ig_comment flows.
 */
export function liveCommentMatches(cfg: IgLiveCommentTriggerConfig | null | undefined,
  comment: { instagramAccountId: string; text: string }): boolean {
  if (cfg?.instagram_account_id && cfg.instagram_account_id !== comment.instagramAccountId) return false;
  if (!hasKeywords(cfg?.keywords)) return true;
  return keywordListMatches(comment.text, cfg?.keywords, cfg?.match_mode);
}

/**
 * Whether a shared-to-story post starts an ig_share_to_story flow: the message
 * is a share to story and the trigger is for this account (or any). The caller
 * checks the INSTAGRAM_SHARE_TO_STORY_ENABLED flag and the frequency.
 */
export function shareToStoryMatches(facts: InstagramInboundFacts, cfg: IgShareToStoryTriggerConfig | null | undefined,
  instagramAccountId: string | null): boolean {
  if (!facts.shareToStory) return false;
  return !cfg?.instagram_account_id || cfg.instagram_account_id === instagramAccountId;
}

/**
 * Whether a story reply starts an ig_story_reply flow: the story is one of
 * `story_ids` (or any story when none are listed); an emoji reaction starts it
 * only with `reactions`; a text reply matches `keywords` (any reply when none).
 */
export function storyReplyMatches(facts: InstagramInboundFacts, text: string, cfg: IgStoryReplyTriggerConfig | null | undefined): boolean {
  const reply = facts.storyReply;
  if (!reply) return false;
  const ids = Array.isArray(cfg?.story_ids) ? cfg.story_ids.filter((id) => typeof id === "string" && id) : [];
  if (ids.length && (!reply.storyId || !ids.includes(reply.storyId))) return false;
  if (reply.reaction) return cfg?.reactions === true;
  if (!hasKeywords(cfg?.keywords)) return true;
  return keywordListMatches(text, cfg?.keywords, cfg?.match_mode);
}

/**
 * Whether a message may start a default_reply flow: an ordinary message (not
 * a form, a cart or a story mention) that nothing else matched. Our own
 * postback codes (conversation starters, opt-in and follow-check taps) never
 * fall through to it.
 */
export function defaultReplyApplies(message: ParsedInbound, facts: InstagramInboundFacts, isOurPostback: boolean): boolean {
  if (message.kind === "form" || message.kind === "order") return false;
  return !facts.storyMention && !facts.shareToStory && !isOurPostback;
}
