// Stage 2C: the story and default-reply trigger rules (pure).
import { describe, expect, it } from "vitest";
import { byPrecedence, defaultReplyApplies, instagramFactsFrom, shareToStoryMatches, storyReplyMatches } from "./triggers";

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

// Stage 4B: Share-to-Story (documented fixture; needs live capture, dark behind INSTAGRAM_SHARE_TO_STORY_ENABLED).
describe("share to story", () => {
  it("reads the fixed flag only, and ranks between story mentions and story replies", () => {
    expect(instagramFactsFrom({ ig: { share_to_story: true, url: "https://cdn.example/p" } })).toEqual({ shareToStory: true });
    expect(instagramFactsFrom({ ig: { share_to_story: "true" } })).toEqual({});
    const flow = (trigger_type: string) => ({ trigger_type, created_at: "2026-01-01", status: "active" }) as never;
    const order = byPrecedence([flow("keyword"), flow("ig_story_reply"), flow("ig_share_to_story"), flow("ig_story_mention")])
      .map((f: { trigger_type: string }) => f.trigger_type);
    expect(order).toEqual(["ig_story_mention", "ig_share_to_story", "ig_story_reply", "keyword"]);
  });
  it("matches only a share, on the trigger's account (or any), and the default reply ignores it", () => {
    const every = "every_time" as const;
    expect(shareToStoryMatches({ shareToStory: true }, { frequency: every }, "acct-1")).toBe(true);
    expect(shareToStoryMatches({ shareToStory: true }, { frequency: every, instagram_account_id: "acct-2" }, "acct-1")).toBe(false);
    expect(shareToStoryMatches({ shareToStory: true }, { frequency: every, instagram_account_id: "acct-1" }, "acct-1")).toBe(true);
    expect(shareToStoryMatches({ storyMention: true }, { frequency: every }, "acct-1")).toBe(false);
    expect(defaultReplyApplies(text("hi"), { shareToStory: true }, false)).toBe(false);
  });
});
