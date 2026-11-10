// Stage 2C: the story and default-reply trigger rules (pure).
import { describe, expect, it } from "vitest";
import { byPrecedence, defaultReplyApplies, instagramFactsFrom, storyReplyMatches } from "./triggers";

const text = (t: string) => ({ kind: "text" as const, text: t, meta_message_id: "m" });

describe("instagramFactsFrom", () => {
  it("reads only the fixed keys process-webhook writes", () => {
    expect(instagramFactsFrom({ ig: { story: true, story_id: "18011", url: "https://cdn.example/s" } }))
      .toEqual({ storyReply: { storyId: "18011", reaction: false } });
    expect(instagramFactsFrom({ ig: { story: true, story_id: "x'; drop", reaction: true } }))
      .toEqual({ storyReply: { storyId: null, reaction: true } });
    expect(instagramFactsFrom({ ig: { story_mention: true } })).toEqual({ storyMention: true });
    expect(instagramFactsFrom({ ig: { quick_reply: true } })).toEqual({});
    expect(instagramFactsFrom(null)).toEqual({});
    expect(instagramFactsFrom({ ig: "story" })).toEqual({});
  });
});

describe("storyReplyMatches", () => {
  const reply = { storyReply: { storyId: "18011", reaction: false } };
  const reaction = { storyReply: { storyId: "18011", reaction: true } };
  it("any story and any reply by default; keywords narrow text replies", () => {
    expect(storyReplyMatches(reply, "nice", {})).toBe(true);
    expect(storyReplyMatches(reply, "nice", { keywords: ["price"] })).toBe(false);
    expect(storyReplyMatches(reply, "PRICE?", { keywords: ["price"] })).toBe(true);
    expect(storyReplyMatches(reply, "price?", { keywords: ["price"], match_mode: "exact" })).toBe(false);
    expect(storyReplyMatches({}, "nice", {})).toBe(false);
  });
  it("reactions only when switched on; story ids must match", () => {
    expect(storyReplyMatches(reaction, "x", {})).toBe(false);
    expect(storyReplyMatches(reaction, "x", { reactions: true })).toBe(true);
    expect(storyReplyMatches(reply, "nice", { story_ids: ["1"] })).toBe(false);
    expect(storyReplyMatches({ storyReply: { storyId: null, reaction: false } }, "nice", { story_ids: ["18011"] })).toBe(false);
  });
});

describe("default reply", () => {
  it("never answers forms, carts, story mentions or our own postback codes", () => {
    expect(defaultReplyApplies(text("hi"), {}, false)).toBe(true);
    expect(defaultReplyApplies(text("hi"), { storyMention: true }, false)).toBe(false);
    expect(defaultReplyApplies(text("hi"), {}, true)).toBe(false);
    expect(defaultReplyApplies({ kind: "order", summary: "", vars: {}, meta_message_id: "m" }, {}, false)).toBe(false);
  });
  it("is the lowest tier; story triggers rank above keywords", () => {
    const flow = (trigger_type: string, created_at = "2026-01-01") => ({ trigger_type, created_at, status: "active" }) as never;
    const order = byPrecedence([flow("default_reply", "2020-01-01"), flow("keyword"), flow("first_inbound_message"), flow("ig_story_reply")])
      .map((f: { trigger_type: string }) => f.trigger_type);
    expect(order).toEqual(["ig_story_reply", "keyword", "first_inbound_message", "default_reply"]);
  });
});
