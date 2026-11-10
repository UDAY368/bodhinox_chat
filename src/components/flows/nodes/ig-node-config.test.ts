import { describe, expect, it } from "vitest";
import {
  addCard,
  addCardButton,
  addLinkButton,
  addVariant,
  bytesLeft,
  canAddButton,
  canRouteInto,
  clipBytes,
  clipCard,
  commentStepIssue,
  emptyCard,
  entryLocked,
  firstPrivateReplies,
  placeableNodeTypes,
  postbackIds,
  readCard,
  removeCard,
  removeVariant,
  replyVariants,
  routableTargets,
  setButtonType,
  setVariant,
  storeCard,
  withPrivateReplyEntry,
} from "./ig-node-config";
import { nodeTypesForScope } from "../flow-editor-state";
import type { BuilderNode } from "../shared";

const node = (node_key: string, node_type: BuilderNode["node_type"], config: Record<string, unknown> = {}): BuilderNode =>
  ({ node_key, node_type, config });

describe("where the comment steps can be placed", () => {
  const instagram = nodeTypesForScope("instagram");

  it("offers the private reply and the comment reply only in a comment flow", () => {
    for (const trigger of ["keyword", "ig_story_reply", "ig_story_mention", "default_reply", "manual"] as const) {
      const menu = placeableNodeTypes(instagram, trigger, []);
      expect(menu).not.toContain("ig_private_reply");
      expect(menu).not.toContain("ig_comment_reply");
      // Cards stay available in every Instagram flow.
      expect(menu).toEqual(expect.arrayContaining(["send_card", "send_gallery"]));
    }
    expect(placeableNodeTypes(instagram, "ig_comment", [])).toEqual(expect.arrayContaining(["ig_private_reply", "ig_comment_reply"]));
  });

  it("(Stage 3) offers a Live comment flow its private reply but no public comment reply; a ref link flow neither", () => {
    const live = placeableNodeTypes(instagram, "ig_live_comment", []);
    expect(live).toContain("ig_private_reply");
    expect(live).not.toContain("ig_comment_reply");
    const ref = placeableNodeTypes(instagram, "ig_ref", []);
    expect(ref).not.toContain("ig_private_reply");
    expect(ref).not.toContain("ig_comment_reply");
    const pr = node("pr", "ig_private_reply");
    expect(commentStepIssue(pr, "ig_live_comment", "pr", [pr])).toBeNull();
    expect(commentStepIssue(node("cr", "ig_comment_reply"), "ig_live_comment", "pr", [pr])).toBe("onlyCommentFlows");
    expect(entryLocked("ig_live_comment", [pr], "pr")).toBe(true);
    expect(entryLocked("ig_ref", [pr], "pr")).toBe(false);
  });

  it("offers each comment step at most once", () => {
    const menu = placeableNodeTypes(instagram, "ig_comment", [node("pr", "ig_private_reply"), node("cr", "ig_comment_reply")]);
    expect(menu).not.toContain("ig_private_reply");
    expect(menu).not.toContain("ig_comment_reply");
  });

  it("never adds an Instagram step to a WhatsApp menu", () => {
    const menu = placeableNodeTypes(nodeTypesForScope("whatsapp"), "ig_comment", []);
    for (const type of ["ig_private_reply", "ig_comment_reply", "send_card", "send_gallery"] as const) expect(menu).not.toContain(type);
  });

  it("names why a placed comment step cannot run", () => {
    const pr = node("pr", "ig_private_reply");
    const other = node("other", "send_message", { text: "hi", next_node_key: "pr" });
    const nodes = [pr, other];
    expect(commentStepIssue(pr, "keyword", "pr", nodes)).toBe("onlyCommentFlows");
    expect(commentStepIssue(node("cr", "ig_comment_reply"), "manual", null, nodes)).toBe("onlyCommentFlows");
    // A direct message before it spends the one private reply.
    expect(commentStepIssue(pr, "ig_comment", "other", nodes)).toBe("firstOnly");
    expect(commentStepIssue(pr, "ig_comment", "pr", nodes)).toBeNull();
    expect(commentStepIssue(node("cr", "ig_comment_reply"), "ig_comment", "pr", nodes)).toBeNull();
    expect(commentStepIssue(node("m", "send_message"), "keyword", "m", nodes)).toBeNull();
  });

  it("counts a private reply as first behind a start, tags or the public reply (as templates build it)", () => {
    const nodes = [
      node("start", "start", { next_node_key: "tag" }),
      node("tag", "set_tag", { mode: "add", tag_id: "t", next_node_key: "cr" }),
      node("cr", "ig_comment_reply", { replies: ["Thanks"], next_node_key: "pr" }),
      node("pr", "ig_private_reply", { text: "Here", next_node_key: "" }),
    ];
    expect(firstPrivateReplies(nodes, "start")).toEqual(new Set(["pr"]));
    expect(commentStepIssue(nodes[3], "ig_comment", "start", nodes)).toBeNull();
    // Not reached at all (nothing leads to it) is not first either.
    expect(commentStepIssue(nodes[3], "ig_comment", "cr", [...nodes.slice(0, 2), { ...nodes[2], config: { replies: ["x"], next_node_key: "" } }, nodes[3]]))
      .toBe("firstOnly");
    expect(firstPrivateReplies(nodes, null).size).toBe(0);
  });

  it("locks the entry of a comment flow that starts with its private reply", () => {
    const nodes = [node("pr", "ig_private_reply"), node("m", "send_message")];
    expect(entryLocked("ig_comment", nodes, "pr")).toBe(true);
    expect(entryLocked("ig_comment", nodes, "m")).toBe(false);
    expect(entryLocked("keyword", nodes, "pr")).toBe(false);
  });

  it("routes into the private reply only from a step allowed before it", () => {
    const nodes = [node("start", "start"), node("pr", "ig_private_reply"), node("m", "send_message"), node("end", "end")];
    expect(routableTargets(nodes, null, "m").map((n) => n.node_key)).toEqual(["start", "m", "end"]);
    expect(routableTargets(nodes, null).map((n) => n.node_key)).toEqual(["start", "m", "end"]);
    expect(routableTargets(nodes, null, "start").map((n) => n.node_key)).toEqual(["start", "pr", "m", "end"]);
    // A stored route into it (from before) stays visible so it can be changed.
    expect(routableTargets(nodes, "pr", "m").map((n) => n.node_key)).toEqual(["start", "pr", "m", "end"]);
    expect(canRouteInto("send_message", nodes[1])).toBe(false);
    expect(canRouteInto("condition", nodes[1])).toBe(true);
    expect(canRouteInto(undefined, nodes[1])).toBe(false);
    expect(canRouteInto("send_message", nodes[2])).toBe(true);
  });

  it("makes the private reply first, continuing to the old entry once", () => {
    const placed = withPrivateReplyEntry([node("m", "send_message"), node("pr", "ig_private_reply", { next_node_key: "" })], "m", "pr");
    expect(placed.entry).toBe("pr");
    expect(placed.nodes[1].config.next_node_key).toBe("m");
    // A private reply already wired keeps its route.
    const wired = withPrivateReplyEntry([node("m", "send_message"), node("pr", "ig_private_reply", { next_node_key: "x" })], "m", "pr");
    expect(wired.nodes[1].config.next_node_key).toBe("x");
    // No old entry: nothing to continue to.
    expect(withPrivateReplyEntry([node("pr", "ig_private_reply")], null, "pr").nodes[0].config.next_node_key).toBeUndefined();
  });
});

describe("message limits", () => {
  it("counts and clips UTF-8 bytes without splitting a character", () => {
    expect(bytesLeft("a".repeat(1000))).toBe(0);
    expect(bytesLeft("é")).toBe(998);
    const clipped = clipBytes("😀".repeat(300));
    expect(new TextEncoder().encode(clipped).length).toBeLessThanOrEqual(1000);
    expect(clipped).toBe("😀".repeat(250));
  });

  it("keeps 1–3 comment reply variants within the comment length", () => {
    expect(addVariant(["a", "b", "c"])).toEqual(["a", "b", "c"]);
    expect(addVariant(["a"])).toEqual(["a", ""]);
    expect(removeVariant(["a"], 0, true)).toEqual(["a"]);
    expect(removeVariant(["a", "b"], 0, true)).toEqual(["b"]);
    expect(replyVariants(["a", 2, "b", "c", "d"])).toEqual(["a", "b", "c"]);
    expect([...setVariant([""], 0, "x".repeat(3000))[0]].length).toBe(2200);
  });
});

describe("cards and buttons", () => {
  it("holds at most 10 cards and keeps at least one", () => {
    let cards = [emptyCard()];
    for (let i = 0; i < 15; i++) cards = addCard(cards);
    expect(cards).toHaveLength(10);
    expect(removeCard([emptyCard()], 0)).toHaveLength(1);
    expect(removeCard(cards, 0)).toHaveLength(9);
  });

  it("holds at most 3 buttons per card, with postback ids unique across the step", () => {
    let card = emptyCard();
    for (let i = 0; i < 5; i++) card = addCardButton(card, "postback", postbackIds([card]));
    expect(card.buttons).toHaveLength(3);
    const ids = postbackIds([card]);
    expect(new Set(ids).size).toBe(3);
    // A second card in the same step never reuses those ids.
    const second = addCardButton(emptyCard(), "postback", ids);
    expect(ids).not.toContain(postbackIds([second])[0]);
  });

  it("switches a button between a link and a step route", () => {
    const link = setButtonType({ type: "postback", title: "Go", reply_id: "btn_1", next_node_key: "x" }, "web_url", []);
    expect(link).toEqual({ type: "web_url", title: "Go", url: "" });
    const back = setButtonType(link, "postback", ["btn_1"]);
    expect(back).toMatchObject({ type: "postback", title: "Go", reply_id: "btn_2", next_node_key: "" });
  });

  it("clips card text to Instagram's limits and drops empty optional fields", () => {
    const card = clipCard({ title: "t".repeat(90), subtitle: "s".repeat(90), buttons: [{ type: "web_url", title: "b".repeat(30), url: "https://x.test" }] });
    expect(card.title).toHaveLength(80);
    expect(card.subtitle).toHaveLength(80);
    expect(card.buttons?.[0].title).toHaveLength(20);
    expect(storeCard({ title: "Hi", subtitle: "", image_url: "", default_url: "", buttons: [] })).toEqual({ title: "Hi", buttons: [] });
  });

  it("reads a stored card defensively", () => {
    expect(readCard(null)).toEqual({ title: "", subtitle: undefined, image_url: undefined, default_url: undefined, buttons: [] });
    expect(readCard({ title: "A", buttons: [{ type: "postback", title: "x" }, { type: "web_url", title: "L", url: "https://a.test" }] }).buttons)
      .toEqual([{ type: "web_url", title: "L", url: "https://a.test" }]);
  });

  it("shares the 3-button limit between reply and link buttons", () => {
    expect(canAddButton(2, 0)).toBe(true);
    expect(canAddButton(2, 1)).toBe(false);
    expect(addLinkButton([], 3)).toEqual([]);
    expect(addLinkButton([], 1)).toEqual([{ title: "", url: "" }]);
  });
});
