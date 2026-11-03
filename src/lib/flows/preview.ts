/**
 * WhatsApp-style preview simulator for the flow builder.
 *
 * Walks the builder's nodes the way the engine would and returns the
 * conversation a customer would see: bot bubbles, the customer's own
 * replies, and small system notes for steps that have no visible output
 * (tags, attributes, API calls, delays…). It stops at every node that
 * waits for the customer and exposes the choices they could make.
 *
 * Pure and framework-free on purpose: it never sends, saves or fetches
 * anything, and it does not interpolate — `{{vars.x}}` stays literal so
 * the author sees exactly what they wrote. The component translates the
 * note codes; this file carries no user-facing English.
 */

import type { BuilderNode } from "@/components/flows/shared";
import { extraPorts } from "./edges";
import { parseDateInput, parseNumberInput } from "./input-formats";

/** Automatic steps allowed between two customer choices before we call it a loop. */
export const PREVIEW_STEP_LIMIT = 50;

export type PreviewNote =
  | "delay"
  | "condition"
  | "set_tag"
  | "set_attribute"
  | "assign_agent"
  | "api_request"
  | "connect_flow"
  | "handoff"
  | "end"
  | "dead_end"
  | "missing_node"
  | "loop"
  | "invalid_answer"
  | "exhausted"
  | "timeout"
  | "fallback"
  | "ai_reply"
  | "conversion_event";

export interface PreviewMessage {
  id: number;
  from: "bot" | "customer" | "system";
  nodeKey?: string;
  /** Bot / customer text, shown literally. */
  text?: string;
  /** Customer: a simulated non-text reply (shared media or location, or a submitted form). */
  shared?: "media" | "location" | "form";
  header?: string;
  footer?: string;
  /** send_media: the media kind and optional document filename. */
  media?: { type: string; filename?: string };
  /** Quick-reply buttons under the bubble (send_buttons, templates, skip). */
  buttons?: string[];
  /** send_list: the tap-to-open button label and its rows. */
  list?: { button: string; rows: Array<{ id: string; title: string; description?: string }> };
  /** send_template: the template being sent. */
  template?: string;
  /** System notes: what happened, plus a short detail (seconds, tag key…). */
  note?: PreviewNote;
  detail?: string;
}

export interface PreviewOption {
  id: string;
  label: string;
}

export interface PreviewWaiting {
  kind: "buttons" | "list" | "text" | "branch";
  /** What the customer can tap (or, for "branch", which result the author picks). */
  options: PreviewOption[];
  /**
   * Author-only shortcuts for what the customer cannot type here:
   * "share" (send the media / location asked for), "submit" (fill in and
   * submit a sent form), "exhausted" (attempts used up) and "timeout" (no
   * reply). Offered only where the engine acts on them.
   */
  simulate: PreviewOption[];
}

export interface PreviewState {
  messages: PreviewMessage[];
  waiting: null | PreviewWaiting;
  ended: boolean;
  /** Internal: the nodes being previewed and the node we are waiting on. */
  nodes: BuilderNode[];
  at: string | null;
  /** Internal: invalid replies so far on the question being waited on. */
  attempts: number;
}

type Cfg = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const rows = (v: unknown): Cfg[] => (Array.isArray(v) ? (v as Cfg[]) : []);

// Mirrors input-validation.ts, which needs node:worker_threads and so cannot load here.
const YES = new Set(["yes", "y", "true", "1", "si", "sí", "sim", "예", "네", "ha", "haan", "हाँ", "हां"]);
const NO = new Set(["no", "n", "false", "0", "não", "nao", "아니요", "아니오", "nahi", "nahin", "नहीं"]);

/**
 * Whether the engine would store this typed reply on a question node
 * (engine.ts captureAnswer + normalizeCollectedInput). ask_media and
 * ask_location never take text. A `regex` format is not run here (the
 * engine runs tenant patterns in an isolated, time-limited thread), so
 * any non-empty reply passes; "attempts used up" still walks that port.
 */
export function previewAcceptsText(node: BuilderNode, text: string): boolean {
  const cfg = node.config as Cfg;
  if (!str(cfg.var_key)) return false;
  const value = text.trim();
  if (node.node_type === "ask_address") return value.length > 0;
  if (node.node_type !== "collect_input" || !value || value.length > 4096) return false;
  switch (str(cfg.validation) || "any") {
    case "any":
    case "regex":
      return true;
    case "email":
      return /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(value) && value.length <= 254;
    case "phone":
      return /^\+?[1-9][0-9]{7,14}$/.test(value);
    case "number": {
      const n = parseNumberInput(value);
      if (n === null) return false;
      if (typeof cfg.min === "number" && n < cfg.min) return false;
      return !(typeof cfg.max === "number" && n > cfg.max);
    }
    case "date":
      return parseDateInput(value) !== null;
    case "boolean": {
      const word = value.toLowerCase().replace(/[.!]+$/, "");
      return YES.has(word) || NO.has(word);
    }
    default:
      return false;
  }
}

/** The Skip button the engine sends: only with both a label and a wired port (engine.ts sendAskPrompt). */
function skipLabel(node: BuilderNode): string {
  const cfg = node.config as Cfg;
  return (node.node_type === "collect_input" || node.node_type === "ask_media") && str(cfg.skip_label) && str(cfg.skip_next)
    ? str(cfg.skip_label)
    : "";
}

/** The engine retries a question only with a numeric max_attempts of 1 or more. */
function maxAttempts(node: BuilderNode): number {
  const m = (node.config as Cfg).max_attempts;
  return typeof m === "number" && m >= 1 ? m : 0;
}

/**
 * Author-only choices for the ports the canvas draws (edges.ts
 * extraPorts): attempts used up, and a reply timeout once its port is
 * wired (engine.ts nodeTimeout ignores an unwired one).
 */
function simulatedPorts(node: BuilderNode): PreviewOption[] {
  const out: PreviewOption[] = [];
  for (const port of extraPorts(node)) {
    if (port.handle === "exhausted") out.push({ id: "exhausted", label: port.label });
    if (port.handle === "timeout" && str(node.config.after_timeout)) out.push({ id: "timeout", label: port.label });
  }
  return out;
}

/** Start the preview at the flow's entry node. */
export function startPreview(nodes: BuilderNode[], entry: string | null): PreviewState {
  const state: PreviewState = { messages: [], waiting: null, ended: false, nodes, at: null, attempts: 0 };
  if (!entry || !nodes.some((n) => n.node_key === entry)) {
    return { ...state, ended: true };
  }
  return walk(state, entry);
}

/**
 * Apply the customer's choice. `optionId` is one of `waiting.options`
 * or `waiting.simulate` ids, or `"text"` with `text` for a typed answer
 * to a question. A typed answer the engine would reject is handled the
 * way the engine does: reprompt, attempts used up, or the flow's
 * fallback. Anything that doesn't match the current wait returns the
 * state unchanged.
 */
export function choose(state: PreviewState, optionId: string, text?: string): PreviewState {
  if (!state.waiting || !state.at || state.ended) return state;
  const node = state.nodes.find((n) => n.node_key === state.at);
  if (!node) return state;
  const cfg = node.config as Cfg;
  const { waiting } = state;
  const nodeKey = node.node_key;

  const messages = [...state.messages];
  const push = (m: Omit<PreviewMessage, "id">) => messages.push({ id: messages.length, ...m });
  const go = (next: string) => walk({ ...state, messages, waiting: null, at: null }, next);
  const fallback = (): PreviewState => {
    push({ from: "system", nodeKey, note: "fallback" });
    return { ...state, messages, waiting: null, ended: true, at: null };
  };
  // engine.ts retryQuestion: exhausted_next, else the flow's on_exhaust policy.
  const exhaust = (): PreviewState => {
    push({ from: "system", nodeKey, note: "exhausted" });
    return str(cfg.exhausted_next) ? go(str(cfg.exhausted_next)) : fallback();
  };
  // engine.ts dispatchInbound: retry while attempts remain, else give up.
  const reject = (): PreviewState => {
    const max = maxAttempts(node);
    if (!max) return fallback();
    const attempts = state.attempts + 1;
    if (attempts >= max) return exhaust();
    push({ from: "system", nodeKey, note: "invalid_answer", detail: `${attempts}/${max}` });
    const skip = skipLabel(node);
    push({ from: "bot", nodeKey, text: str(cfg.error_text).trim() ? str(cfg.error_text) : str(cfg.prompt_text), buttons: skip ? [skip] : undefined });
    return { ...state, messages, attempts };
  };

  if (optionId === "text" && waiting.kind === "text") {
    const said = (text ?? "").trim();
    if (!said) return state;
    push({ from: "customer", text: said });
    return previewAcceptsText(node, said) ? go(str(cfg.next_node_key)) : reject();
  }

  if (waiting.simulate.some((o) => o.id === optionId)) {
    if (optionId === "exhausted") return exhaust();
    if (optionId === "timeout") {
      push({ from: "system", nodeKey, note: "timeout", detail: String(cfg.timeout_minutes ?? "") });
      return go(str(cfg.after_timeout));
    }
    // "submit": the customer fills in the form; the engine stores the answers under var_key and moves on.
    if (optionId === "submit") {
      push({ from: "customer", shared: "form" });
      return str(cfg.var_key) ? go(str(cfg.next_node_key)) : fallback();
    }
    // "share": the media or location the question asks for; stored only with a var_key, as in the engine.
    push({ from: "customer", shared: node.node_type === "ask_location" ? "location" : "media" });
    return str(cfg.var_key) ? go(str(cfg.next_node_key)) : reject();
  }

  const option = waiting.options.find((o) => o.id === optionId);
  if (!option) return state;
  if (waiting.kind !== "branch") push({ from: "customer", text: option.label });
  return go(nextFor(node, optionId));
}

/** The node_key a choice on `node` leads to ("" when the slot is unwired). */
function nextFor(node: BuilderNode, optionId: string): string {
  const cfg = node.config as Cfg;
  if (optionId === "skip") return str(cfg.skip_next);
  switch (node.node_type) {
    case "condition":
      return str(optionId === "true" ? cfg.true_next : cfg.false_next);
    case "api_request": {
      if (optionId === "fallback") return str(cfg.fallback_next);
      const i = Number(optionId.slice("route:".length));
      return str(rows(cfg.routes)[i]?.next_node_key);
    }
    case "send_buttons":
    case "send_template":
      return str(rows(cfg.buttons).find((b) => b.reply_id === optionId)?.next_node_key);
    case "payment_link":
      return str(cfg[`${optionId}_next`]);
    case "ai_reply":
      return str(optionId === "handoff" ? cfg.handoff_next : cfg.next_node_key);
    case "send_list":
      for (const section of rows(cfg.sections)) {
        const row = rows(section.rows).find((r) => r.reply_id === optionId);
        if (row) return str(row.next_node_key);
      }
      return "";
    default:
      return str(cfg.next_node_key);
  }
}

function walk(start: PreviewState, firstKey: string): PreviewState {
  const messages = [...start.messages];
  const push = (m: Omit<PreviewMessage, "id">) => messages.push({ id: messages.length, ...m });
  const stop = (note: PreviewNote, detail?: string): PreviewState => {
    push({ from: "system", note, detail });
    return { ...start, messages, waiting: null, ended: true, at: null };
  };
  const wait = (key: string, waiting: Omit<PreviewWaiting, "simulate">, simulate: PreviewOption[] = []): PreviewState =>
    ({ ...start, messages, waiting: { ...waiting, simulate }, ended: false, at: key, attempts: 0 });
  const byKey = new Map(start.nodes.map((n) => [n.node_key, n]));

  let key = firstKey;
  for (let steps = 0; ; steps += 1) {
    if (steps >= PREVIEW_STEP_LIMIT) return stop("loop");
    if (!key) return stop("dead_end");
    const node = byKey.get(key);
    if (!node) return stop("missing_node", key);
    const cfg = node.config as Cfg;
    const nodeKey = node.node_key;

    const delay = Number(cfg.delay_seconds);
    if (Number.isFinite(delay) && delay > 0) push({ from: "system", nodeKey, note: "delay", detail: String(delay) });

    const header = str(cfg.header_text) || undefined;
    const footer = str(cfg.footer_text) || undefined;
    const skip = skipLabel(node);
    const ports = simulatedPorts(node);

    switch (node.node_type) {
      case "start":
        key = str(cfg.next_node_key);
        continue;

      case "send_message":
        push({ from: "bot", nodeKey, text: str(cfg.text) });
        key = str(cfg.next_node_key);
        continue;

      case "send_media":
        push({ from: "bot", nodeKey, text: str(cfg.caption), media: { type: str(cfg.media_type) || "image", filename: str(cfg.filename) || undefined } });
        key = str(cfg.next_node_key);
        continue;

      case "send_product":
        // The customer sees Meta's product card; the content id stands in for it here.
        push({ from: "bot", nodeKey, text: str(cfg.body_text), footer, media: { type: "image", filename: str(cfg.product_retailer_id) || undefined } });
        key = str(cfg.next_node_key);
        continue;

      case "send_product_list":
        push({ from: "bot", nodeKey, text: str(cfg.body_text), header, footer, list: { button: "", rows: rows(cfg.sections)
          .flatMap((s) => (Array.isArray(s.product_retailer_ids) ? s.product_retailer_ids : []).map((id) => ({ id: str(id), title: str(id), description: str(s.title) || undefined })))
          .filter((r) => r.id) } });
        key = str(cfg.next_node_key);
        continue;

      case "send_catalog":
        push({ from: "bot", nodeKey, text: str(cfg.body_text), footer });
        key = str(cfg.next_node_key);
        continue;

      case "send_buttons": {
        const options = rows(cfg.buttons).filter((b) => str(b.reply_id)).map((b) => ({ id: str(b.reply_id), label: str(b.title) || str(b.reply_id) }));
        push({ from: "bot", nodeKey, text: str(cfg.text), header, footer, buttons: options.map((o) => o.label) });
        return wait(nodeKey, { kind: "buttons", options }, ports);
      }

      case "send_list": {
        const listRows = rows(cfg.sections).flatMap((s) => rows(s.rows)).filter((r) => str(r.reply_id))
          .map((r) => ({ id: str(r.reply_id), title: str(r.title) || str(r.reply_id), description: str(r.description) || undefined }));
        push({ from: "bot", nodeKey, text: str(cfg.text), header, footer, list: { button: str(cfg.button_label), rows: listRows } });
        return wait(nodeKey, { kind: "list", options: listRows.map((r) => ({ id: r.id, label: r.title })) }, ports);
      }

      case "send_template": {
        const options = rows(cfg.buttons).filter((b) => str(b.reply_id)).map((b) => ({ id: str(b.reply_id), label: str(b.title) || str(b.reply_id) }));
        push({ from: "bot", nodeKey, template: str(cfg.template_name), buttons: options.length ? options.map((o) => o.label) : undefined });
        if (options.length) return wait(nodeKey, { kind: "buttons", options }, ports);
        key = str(cfg.next_node_key);
        continue;
      }

      case "collect_input":
      case "ask_media":
      case "ask_location":
      case "ask_address":
        push({ from: "bot", nodeKey, text: str(cfg.prompt_text), buttons: skip ? [skip] : undefined });
        return wait(
          nodeKey,
          { kind: "text", options: skip ? [{ id: "skip", label: skip }] : [] },
          node.node_type === "ask_media" || node.node_type === "ask_location" ? [{ id: "share", label: "share" }, ...ports] : ports,
        );

      case "payment_link":
        // The engine creates the link at Razorpay; a placeholder URL stands in for it. The author picks the outcome.
        push({ from: "bot", nodeKey, text: [str(cfg.message).trim(), "https://rzp.io/…"].filter(Boolean).join("\n") });
        return wait(nodeKey, { kind: "branch", options: [{ id: "paid", label: "paid" }, { id: "expired", label: "expired" }, { id: "failed", label: "failed" }] }, ports);

      case "ai_reply":
        // Nothing is generated here: a note stands in for the AI's answer, and the
        // author picks whether it answered or handed off. With more than one turn,
        // "answered" stands for the last answer the step sends.
        push({ from: "system", nodeKey, note: "ai_reply", detail: str(cfg.var_key) || undefined });
        return wait(nodeKey, { kind: "branch", options: [{ id: "answered", label: "answered" }, { id: "handoff", label: "handoff" }] }, ports);

      case "send_form":
        // The form opens from its button; typed replies are off-script, as in the engine.
        push({ from: "bot", nodeKey, text: str(cfg.body), header: str(cfg.header) || undefined, footer: str(cfg.footer) || undefined, buttons: [str(cfg.cta) || "…"] });
        return wait(nodeKey, { kind: "text", options: [] }, [{ id: "submit", label: "submit" }, ...ports]);

      case "condition":
        push({ from: "system", nodeKey, note: "condition", detail: str(cfg.subject_key) || undefined });
        return wait(nodeKey, { kind: "branch", options: [{ id: "true", label: "true" }, { id: "false", label: "false" }] });

      case "api_request": {
        push({ from: "system", nodeKey, note: "api_request", detail: str(cfg.method) || undefined });
        const routes = rows(cfg.routes).map((r, i) => ({ id: `route:${i}`, label: str(r.status) }));
        return wait(nodeKey, { kind: "branch", options: [...routes, { id: "fallback", label: "fallback" }] });
      }

      case "set_tag":
      case "set_attribute":
      case "assign_agent":
        push({ from: "system", nodeKey, note: node.node_type, detail: str(cfg.key) || undefined });
        key = str(cfg.next_node_key);
        continue;

      case "conversion_event":
        // Simulated: nothing is queued or sent to Meta from the preview.
        push({ from: "system", nodeKey, note: "conversion_event", detail: str(cfg.event_name) || undefined });
        key = str(cfg.next_node_key);
        continue;

      case "connect_flow":
      case "handoff":
      case "end":
        return stop(node.node_type);
    }
  }
}
