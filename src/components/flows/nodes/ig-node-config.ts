/**
 * Pure rules behind the Instagram step editors (Stage 2, 2D): where the
 * comment steps may be placed, and the size limits each editor enforces
 * while the author types. No React and no I/O, so the editors, the add-step
 * menus and their tests share one copy. The publish validator
 * (src/lib/flows/validate.ts) checks the same rules again on the server.
 */

import { IG_TRIGGER_LIMITS, startsFromComment, type FlowTriggerType, type IgCard, type IgCardButton } from "@/lib/flows/types";
import { deriveCanvasEdges } from "@/lib/flows/edges";
import { charLength, INSTAGRAM_LIMITS, utf8Bytes } from "@/lib/instagram/graph-limits";
import type { BuilderNode, NodeType } from "../shared";

/** The steps that exist only in a flow started by a comment. */
export const COMMENT_ONLY_STEPS: ReadonlySet<NodeType> = new Set<NodeType>(["ig_private_reply", "ig_comment_reply"]);

/**
 * Whether a comment step may sit in a flow with this trigger: the private
 * reply in any comment flow (a post or a Live comment, PRIVATE_REPLY_TRIGGERS),
 * the public comment reply only under a post comment.
 */
export function commentStepAllowed(type: NodeType, trigger: FlowTriggerType): boolean {
  if (type === "ig_comment_reply") return trigger === "ig_comment";
  return type === "ig_private_reply" ? startsFromComment(trigger) : true;
}

/**
 * The add-step menu for a flow, given the channel palette (`types`), its
 * trigger and its steps. The private reply and the public comment reply are
 * offered only in a comment flow (commentStepAllowed), and each at most once
 * (Instagram allows one private reply per comment, and the public reply is
 * sent once per comment), so an invalid combination cannot be placed from
 * the menus.
 */
export function placeableNodeTypes(types: readonly NodeType[], trigger: FlowTriggerType, nodes: readonly BuilderNode[]): NodeType[] {
  return types.filter((type) => !COMMENT_ONLY_STEPS.has(type) ||
    (commentStepAllowed(type, trigger) && !nodes.some((node) => node.node_type === type)));
}

/** Why a placed comment step cannot run where it is, or null when it can. */
export type CommentStepIssue = "onlyCommentFlows" | "firstOnly";

/**
 * Steps a comment flow may run before its private reply: they send nothing
 * into the DM thread (a start, logic, tags, fields, an agent, an API call,
 * the public comment reply). The same set as the publish validator's
 * (src/lib/flows/instagram-validation.ts), so a template's "start, then
 * private reply" counts as first.
 */
export const BEFORE_PRIVATE_REPLY: ReadonlySet<NodeType> = new Set<NodeType>([
  "start", "condition", "set_tag", "set_attribute", "api_request", "assign_agent", "ig_comment_reply",
]);

/** The private replies a run reaches from `entry` through only the steps allowed before one. */
export function firstPrivateReplies(nodes: readonly BuilderNode[], entry: string | null): Set<string> {
  const byKey = new Map(nodes.map((n) => [n.node_key, n]));
  const successors = new Map<string, string[]>();
  for (const edge of deriveCanvasEdges([...nodes])) successors.set(edge.source, [...(successors.get(edge.source) ?? []), edge.target]);
  const first = new Set<string>();
  const seen = new Set<string>();
  const pending = entry ? [entry] : [];
  while (pending.length) {
    const key = pending.pop()!;
    if (seen.has(key)) continue;
    seen.add(key);
    const node = byKey.get(key);
    if (!node) continue;
    if (node.node_type === "ig_private_reply") first.add(key);
    else if (BEFORE_PRIVATE_REPLY.has(node.node_type)) pending.push(...(successors.get(key) ?? []));
  }
  return first;
}

export function commentStepIssue(node: BuilderNode, trigger: FlowTriggerType, entry: string | null,
  nodes: readonly BuilderNode[]): CommentStepIssue | null {
  if (!COMMENT_ONLY_STEPS.has(node.node_type)) return null;
  if (!commentStepAllowed(node.node_type, trigger)) return "onlyCommentFlows";
  if (node.node_type === "ig_private_reply" && !firstPrivateReplies(nodes, entry).has(node.node_key)) return "firstOnly";
  return null;
}

/**
 * Whether a step of type `source` may route into `target`. Only the steps
 * allowed before a private reply may lead into one: after anything that
 * messages the person, Instagram's one private reply per comment is spent.
 */
export const canRouteInto = (source: NodeType | undefined, target: BuilderNode): boolean =>
  target.node_type !== "ig_private_reply" || (source !== undefined && BEFORE_PRIVATE_REPLY.has(source));

/** A comment flow whose entry is its private reply keeps that entry: no other step can be made first. */
export function entryLocked(trigger: FlowTriggerType, nodes: readonly BuilderNode[], entry: string | null): boolean {
  return startsFromComment(trigger) && nodes.some((n) => n.node_key === entry && n.node_type === "ig_private_reply");
}

/**
 * The steps the "next step" picker of `sourceKey` may route to (canRouteInto):
 * a private reply only from a step allowed before it. One already picked
 * (`current`) stays listed so the picker still shows it and it can be changed.
 */
export function routableTargets(nodes: readonly BuilderNode[], current: string | null, sourceKey?: string): BuilderNode[] {
  const source = nodes.find((n) => n.node_key === sourceKey)?.node_type;
  return nodes.filter((n) => n.node_key === current || canRouteInto(source, n));
}

/**
 * Makes the private reply `key` the flow's first step: it becomes the entry
 * and, unless it already continues somewhere, continues to the old entry.
 */
export function withPrivateReplyEntry(nodes: BuilderNode[], entry: string | null, key: string): { nodes: BuilderNode[]; entry: string } {
  const previous = entry && entry !== key && nodes.some((n) => n.node_key === entry) ? entry : "";
  return {
    entry: key,
    nodes: nodes.map((n) => {
      if (n.node_key !== key || n.node_type !== "ig_private_reply") return n;
      const next = typeof n.config.next_node_key === "string" ? n.config.next_node_key : "";
      return next || !previous ? n : { ...n, config: { ...n.config, next_node_key: previous } };
    }),
  };
}

// ------------------------------------------------------------ text limits

/** UTF-8 bytes left in a message (Instagram counts bytes, 1000 per message). */
export const bytesLeft = (text: string): number => INSTAGRAM_LIMITS.textBytes - utf8Bytes(text);

/** Cuts text to `max` user-perceived characters (an emoji counts once, as Meta counts). */
export const clipChars = (text: string, max: number): string => (charLength(text) <= max ? text : [...text].slice(0, max).join(""));

/** Cuts text to at most `max` UTF-8 bytes without splitting a character. */
export function clipBytes(text: string, max: number = INSTAGRAM_LIMITS.textBytes): string {
  if (utf8Bytes(text) <= max) return text;
  let out = "";
  for (const ch of text) {
    if (utf8Bytes(out + ch) > max) break;
    out += ch;
  }
  return out;
}

// ------------------------------------------------------------ comment reply variants

export const MAX_REPLY_VARIANTS = IG_TRIGGER_LIMITS.publicReplies;

/** The reply variants as stored: strings only, at most 3, each within the comment cap. */
export function replyVariants(value: unknown): string[] {
  return (Array.isArray(value) ? value : []).filter((r): r is string => typeof r === "string")
    .slice(0, MAX_REPLY_VARIANTS).map((r) => clipChars(r, INSTAGRAM_LIMITS.commentReplyChars));
}

/** One more empty variant, unless the list is full. */
export const addVariant = (variants: string[]): string[] =>
  variants.length >= MAX_REPLY_VARIANTS ? variants : [...variants, ""];

export const setVariant = (variants: string[], index: number, text: string): string[] =>
  variants.map((v, i) => (i === index ? clipChars(text, INSTAGRAM_LIMITS.commentReplyChars) : v));

/** Removes a variant; a comment-reply step keeps at least one (`keepOne`). */
export const removeVariant = (variants: string[], index: number, keepOne = false): string[] =>
  keepOne && variants.length <= 1 ? variants : variants.filter((_, i) => i !== index);

// ------------------------------------------------------------ cards and buttons

export const MAX_CARDS = INSTAGRAM_LIMITS.genericCards;
export const MAX_BUTTONS = INSTAGRAM_LIMITS.buttons;

/** A card as the editor reads it (missing fields become empty). */
export function readCard(value: unknown): IgCard {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const text = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    title: text(raw.title) ?? "",
    subtitle: text(raw.subtitle),
    image_url: text(raw.image_url),
    default_url: text(raw.default_url),
    buttons: (Array.isArray(raw.buttons) ? raw.buttons : []).filter(isCardButton),
  };
}

function isCardButton(value: unknown): value is IgCardButton {
  const b = value as Record<string, unknown> | null;
  return !!b && typeof b === "object" && typeof b.title === "string" &&
    ((b.type === "web_url" && typeof b.url === "string") ||
      (b.type === "postback" && typeof b.reply_id === "string" && typeof b.next_node_key === "string"));
}

export const emptyCard = (): IgCard => ({ title: "", subtitle: "", buttons: [] });

/** One more card at the end, unless the gallery is full. */
export const addCard = (cards: IgCard[]): IgCard[] => (cards.length >= MAX_CARDS ? cards : [...cards, emptyCard()]);

/** Removes a card; a gallery keeps at least one. */
export const removeCard = (cards: IgCard[], index: number): IgCard[] =>
  cards.length <= 1 ? cards : cards.filter((_, i) => i !== index);

/** Every postback reply id used by the step's cards (they route the step, so they are unique per step). */
export const postbackIds = (cards: readonly IgCard[]): string[] =>
  cards.flatMap((c) => (c.buttons ?? []).flatMap((b) => (b.type === "postback" ? [b.reply_id] : [])));

/** A reply id not yet used in this step. */
export function freshReplyId(used: readonly string[]): string {
  let i = used.length + 1;
  while (used.includes(`btn_${i}`)) i += 1;
  return `btn_${i}`;
}

/**
 * Adds a button to a card, unless it already has 3. A postback button gets a
 * reply id unique in the step (`used`); a link button starts empty.
 */
export function addCardButton(card: IgCard, type: IgCardButton["type"], used: readonly string[], title = ""): IgCard {
  const buttons = card.buttons ?? [];
  if (buttons.length >= MAX_BUTTONS) return card;
  const button: IgCardButton = type === "web_url"
    ? { type: "web_url", title, url: "" }
    : { type: "postback", title, reply_id: freshReplyId(used), next_node_key: "" };
  return { ...card, buttons: [...buttons, button] };
}

/** Switches a button between a link and a step route, keeping its title. */
export function setButtonType(button: IgCardButton, type: IgCardButton["type"], used: readonly string[]): IgCardButton {
  if (button.type === type) return button;
  return type === "web_url"
    ? { type: "web_url", title: button.title, url: "" }
    : { type: "postback", title: button.title, reply_id: freshReplyId(used), next_node_key: "" };
}

/** Clips a card's text fields to Instagram's limits as the author types. */
export function clipCard(card: IgCard): IgCard {
  return {
    ...card,
    title: clipChars(card.title, INSTAGRAM_LIMITS.cardTitleChars),
    ...(card.subtitle !== undefined ? { subtitle: clipChars(card.subtitle, INSTAGRAM_LIMITS.cardSubtitleChars) } : {}),
    buttons: (card.buttons ?? []).slice(0, MAX_BUTTONS).map((b) => ({ ...b, title: clipChars(b.title, INSTAGRAM_LIMITS.buttonTitleChars) })),
  };
}

/**
 * Stores a card: empty optional fields are dropped (an empty subtitle or
 * link would fail Instagram's checks; absent is valid).
 */
export function storeCard(card: IgCard): IgCard {
  const clipped = clipCard(card);
  const out: IgCard = { title: clipped.title, buttons: clipped.buttons ?? [] };
  if (clipped.subtitle) out.subtitle = clipped.subtitle;
  if (clipped.image_url) out.image_url = clipped.image_url;
  if (clipped.default_url) out.default_url = clipped.default_url;
  return out;
}

// ------------------------------------------------------------ send_buttons link buttons (Instagram)

export interface LinkButton { title: string; url: string }

export function readLinkButtons(value: unknown): LinkButton[] {
  return (Array.isArray(value) ? value : []).filter((b): b is LinkButton =>
    !!b && typeof b === "object" && typeof (b as LinkButton).title === "string" && typeof (b as LinkButton).url === "string");
}

/** Reply buttons plus link buttons stay within Instagram's 3 per message. */
export const canAddButton = (replyButtons: number, linkButtons: number): boolean => replyButtons + linkButtons < MAX_BUTTONS;

export const addLinkButton = (links: LinkButton[], replyButtons: number): LinkButton[] =>
  canAddButton(replyButtons, links.length) ? [...links, { title: "", url: "" }] : links;
