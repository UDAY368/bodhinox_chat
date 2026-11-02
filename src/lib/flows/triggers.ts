// Which flow an inbound message starts, when the contact has no active run.
//
// Precedence, highest first (an active run always takes the message before
// any of this, and the AI auto-reply only gets what no flow or automation
// took):
//   1. template_reply   a tap on a sent template's quick-reply button
//   2. keyword          exact, contains or regex
//   3. first_inbound_message
// Within a tier a draft being tested wins for its testers, then the oldest
// flow. `manual` flows never start here. A draft starts only for one of
// its test numbers.

import { regexMatches } from "./input-validation";
import type { FlowRow, KeywordTriggerConfig, ParsedInbound, TemplateReplyTriggerConfig } from "./types";

const TIER: Record<string, number> = { template_reply: 0, keyword: 1, first_inbound_message: 2 };

/** Digits only, the form contacts.phone_normalized and flows.test_numbers use. */
export function phoneDigits(phone: string | null | undefined): string {
  return (phone ?? "").replace(/\D/g, "");
}

/** Whether this draft flow may run for the contact: its number is one of the flow's test numbers. */
export function isTestContact(flow: Pick<FlowRow, "status" | "test_numbers">, contactDigits: string): boolean {
  return flow.status === "draft" && Boolean(contactDigits) && (flow.test_numbers ?? []).includes(contactDigits);
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
