import { describe, expect, it } from "vitest";
import { FLOW_TRIGGER_TYPES } from "@/lib/flows/types";
import { resolveFallbackPolicy } from "@/lib/flows/fallback";
import type { BuilderState } from "../flow-editor-state";
import { addIds, addKeywords, applyTriggerType, defaultTriggerConfig, setPostScope, setPublicReplies, toggleMedia } from "./ig-trigger-config";

const state = (patch: Partial<BuilderState> = {}): BuilderState => ({
  name: "f", description: "", trigger_type: "keyword", trigger_config: { keywords: ["hi"] }, entry_node_id: null, status: "draft",
  fallback_policy: resolveFallbackPolicy(undefined), test_numbers: [], nodes: [], ...patch,
});

describe("trigger settings", () => {
  it("gives every trigger type its starting settings", () => {
    for (const type of FLOW_TRIGGER_TYPES) expect(defaultTriggerConfig(type)).toBeTypeOf("object");
    expect(defaultTriggerConfig("ig_comment")).toEqual({
      post_scope: "any", include_keywords: [], include_mode: "contains", exclude_keywords: [], exclude_mode: "contains", public_replies: [],
    });
    expect(defaultTriggerConfig("default_reply")).toEqual({ frequency: "every_time" });
    expect(defaultTriggerConfig("ig_story_mention")).toEqual({ frequency: "every_time" });
    expect(defaultTriggerConfig("ig_story_reply")).toEqual({ keywords: [], match_mode: "contains", reactions: false });
    // Unchanged for the WhatsApp triggers.
    expect(defaultTriggerConfig("keyword")).toEqual({ keywords: [] });
    expect(defaultTriggerConfig("template_reply")).toEqual({ template_name: "", buttons: [] });
  });

  it("switching to a comment trigger adds a private reply as the first step", () => {
    const before = state({
      entry_node_id: "hello",
      nodes: [{ node_key: "hello", node_type: "send_message", config: { text: "hi", next_node_key: "" } }],
    });
    const after = applyTriggerType(before, "ig_comment");
    expect(after.trigger_type).toBe("ig_comment");
    const reply = after.nodes.find((n) => n.node_type === "ig_private_reply");
    expect(reply).toBeDefined();
    expect(after.entry_node_id).toBe(reply!.node_key);
    expect(reply!.config.next_node_key).toBe("hello");
    // Switching away and back reuses it instead of adding another.
    const again = applyTriggerType(applyTriggerType(after, "keyword"), "ig_comment");
    expect(again.nodes.filter((n) => n.node_type === "ig_private_reply")).toHaveLength(1);
  });

  it("switching to another trigger leaves the steps alone", () => {
    const before = state({ nodes: [{ node_key: "a", node_type: "send_message", config: {} }], entry_node_id: "a" });
    const after = applyTriggerType(before, "ig_story_reply");
    expect(after.nodes).toBe(before.nodes);
    expect(after.entry_node_id).toBe("a");
    expect(after.trigger_config).toEqual(defaultTriggerConfig("ig_story_reply"));
  });
});

describe("keyword, post and story lists", () => {
  it("adds keywords trimmed, de-duplicated case-insensitively, capped at 50 of 100 characters", () => {
    expect(addKeywords(["Price"], " price, info ,, LINK")).toEqual(["Price", "info", "LINK"]);
    expect(addKeywords([], "x".repeat(150))[0]).toHaveLength(100);
    const many = addKeywords([], Array.from({ length: 70 }, (_, i) => `k${i}`).join(","));
    expect(many).toHaveLength(50);
    expect(addKeywords(many, "one-more")).toHaveLength(50);
  });

  it("adds only numeric ids, without duplicates, up to the cap", () => {
    expect(addIds(["1"], "1 2, abc 3", 50)).toEqual(["1", "2", "3"]);
    expect(addIds([], "1 2 3", 2)).toEqual(["1", "2"]);
  });

  it("picks and un-picks posts, at most 50", () => {
    const one = toggleMedia({ post_scope: "specific" }, "178");
    expect(one.media_ids).toEqual(["178"]);
    expect(toggleMedia(one, "178").media_ids).toEqual([]);
    expect(toggleMedia(one, "not-a-number")).toBe(one);
    const full = { media_ids: Array.from({ length: 50 }, (_, i) => String(i + 1)) };
    expect(toggleMedia(full, "999")).toBe(full);
  });

  it("changes post scope, keeping only what the scope uses", () => {
    const now = new Date("2026-11-10T10:00:00.000Z");
    const next = setPostScope({ post_scope: "specific", media_ids: ["1"], include_keywords: ["a"] }, "next", now);
    expect(next).toEqual({ post_scope: "next", next_after: "2026-11-10T10:00:00.000Z", include_keywords: ["a"] });
    expect(setPostScope({ ...next, resolved_media_id: "9" }, "any")).toEqual({ post_scope: "any", include_keywords: ["a"] });
    expect(setPostScope({ post_scope: "any" }, "specific")).toEqual({ post_scope: "specific", media_ids: [] });
  });

  it("keeps at most 3 public replies within the comment length", () => {
    expect(setPublicReplies(["a", "b", "c", "d"])).toEqual(["a", "b", "c"]);
    expect([...setPublicReplies(["x".repeat(2500)])[0]].length).toBe(2200);
  });
});
