// Stage 2 (2D): the builder preview plays the Instagram-only steps.
import { describe, expect, it } from "vitest";

import type { BuilderNode } from "@/components/flows/shared";
import { choose, startPreview } from "./preview";

const n = (node_key: string, node_type: BuilderNode["node_type"], config: Record<string, unknown>): BuilderNode => ({ node_key, node_type, config });

describe("Instagram steps in the preview", () => {
  it("plays a comment flow: the private reply waits for its opening button, the public reply is marked, then the card", () => {
    const nodes = [
      n("pr", "ig_private_reply", { text: "Here you go", opt_in_label: "Send link", next_node_key: "cr" }),
      n("cr", "ig_comment_reply", { replies: ["", "Check your DMs"], next_node_key: "card" }),
      n("card", "send_card", { card: { title: "Guide", subtitle: "Free", image_url: "https://a.test/i.png",
        buttons: [{ type: "web_url", title: "Open", url: "https://a.test" }] }, next_node_key: "bye" }),
      n("bye", "end", {}),
    ];
    const first = startPreview(nodes, "pr");
    expect(first.waiting).toEqual({ kind: "buttons", options: [{ id: "opt_in", label: "Send link" }], simulate: [] });
    expect(first.messages[0]).toMatchObject({ from: "bot", text: "Here you go", buttons: ["Send link"] });
    const done = choose(first, "opt_in");
    expect(done.ended).toBe(true);
    expect(done.messages.find((m) => m.nodeKey === "cr")).toMatchObject({ text: "Check your DMs", publicReply: true });
    expect(done.messages.find((m) => m.nodeKey === "card")?.cards).toEqual([
      { title: "Guide", subtitle: "Free", hasImage: true, buttons: [{ label: "Open" }] },
    ]);
  });

  it("runs on at once from a private reply without an opening button", () => {
    const state = startPreview([n("pr", "ig_private_reply", { text: "Hi", opt_in_label: "", next_node_key: "bye" }), n("bye", "end", {})], "pr");
    expect(state.ended).toBe(true);
    expect(state.messages.at(-1)).toMatchObject({ note: "end" });
  });

  it("offers the reply timeout while the private reply waits", () => {
    const state = startPreview([
      n("pr", "ig_private_reply", { text: "Hi", opt_in_label: "Go", timeout_minutes: 60, after_timeout: "late", next_node_key: "" }),
      n("late", "end", {}),
    ], "pr");
    expect(state.waiting?.simulate).toEqual([{ id: "timeout", label: "Timeout" }]);
    expect(choose(state, "timeout").ended).toBe(true);
  });

  it("routes a gallery's postback button when nothing follows the cards", () => {
    const nodes = [
      n("g", "send_gallery", { cards: [
        { title: "A", buttons: [{ type: "postback", title: "Pick A", reply_id: "btn_1", next_node_key: "a" }] },
        { title: "B", buttons: [{ type: "postback", title: "Pick B", reply_id: "btn_2", next_node_key: "b" }] },
      ], next_node_key: "" }),
      n("a", "send_message", { text: "You chose A", next_node_key: "" }),
      n("b", "send_message", { text: "You chose B", next_node_key: "" }),
    ];
    const first = startPreview(nodes, "g");
    expect(first.messages[0].cards?.map((c) => c.buttons)).toEqual([[{ label: "Pick A", replyId: "btn_1" }], [{ label: "Pick B", replyId: "btn_2" }]]);
    expect(first.waiting?.options).toEqual([{ id: "btn_1", label: "Pick A" }, { id: "btn_2", label: "Pick B" }]);
    expect(choose(first, "btn_2").messages.find((m) => m.nodeKey === "b")?.text).toBe("You chose B");
  });

  it("shows Instagram link buttons under a buttons step without making them tappable", () => {
    const state = startPreview([n("ask", "send_buttons", { text: "Pick", buttons: [{ reply_id: "y", title: "Yes", next_node_key: "" }],
      link_buttons: [{ title: "Website", url: "https://a.test" }] })], "ask");
    expect(state.messages[0]).toMatchObject({ buttons: ["Yes"], links: ["Website"] });
    expect(state.waiting?.options).toEqual([{ id: "y", label: "Yes" }]);
  });
});
