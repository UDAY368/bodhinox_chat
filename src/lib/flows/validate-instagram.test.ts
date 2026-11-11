// Stage 2C publish checks for the Instagram triggers and steps
// (instagram-validation.ts through validateFlowForActivation).
import { describe, expect, it } from "vitest";
import { validateFlowForActivation } from "./validate";
import type { FlowChannelScope, FlowTriggerType } from "./types";

type N = { node_key: string; node_type: string; config: Record<string, unknown> };
const start = (next: string): N => ({ node_key: "start", node_type: "start", config: { next_node_key: next } });
const end: N = { node_key: "done", node_type: "end", config: {} };
const commentFlow = {
  name: "Comments", trigger_type: "ig_comment" as FlowTriggerType, trigger_config: { post_scope: "any" } as Record<string, unknown>,
  entry_node_id: "start", channel_scope: "instagram" as FlowChannelScope,
};
const privateReply = (over: Record<string, unknown> = {}): N =>
  ({ node_key: "pr", node_type: "ig_private_reply", config: { text: "Here is the link", opt_in_label: "Send it", next_node_key: "link", ...over } });
const link: N = { node_key: "link", node_type: "send_message", config: { text: "https://shop.example/x", next_node_key: "done" } };
const errors = (nodes: N[], f: Partial<typeof commentFlow> = {}) =>
  validateFlowForActivation({ ...commentFlow, ...f }, nodes).filter((i) => i.severity === "error");

describe("comment flows: the private reply comes first", () => {
  it("accepts tags and a public reply before the private reply, and DMs after its opening button", () => {
    const nodes: N[] = [
      start("reply"),
      { node_key: "reply", node_type: "ig_comment_reply", config: { replies: ["Check your DMs!", "Sent!"], next_node_key: "pr" } },
      privateReply(), link, end,
    ];
    expect(errors(nodes)).toEqual([]);
  });

  it("refuses a flow whose first message is not a private reply", () => {
    const issues = errors([start("link"), link, end]);
    expect(issues).toContainEqual(expect.objectContaining({ node_key: "link", field: "node_type" }));
  });

  it("refuses a question, a typing delay or a second private reply", () => {
    const ask: N = { node_key: "ask", node_type: "collect_input", config: { prompt_text: "Email?", var_key: "email", next_node_key: "pr" } };
    expect(errors([start("ask"), ask, privateReply(), link, end])).toContainEqual(expect.objectContaining({ node_key: "ask" }));
    expect(errors([start("pr"), privateReply({ delay_seconds: 3 }), link, end]))
      .toContainEqual(expect.objectContaining({ node_key: "pr", field: "delay_seconds" }));
    const second: N = { node_key: "pr2", node_type: "ig_private_reply", config: { text: "Again", next_node_key: "done" } };
    expect(errors([start("pr"), privateReply({ next_node_key: "pr2" }), second, end]))
      .toContainEqual(expect.objectContaining({ node_key: "pr2", field: "node_type" }));
  });

  it("refuses a DM after a private reply without an opening button", () => {
    const issues = errors([start("pr"), privateReply({ opt_in_label: "" }), link, end]);
    expect(issues).toContainEqual(expect.objectContaining({ node_key: "pr", field: "opt_in_label" }));
    // Tags and the end are fine without one.
    const tag: N = { node_key: "tag", node_type: "set_tag", config: { mode: "add", tag_id: "11111111-1111-4111-8111-111111111111", next_node_key: "done" } };
    expect(errors([start("pr"), privateReply({ opt_in_label: "", next_node_key: "tag" }), tag, end])).toEqual([]);
  });

  it("checks the private reply's sizes and its next step", () => {
    const issues = errors([start("pr"), privateReply({ text: "x".repeat(1001), opt_in_label: "This label is far too long", next_node_key: "" }), end]);
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ node_key: "pr", field: "text" }),
      expect.objectContaining({ node_key: "pr", field: "opt_in_label" }),
      expect.objectContaining({ node_key: "pr", field: "next_node_key" }),
    ]));
  });

  it("keeps the comment steps out of every other flow", () => {
    const nodes: N[] = [start("pr"), privateReply({ opt_in_label: "", next_node_key: "done" }), end];
    expect(errors(nodes, { trigger_type: "keyword", trigger_config: { keywords: ["hi"] } }))
      .toContainEqual(expect.objectContaining({ node_key: "pr", field: "node_type" }));
    const reply: N = { node_key: "r", node_type: "ig_comment_reply", config: { replies: ["Hi"], next_node_key: "done" } };
    expect(errors([start("r"), reply, end], { trigger_type: "keyword", trigger_config: { keywords: ["hi"] } }))
      .toContainEqual(expect.objectContaining({ node_key: "r", field: "node_type" }));
  });
});

describe("Instagram triggers", () => {
  const nodes: N[] = [start("pr"), privateReply({ opt_in_label: "", next_node_key: "done" }), end];
  it("ig_comment: post scope, posts, next-post time, keywords and public replies", () => {
    const fields = (config: Record<string, unknown>) => errors(nodes, { trigger_config: config }).map((i) => i.field);
    expect(fields({ post_scope: "some" })).toContain("trigger_config.post_scope");
    expect(fields({ post_scope: "specific" })).toContain("trigger_config.media_ids");
    expect(fields({ post_scope: "specific", media_ids: ["abc"] })).toContain("trigger_config.media_ids");
    expect(fields({ post_scope: "next" })).toContain("trigger_config.next_after");
    expect(fields({ post_scope: "any", include_keywords: Array.from({ length: 51 }, (_, i) => `k${i}`) })).toContain("trigger_config.include_keywords");
    expect(fields({ post_scope: "any", exclude_keywords: ["x".repeat(101)] })).toContain("trigger_config.exclude_keywords");
    expect(fields({ post_scope: "any", public_replies: ["a", "b", "c", "d"] })).toContain("trigger_config.public_replies");
    expect(fields({ post_scope: "any", public_replies: [""] })).toContain("trigger_config.public_replies");
    expect(fields({ post_scope: "next", next_after: "2026-11-10T00:00:00Z", include_keywords: ["price"], public_replies: ["DM sent!"] })).toEqual([]);
  });

  const dm: N[] = [start("hi"), { node_key: "hi", node_type: "send_message", config: { text: "Hi", next_node_key: "done" } }, end];
  it("ig_story_reply, ig_story_mention and default_reply", () => {
    const fields = (trigger_type: FlowTriggerType, config: Record<string, unknown>) =>
      errors(dm, { trigger_type, trigger_config: config }).map((i) => i.field);
    expect(fields("ig_story_reply", {})).toEqual([]);
    expect(fields("ig_story_reply", { story_ids: ["x"] })).toContain("trigger_config.story_ids");
    expect(fields("ig_story_mention", {})).toContain("trigger_config.frequency");
    expect(fields("ig_story_mention", { frequency: "once_per_24h" })).toEqual([]);
    expect(fields("default_reply", { frequency: "hourly" })).toContain("trigger_config.frequency");
    expect(fields("default_reply", {})).toEqual([]);
    // A story trigger cannot be published on WhatsApp.
    expect(errors(dm, { trigger_type: "ig_story_reply", trigger_config: {}, channel_scope: "whatsapp" }))
      .toContainEqual(expect.objectContaining({ field: "trigger_type" }));
  });

  it("ig_share_to_story (Stage 4): a frequency and a valid account, Instagram only", () => {
    const fields = (config: Record<string, unknown>, channel_scope: FlowChannelScope = "instagram") =>
      errors(dm, { trigger_type: "ig_share_to_story", trigger_config: config, channel_scope }).map((i) => i.field);
    expect(fields({ frequency: "every_time" })).toEqual([]);
    expect(fields({ frequency: "once_per_24h", instagram_account_id: "3f1c2a4e-9b7d-4c1a-8e2f-0a1b2c3d4e5f" })).toEqual([]);
    expect(fields({})).toContain("trigger_config.frequency");
    expect(fields({ frequency: "hourly" })).toContain("trigger_config.frequency");
    expect(fields({ frequency: "every_time", instagram_account_id: "not-a-uuid" })).toContain("trigger_config.instagram_account_id");
    // Neither WhatsApp nor a legacy both-channels flow can carry it.
    expect(fields({ frequency: "every_time" }, "whatsapp")).toContain("trigger_type");
    expect(fields({ frequency: "every_time" }, "any")).toContain("trigger_type");
  });
});

describe("cards, galleries, link buttons and profile conditions", () => {
  const flow = { trigger_type: "keyword" as FlowTriggerType, trigger_config: { keywords: ["hi"] } };
  it("accepts a gallery whose postback buttons route, and refuses a routed card that also links Next", () => {
    const gallery: N = { node_key: "g", node_type: "send_gallery", config: { cards: [
      { title: "Shoes", subtitle: "New", image_url: "https://cdn.example/a.png",
        buttons: [{ type: "web_url", title: "Shop", url: "https://shop.example" }, { type: "postback", title: "More", reply_id: "more", next_node_key: "done" }] },
    ] } };
    expect(errors([start("g"), gallery, end], flow)).toEqual([]);
    const routedWithNext = { ...gallery, config: { ...gallery.config, next_node_key: "done" } };
    expect(errors([start("g"), routedWithNext, end], flow)).toContainEqual(expect.objectContaining({ node_key: "g", field: "next_node_key" }));
  });

  it("refuses cards over Meta's limits", () => {
    const tooMany: N = { node_key: "g", node_type: "send_gallery", config: { cards: Array.from({ length: 11 }, () => ({ title: "x" })), next_node_key: "done" } };
    expect(errors([start("g"), tooMany, end], flow)).toContainEqual(expect.objectContaining({ field: "cards" }));
    const bad: N = { node_key: "c", node_type: "send_card", config: { card: { title: "x".repeat(81), image_url: "http://insecure.example/a.png",
      buttons: [{ type: "web_url", title: "Go", url: "https://a" }, { type: "web_url", title: "Go", url: "https://a" },
        { type: "web_url", title: "Go", url: "https://a" }, { type: "web_url", title: "Go", url: "https://a" }] }, next_node_key: "done" } };
    expect(errors([start("c"), bad, end], flow).map((i) => i.field)).toEqual(expect.arrayContaining(["card.title", "card.image_url", "card.buttons"]));
  });

  it("allows link buttons on Instagram only, within 3 buttons in total", () => {
    const buttons: N = { node_key: "b", node_type: "send_buttons", config: { text: "Pick",
      buttons: [{ reply_id: "y", title: "Yes", next_node_key: "done" }], link_buttons: [{ title: "Site", url: "https://shop.example" }] } };
    expect(errors([start("b"), buttons, end], { ...flow, channel_scope: "whatsapp" })).toContainEqual(expect.objectContaining({ field: "link_buttons" }));
    expect(errors([start("b"), buttons, end], { ...flow, channel_scope: "any" })).toContainEqual(expect.objectContaining({ field: "link_buttons" }));
    expect(errors([start("b"), buttons, end], { ...flow, channel_scope: "instagram" })).toEqual([]);
    const crowded = { ...buttons, config: { ...buttons.config, link_buttons: [1, 2, 3].map(() => ({ title: "Site", url: "https://shop.example" })) } };
    expect(errors([start("b"), crowded, end], { ...flow, channel_scope: "instagram" })).toContainEqual(expect.objectContaining({ field: "link_buttons" }));
  });

  it("allows the follow gate condition in Instagram flows only", () => {
    const gate: N = { node_key: "c", node_type: "condition", config: {
      rules: [{ subject: "ig_profile", subject_key: "follows_business", operator: "equals", value: "true" }], true_next: "done", false_next: "done" } };
    expect(errors([start("c"), gate, end], { ...flow, channel_scope: "instagram" })).toEqual([]);
    expect(errors([start("c"), gate, end], { ...flow, channel_scope: "whatsapp" })).toContainEqual(expect.objectContaining({ field: "rules.0.subject" }));
    const unknownFact = { ...gate, config: { ...gate.config, rules: [{ subject: "ig_profile", subject_key: "age", operator: "present" }] } };
    expect(errors([start("c"), unknownFact, end], { ...flow, channel_scope: "instagram" }))
      .toContainEqual(expect.objectContaining({ field: "rules.0.subject_key" }));
  });
});

describe("Live comment flows (ig_live_comment, Stage 3)", () => {
  const live = { name: "Live", trigger_type: "ig_live_comment" as FlowTriggerType, trigger_config: { keywords: ["link"] } as Record<string, unknown>,
    entry_node_id: "start", channel_scope: "instagram" as FlowChannelScope };

  it("takes the same private-reply shape as a post comment flow", () => {
    expect(errors([start("pr"), privateReply(), link, end], live)).toEqual([]);
    expect(errors([start("link"), link, end], live)).toContainEqual(expect.objectContaining({ node_key: "link", field: "node_type" }));
    expect(errors([start("pr"), privateReply({ opt_in_label: "" }), link, end], live))
      .toContainEqual(expect.objectContaining({ node_key: "pr", field: "opt_in_label" }));
  });

  it("refuses the public comment reply step: a Live comment gets none", () => {
    const reply: N = { node_key: "reply", node_type: "ig_comment_reply", config: { replies: ["Check your DMs!"], next_node_key: "pr" } };
    expect(errors([start("reply"), reply, privateReply(), link, end], live))
      .toContainEqual(expect.objectContaining({ node_key: "reply", field: "node_type" }));
  });

  it("checks the keywords, the match mode and the account, and refuses WhatsApp", () => {
    const tooMany = { keywords: Array.from({ length: 51 }, (_, i) => `w${i}`) };
    expect(errors([start("pr"), privateReply(), link, end], { ...live, trigger_config: tooMany }))
      .toContainEqual(expect.objectContaining({ field: "trigger_config.keywords" }));
    expect(errors([start("pr"), privateReply(), link, end], { ...live, trigger_config: { match_mode: "regex" } }))
      .toContainEqual(expect.objectContaining({ field: "trigger_config.match_mode" }));
    expect(errors([start("pr"), privateReply(), link, end], { ...live, trigger_config: { instagram_account_id: "nope" } }))
      .toContainEqual(expect.objectContaining({ field: "trigger_config.instagram_account_id" }));
    expect(errors([start("pr"), privateReply(), link, end], { ...live, trigger_config: {} })).toEqual([]);
    expect(errors([start("pr"), privateReply(), link, end], { ...live, channel_scope: "whatsapp" }).length).toBeGreaterThan(0);
  });
});

describe("ref link flows (ig_ref, Stage 3)", () => {
  const ref = { name: "Ref", trigger_type: "ig_ref" as FlowTriggerType, trigger_config: { refs: ["summer-sale"] } as Record<string, unknown>,
    entry_node_id: "start", channel_scope: "instagram" as FlowChannelScope };
  const hello: N = { node_key: "hello", node_type: "send_message", config: { text: "Welcome!", next_node_key: "done" } };

  it("accepts a flow with valid keys and ordinary steps", () => {
    expect(errors([start("hello"), hello, end], ref)).toEqual([]);
  });

  it("needs at least one key, at most 20, each URL-safe and unique without case", () => {
    const refsError = (refs: unknown) => errors([start("hello"), hello, end], { ...ref, trigger_config: { refs } })
      .filter((i) => i.field === "trigger_config.refs");
    expect(refsError([])).toHaveLength(1);
    expect(refsError(undefined)).toHaveLength(1);
    expect(refsError(Array.from({ length: 21 }, (_, i) => `k${i}`))).toHaveLength(1);
    expect(refsError(["has space"])).toHaveLength(1);
    expect(refsError(["x".repeat(65)])).toHaveLength(1);
    expect(refsError(["Sale", "sale"])).toHaveLength(1);
    expect(refsError(["a", "b_2", "C-3"])).toHaveLength(0);
  });

  it("refuses the comment steps and a bad account, and WhatsApp", () => {
    expect(errors([start("pr"), privateReply({ opt_in_label: "", next_node_key: "done" }), end], ref))
      .toContainEqual(expect.objectContaining({ node_key: "pr", field: "node_type" }));
    expect(errors([start("hello"), hello, end], { ...ref, trigger_config: { refs: ["a"], instagram_account_id: "x" } }))
      .toContainEqual(expect.objectContaining({ field: "trigger_config.instagram_account_id" }));
    expect(errors([start("hello"), hello, end], { ...ref, channel_scope: "whatsapp" }).length).toBeGreaterThan(0);
  });
});

describe("ad_click on Instagram (Stage 3)", () => {
  it("publishes on Instagram, still checks the ad ids, and stays valid on WhatsApp", () => {
    const hello: N = { node_key: "hello", node_type: "send_message", config: { text: "Thanks for clicking", next_node_key: "done" } };
    const ad = { name: "Ad", trigger_type: "ad_click" as FlowTriggerType, trigger_config: { ad_ids: ["123"] } as Record<string, unknown>,
      entry_node_id: "start", channel_scope: "instagram" as FlowChannelScope };
    expect(errors([start("hello"), hello, end], ad)).toEqual([]);
    expect(errors([start("hello"), hello, end], { ...ad, trigger_config: { ad_ids: ["not-digits"] } }).length).toBeGreaterThan(0);
    expect(errors([start("hello"), hello, end], { ...ad, channel_scope: "whatsapp" })).toEqual([]);
  });
});
