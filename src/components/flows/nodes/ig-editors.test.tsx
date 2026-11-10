// Stage 2 (2D): the Instagram step and trigger editors stop offering "add"
// at Instagram's limits and say why a step cannot run where it is. Rendered
// to static markup with a key-echoing translator, so the assertions read the
// message keys.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// "key(name=value)": survives HTML escaping in the markup.
const fmt = vi.hoisted(() => (values?: Record<string, unknown>) =>
  values ? `(${Object.entries(values).map(([k, v]) => `${k}=${String(v)}`).join(",")})` : "");
vi.mock("next-intl", async (original) => ({
  ...(await original<typeof import("next-intl")>()),
  useTranslations: (ns?: string) => (key: string, values?: Record<string, unknown>) => `${ns ? `${ns}.` : ""}${key}${fmt(values)}`,
}));
vi.mock("@/lib/auth/client", () => ({ authFetch: vi.fn(async () => new Response("{}", { status: 503 })) }));

import { IgCardForm } from "./ig-card-form";
import { IgCommentReplyForm } from "./ig-comment-reply-form";
import { IgLinkButtons } from "./ig-link-buttons";
import { IgPrivateReplyForm } from "./ig-private-reply-form";
import { IgCommentTriggerFields } from "../triggers/ig-trigger-fields";
import type { BuilderNode } from "../shared";

const t = ((key: string, values?: Record<string, unknown>) => `form.${key}${fmt(values)}`) as never;
const noop = () => {};
const node = (node_type: BuilderNode["node_type"], config: Record<string, unknown>): BuilderNode => ({ node_key: "n1", node_type, config });
const button = (i: number) => ({ type: "postback", title: `B${i}`, reply_id: `btn_${i}`, next_node_key: "" });
const card = (buttons = 0) => ({ title: "Card", buttons: Array.from({ length: buttons }, (_, i) => button(i + 1)) });
const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("card and gallery editors", () => {
  it("offers another button until a card has 3", () => {
    const two = renderToStaticMarkup(<IgCardForm node={node("send_card", { card: card(2) })} allNodes={[]} onUpdateConfig={noop} t={t} />);
    expect(two).toContain("Flows.nodes.card.addButton");
    const three = renderToStaticMarkup(<IgCardForm node={node("send_card", { card: card(3) })} allNodes={[]} onUpdateConfig={noop} t={t} />);
    expect(three).not.toContain("Flows.nodes.card.addButton");
    expect(three).toContain('Flows.nodes.card.maxButtons(max=3)');
  });

  it("offers another card until a gallery has 10, and never removes the last one", () => {
    const nine = renderToStaticMarkup(<IgCardForm node={node("send_gallery", { cards: Array.from({ length: 9 }, () => card()) })}
      allNodes={[]} onUpdateConfig={noop} t={t} />);
    expect(nine).toContain("Flows.nodes.gallery.addCard");
    const ten = renderToStaticMarkup(<IgCardForm node={node("send_gallery", { cards: Array.from({ length: 10 }, () => card()) })}
      allNodes={[]} onUpdateConfig={noop} t={t} />);
    expect(ten).not.toContain("Flows.nodes.gallery.addCard");
    expect(ten).toContain('Flows.nodes.gallery.maxCards(max=10)');
    const one = renderToStaticMarkup(<IgCardForm node={node("send_gallery", { cards: [card()] })} allNodes={[]} onUpdateConfig={noop} t={t} />);
    expect(one).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Flows.nodes.gallery.removeCard"/);
  });

  it("asks for a title and an https link", () => {
    const html = renderToStaticMarkup(<IgCardForm node={node("send_card", { card: { title: "", image_url: "http://x.test/a.png" } })}
      allNodes={[]} onUpdateConfig={noop} t={t} />);
    expect(html).toContain("Flows.nodes.card.titleRequired");
    expect(html).toContain("Flows.nodes.card.urlInvalid");
  });
});

describe("link buttons on an Instagram buttons step", () => {
  it("share the 3-button limit with the reply buttons", () => {
    const room = renderToStaticMarkup(<IgLinkButtons value={[]} replyButtons={2} onChange={noop} removeLabel="x" />);
    expect(room).toContain("Flows.nodes.buttons.addLinkButton");
    const full = renderToStaticMarkup(<IgLinkButtons value={[{ title: "Site", url: "https://a.test" }]} replyButtons={2} onChange={noop} removeLabel="x" />);
    expect(full).not.toContain("Flows.nodes.buttons.addLinkButton");
    expect(full).toContain('Flows.nodes.buttons.maxButtons(max=3)');
  });
});

describe("comment reply step", () => {
  it("offers up to 3 variants and keeps at least one", () => {
    const one = renderToStaticMarkup(<IgCommentReplyForm node={node("ig_comment_reply", { replies: ["Thanks"] })} allNodes={[]} onUpdateConfig={noop} t={t} />);
    expect(one).toContain("Flows.nodes.igCommentReply.addReply");
    expect(one).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Flows.nodes.igCommentReply.removeReply/);
    const three = renderToStaticMarkup(<IgCommentReplyForm node={node("ig_comment_reply", { replies: ["a", "b", "c"] })}
      allNodes={[]} onUpdateConfig={noop} t={t} />);
    expect(three).not.toContain("Flows.nodes.igCommentReply.addReply");
    expect(count(three, "<textarea")).toBe(3);
  });

  it("shows why it cannot run outside a comment flow", () => {
    const html = renderToStaticMarkup(<IgCommentReplyForm node={node("ig_comment_reply", { replies: ["a"] })} allNodes={[]}
      onUpdateConfig={noop} notice="only-comment-flows" t={t} />);
    expect(html).toContain("only-comment-flows");
  });
});

describe("private reply step", () => {
  it("counts the bytes left and offers a timeout only while it waits for the opening button", () => {
    const waits = renderToStaticMarkup(<IgPrivateReplyForm node={node("ig_private_reply", { text: "é", opt_in_label: "Send" })}
      allNodes={[]} onUpdateConfig={noop} t={t} />);
    expect(waits).toContain('Flows.nodes.igPrivateReply.bytesLeft(count=998)');
    expect(waits).toContain("form.timeoutLabel");
    const plain = renderToStaticMarkup(<IgPrivateReplyForm node={node("ig_private_reply", { text: "hi", opt_in_label: "" })}
      allNodes={[]} onUpdateConfig={noop} t={t} />);
    expect(plain).not.toContain("form.timeoutLabel");
    // No typing delay: the form has no delay field.
    expect(plain).not.toContain("delayLabel");
  });
});

describe("comment trigger editor", () => {
  it("stops taking keywords at 50 and asks for an account before picking posts", () => {
    const keywords = Array.from({ length: 50 }, (_, i) => `k${i}`);
    const html = renderToStaticMarkup(<IgCommentTriggerFields config={{ post_scope: "specific", include_keywords: keywords }} onChange={noop} />);
    expect(html).toContain('Flows.triggers.igComment.tooManyKeywords(max=50)');
    expect(html).toContain("Flows.triggers.igComment.chooseAccountFirst");
    expect(html).toContain("Flows.triggers.needsMessageAccess");
  });

  it("offers public replies until there are 3", () => {
    const html = renderToStaticMarkup(<IgCommentTriggerFields config={{ post_scope: "any", public_replies: ["a", "b", "c"] }} onChange={noop} />);
    expect(html).not.toContain("Flows.triggers.igComment.addPublicReply");
    expect(renderToStaticMarkup(<IgCommentTriggerFields config={{ post_scope: "any" }} onChange={noop} />))
      .toContain("Flows.triggers.igComment.addPublicReply");
  });

  it("explains the next-post choice", () => {
    expect(renderToStaticMarkup(<IgCommentTriggerFields config={{ post_scope: "next" }} onChange={noop} />))
      .toContain("Flows.triggers.igComment.postNextHelp");
  });
});
