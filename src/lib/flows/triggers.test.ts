import { describe, expect, it } from "vitest";
import { byPrecedence, isTestContact, keywordTriggerMatches, phoneDigits, templateReplyMatch } from "./triggers";
import type { FlowRow, ParsedInbound } from "./types";

const tap = (patch: Partial<Extract<ParsedInbound, { kind: "interactive_reply" }>> = {}): ParsedInbound =>
  ({ kind: "interactive_reply", reply_id: "Track", reply_title: "Track", meta_message_id: "m", context_template: "order_update", ...patch });

describe("keyword triggers", () => {
  it("searches a regex, with or without case", async () => {
    expect(await keywordTriggerMatches("my ORDER #123 please", { keywords: [], match_type: "regex", pattern: "order\\s*#?\\d+" })).toBe(true);
    expect(await keywordTriggerMatches("my ORDER #123", { keywords: [], match_type: "regex", pattern: "order\\s*#?\\d+", case_sensitive: true })).toBe(false);
    expect(await keywordTriggerMatches("hello", { keywords: [], match_type: "regex", pattern: "(" })).toBe(false);
    expect(await keywordTriggerMatches("hello", { keywords: [], match_type: "regex" })).toBe(false);
  });

  it("gives up on a catastrophic pattern instead of hanging", async () => {
    const started = Date.now();
    expect(await keywordTriggerMatches("a".repeat(40) + "!", { keywords: [], match_type: "regex", pattern: "(a+)+$" })).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("template-reply triggers", () => {
  it("matches a tap on the right template and records the button", () => {
    expect(templateReplyMatch(tap(), { template_name: "order_update" })).toEqual({ trigger_button: "Track" });
    expect(templateReplyMatch(tap(), { template_name: "order_update", buttons: ["Track"] })).toEqual({ trigger_button: "Track" });
  });

  it("ignores other templates, other buttons, plain text and taps with no template", () => {
    expect(templateReplyMatch(tap(), { template_name: "promo" })).toBeNull();
    expect(templateReplyMatch(tap(), { template_name: "order_update", buttons: ["Help"] })).toBeNull();
    expect(templateReplyMatch(tap({ context_template: undefined }), { template_name: "order_update" })).toBeNull();
    expect(templateReplyMatch({ kind: "text", text: "Track", meta_message_id: "m" }, { template_name: "order_update" })).toBeNull();
  });
});

it("orders flows by trigger precedence, then testing drafts, then age", () => {
  const flows: { id: string; trigger_type: FlowRow["trigger_type"]; created_at: string; status: FlowRow["status"] }[] = [
    { id: "first", trigger_type: "first_inbound_message", created_at: "2026-01-01", status: "active" },
    { id: "kw-new", trigger_type: "keyword", created_at: "2026-03-01", status: "active" },
    { id: "tpl", trigger_type: "template_reply", created_at: "2026-05-01", status: "active" },
    { id: "kw-old", trigger_type: "keyword", created_at: "2026-02-01", status: "active" },
    { id: "kw-draft", trigger_type: "keyword", created_at: "2026-06-01", status: "draft" },
  ];
  expect(byPrecedence(flows).map((f) => f.id)).toEqual(["tpl", "kw-draft", "kw-old", "kw-new", "first"]);
});

it("lets a draft run only for its test numbers", () => {
  const draft = { status: "draft" as const, test_numbers: ["919876543210"] };
  expect(isTestContact(draft, phoneDigits("+91 98765-43210"))).toBe(true);
  expect(isTestContact(draft, "14155550100")).toBe(false);
  expect(isTestContact(draft, "")).toBe(false);
  expect(isTestContact({ ...draft, status: "active" }, "919876543210")).toBe(false);
});
