/**
 * Derive canvas edges from the flow's node list.
 *
 * Edges live INSIDE each node's `config` JSONB (each button row /
 * list row / condition branch carries its own `next_node_key`). The
 * canvas needs them as a separate `{ source, target, label,
 * sourceHandle }` list to render arrows, and the labels need to be
 * meaningful — a `send_buttons` node with three buttons isn't useful
 * on the canvas if the three outgoing arrows are unlabeled.
 *
 * Why this lives in lib/flows (not next to flow-canvas.tsx): the
 * derivation is pure data manipulation with no React-Flow types in
 * it, which makes it (a) trivially unit-testable and (b) reusable by
 * the editable canvas (PR 2) without dragging in client-only deps.
 *
 * `sourceHandle` ids are stable strings the canvas wires up to its
 * per-node renderer's outgoing connection points. They match the
 * scheme PR 2's drag-to-connect handler will read:
 *   - `next`            for single-outgoing nodes
 *   - `button:<reply_id>` for send_buttons rows
 *   - `row:<reply_id>`    for send_list rows
 *   - `true` / `false`    for condition branches
 *   - `skip` / `exhausted` / `timeout` for the optional question and
 *     wait-for-reply ports (see `extraPorts`)
 */

import type { BuilderNode } from "@/components/flows/shared";
import { aiReplyWaits } from "./ai-reply-node";

const WAITING_TYPES = new Set(["send_buttons", "send_list", "send_template", "collect_input", "ask_media", "ask_location", "ask_address", "send_form", "payment_link", "book_appointment"]);

/**
 * Optional ports a node shows once its setting is on: Skip (a skip
 * button), "Attempts used up" (max_attempts) and Timeout (timeout_minutes).
 */
export function extraPorts(node: BuilderNode): Array<{ handle: string; field: string; label: string }> {
  const cfg = node.config;
  const ports: Array<{ handle: string; field: string; label: string }> = [];
  if ((node.node_type === "collect_input" || node.node_type === "ask_media") && cfg.skip_label) {
    ports.push({ handle: "skip", field: "skip_next", label: "Skip" });
  }
  if (["collect_input", "ask_media", "ask_location", "ask_address"].includes(node.node_type) &&
      cfg.max_attempts !== undefined && cfg.max_attempts !== null) {
    ports.push({ handle: "exhausted", field: "exhausted_next", label: "Attempts used up" });
  }
  // A payment link always offers its expired and failed outcomes (an unwired one ends the run).
  if (node.node_type === "payment_link") {
    ports.push({ handle: "expired", field: "expired_next", label: "Expired" }, { handle: "failed", field: "failed_next", label: "Failed" });
  }
  // A storefront link always offers its failed outcome (an unwired one ends the run).
  if (node.node_type === "send_storefront_link") {
    ports.push({ handle: "failed", field: "failed_next", label: "Failed" });
  }
  // A booking step always offers its unavailable and cancelled outcomes (an unwired one ends the run).
  if (node.node_type === "book_appointment") {
    ports.push({ handle: "unavailable", field: "unavailable_next", label: "Unavailable" }, { handle: "cancelled", field: "cancelled_next", label: "Cancelled" });
  }
  // An AI reply always offers its handoff outcome (low confidence, no answer, AI unavailable).
  if (node.node_type === "ai_reply") {
    ports.push({ handle: "handoff", field: "handoff_next", label: "Handoff" });
  }
  // A template waits only when it has quick-reply buttons.
  const waits = (WAITING_TYPES.has(node.node_type) && (node.node_type !== "send_template" || (Array.isArray(cfg.buttons) && cfg.buttons.length > 0))) ||
    // An AI reply waits for follow-ups only when it answers more than once.
    (node.node_type === "ai_reply" && aiReplyWaits(cfg));
  if (waits && cfg.timeout_minutes !== undefined && cfg.timeout_minutes !== null) {
    ports.push({ handle: "timeout", field: "after_timeout", label: "Timeout" });
  }
  return ports;
}

export interface CanvasEdge {
  /** Stable per-edge id — required by React-Flow. */
  id: string;
  /** node_key of the source node. */
  source: string;
  /** node_key of the target node. */
  target: string;
  /** Identifies which outgoing slot on the source node this edge belongs to. */
  sourceHandle: string;
  /** Human-readable label rendered on the canvas (e.g. "Yes button"). */
  label?: string;
}

/**
 * The edge shape a node has: a template with quick replies routes like
 * send_buttons (same buttons array), one without like a single-next node.
 */
function edgeKind(node: BuilderNode): Exclude<BuilderNode["node_type"], "send_template"> {
  if (node.node_type !== "send_template") return node.node_type;
  return Array.isArray(node.config.buttons) && node.config.buttons.length > 0 ? "send_buttons" : "send_message";
}

export function deriveCanvasEdges(nodes: BuilderNode[]): CanvasEdge[] {
  const knownKeys = new Set(nodes.map((n) => n.node_key));
  const edges: CanvasEdge[] = [];

  for (const node of nodes) {
    const cfg = node.config;
    for (const port of extraPorts(node)) {
      const next = cfg[port.field];
      if (typeof next !== "string" || !knownKeys.has(next)) continue;
      edges.push({
        id: `${node.node_key}--${port.handle}--${next}`,
        source: node.node_key,
        target: next,
        sourceHandle: port.handle,
        label: port.label,
      });
    }
    switch (edgeKind(node)) {
      case "start":
      case "send_message":
      case "send_media":
      case "collect_input":
      case "ask_media":
      case "ask_location":
      case "ask_address":
      case "send_form":
      case "send_product":
      case "send_product_list":
      case "send_catalog":
      case "set_tag":
      case "assign_agent":
    case "conversion_event":
    case "send_storefront_link":
    case "set_attribute": {
        const next = (cfg as { next_node_key?: string }).next_node_key;
        if (next && knownKeys.has(next)) {
          edges.push({
            id: `${node.node_key}--next--${next}`,
            source: node.node_key,
            target: next,
            sourceHandle: "next",
          });
        }
        break;
      }

      case "book_appointment": {
        const booked = (cfg as { success_next?: string }).success_next;
        if (booked && knownKeys.has(booked)) {
          edges.push({ id: `${node.node_key}--success--${booked}`, source: node.node_key, target: booked, sourceHandle: "success", label: "Booked" });
        }
        break;
      }

      case "ai_reply": {
        const answered = (cfg as { next_node_key?: string }).next_node_key;
        if (answered && knownKeys.has(answered)) {
          edges.push({ id: `${node.node_key}--answered--${answered}`, source: node.node_key, target: answered, sourceHandle: "answered", label: "Answered" });
        }
        break;
      }

      case "payment_link": {
        const paid = (cfg as { paid_next?: string }).paid_next;
        if (paid && knownKeys.has(paid)) {
          edges.push({ id: `${node.node_key}--paid--${paid}`, source: node.node_key, target: paid, sourceHandle: "paid", label: "Paid" });
        }
        break;
      }

      case "condition": {
        const trueNext = (cfg as { true_next?: string }).true_next;
        const falseNext = (cfg as { false_next?: string }).false_next;
        if (trueNext && knownKeys.has(trueNext)) {
          edges.push({
            id: `${node.node_key}--true--${trueNext}`,
            source: node.node_key,
            target: trueNext,
            sourceHandle: "true",
            label: "true",
          });
        }
        if (falseNext && knownKeys.has(falseNext)) {
          edges.push({
            id: `${node.node_key}--false--${falseNext}`,
            source: node.node_key,
            target: falseNext,
            sourceHandle: "false",
            label: "false",
          });
        }
        break;
      }

      case "api_request": {
        ((Array.isArray(cfg.routes) ? cfg.routes : []) as Array<Record<string, unknown>>).forEach((route, i) => {
          const next = route.next_node_key;
          if (typeof next === "string" && knownKeys.has(next)) {
            edges.push({ id: `${node.node_key}--route:${i}--${next}`, source: node.node_key, target: next, sourceHandle: `route:${i}`, label: String(route.status ?? "") });
          }
        });
        const fallback = cfg.fallback_next;
        if (typeof fallback === "string" && knownKeys.has(fallback)) {
          edges.push({ id: `${node.node_key}--fallback--${fallback}`, source: node.node_key, target: fallback, sourceHandle: "fallback", label: "Fallback" });
        }
        break;
      }

      case "send_buttons": {
        const buttons = Array.isArray(
          (cfg as { buttons?: unknown }).buttons,
        )
          ? ((cfg as { buttons: Array<Record<string, unknown>> }).buttons)
          : [];
        for (const btn of buttons) {
          const replyId =
            typeof btn.reply_id === "string" ? btn.reply_id : null;
          const next =
            typeof btn.next_node_key === "string" ? btn.next_node_key : null;
          const title = typeof btn.title === "string" ? btn.title : null;
          if (!replyId || !next || !knownKeys.has(next)) continue;
          edges.push({
            id: `${node.node_key}--button:${replyId}--${next}`,
            source: node.node_key,
            target: next,
            sourceHandle: `button:${replyId}`,
            label: title ?? replyId,
          });
        }
        break;
      }

      case "send_list": {
        const sections = Array.isArray(
          (cfg as { sections?: unknown }).sections,
        )
          ? ((cfg as { sections: Array<Record<string, unknown>> }).sections)
          : [];
        for (const section of sections) {
          const rows = Array.isArray(section.rows)
            ? (section.rows as Array<Record<string, unknown>>)
            : [];
          for (const row of rows) {
            const replyId =
              typeof row.reply_id === "string" ? row.reply_id : null;
            const next =
              typeof row.next_node_key === "string" ? row.next_node_key : null;
            const title = typeof row.title === "string" ? row.title : null;
            if (!replyId || !next || !knownKeys.has(next)) continue;
            edges.push({
              id: `${node.node_key}--row:${replyId}--${next}`,
              source: node.node_key,
              target: next,
              sourceHandle: `row:${replyId}`,
              label: title ?? replyId,
            });
          }
        }
        break;
      }

      case "connect_flow":
    case "handoff":
      case "end":
        // Terminal nodes — no outgoing edges.
        break;
    }
  }

  return edges;
}

// ============================================================
// Inverse operations — used by the canvas's drag-to-connect and
// delete-with-cleanup handlers (PR 2b). Kept in lib/flows so the
// canvas component stays free of edge-bookkeeping logic.
// ============================================================

/**
 * Outgoing-slot list for a node — used by the canvas to render one
 * source-side Handle per slot, labelled with the slot's user-facing
 * name. Order follows the order the slots appear in the node's
 * config so visual layout matches the form layout.
 *
 * Terminal nodes (handoff / end) return an empty list — they have
 * no outgoing edges and no source handles.
 */
export interface OutgoingSlot {
  /** Stable id matching the `sourceHandle` scheme used in
   *  CanvasEdge. */
  id: string;
  /** Visible label rendered next to the handle. */
  label: string;
}

export function outgoingSlots(node: BuilderNode): OutgoingSlot[] {
  return [...baseSlots(node), ...extraPorts(node).map((port) => ({ id: port.handle, label: port.label }))];
}

function baseSlots(node: BuilderNode): OutgoingSlot[] {
  const cfg = node.config;
  switch (edgeKind(node)) {
    case "start":
    case "send_message":
    case "send_media":
    case "collect_input":
    case "ask_media":
    case "ask_location":
    case "ask_address":
    case "send_form":
    case "send_product":
    case "send_product_list":
    case "send_catalog":
    case "set_tag":
    case "assign_agent":
    case "conversion_event":
    case "send_storefront_link":
    case "set_attribute":
      return [{ id: "next", label: "Next" }];

    case "payment_link":
      return [{ id: "paid", label: "Paid" }];

    case "book_appointment":
      return [{ id: "success", label: "Booked" }];

    case "ai_reply":
      return [{ id: "answered", label: "Answered" }];

    case "condition":
      return [
        { id: "true", label: "true" },
        { id: "false", label: "false" },
      ];

    case "api_request":
      return [
        ...((Array.isArray(cfg.routes) ? cfg.routes : []) as Array<Record<string, unknown>>).map((route, i) => ({ id: `route:${i}`, label: String(route.status ?? "") })),
        { id: "fallback", label: "Fallback" },
      ];

    case "send_buttons": {
      const buttons = Array.isArray((cfg as { buttons?: unknown }).buttons)
        ? ((cfg as { buttons: Array<Record<string, unknown>> }).buttons)
        : [];
      return buttons
        .filter((b) => typeof b.reply_id === "string" && b.reply_id)
        .map((b) => {
          const replyId = b.reply_id as string;
          const title = typeof b.title === "string" ? b.title : null;
          return {
            id: `button:${replyId}`,
            label: title ?? replyId,
          };
        });
    }

    case "send_list": {
      const sections = Array.isArray((cfg as { sections?: unknown }).sections)
        ? ((cfg as { sections: Array<Record<string, unknown>> }).sections)
        : [];
      const slots: OutgoingSlot[] = [];
      for (const section of sections) {
        const rows = Array.isArray(section.rows)
          ? (section.rows as Array<Record<string, unknown>>)
          : [];
        for (const row of rows) {
          const replyId =
            typeof row.reply_id === "string" ? row.reply_id : null;
          if (!replyId) continue;
          const title = typeof row.title === "string" ? row.title : null;
          slots.push({
            id: `row:${replyId}`,
            label: title ?? replyId,
          });
        }
      }
      return slots;
    }

    case "connect_flow":
    case "handoff":
    case "end":
      return [];
  }
}

/**
 * Compute the config patch to apply when the user drags an edge from
 * `sourceHandle` on a node to `targetKey`. Returns `null` when the
 * handle isn't recognised on the node type (defensive — React-Flow
 * would have to misroute for this to fire).
 *
 * For `send_buttons` and `send_list`, only the button/row with the
 * matching reply_id is patched; the rest of the array passes through
 * unchanged.
 */
export function applyEdgeConnection(
  node: BuilderNode,
  sourceHandle: string,
  targetKey: string,
): Record<string, unknown> | null {
  const port = extraPorts(node).find((p) => p.handle === sourceHandle);
  if (port) return { [port.field]: targetKey };
  switch (edgeKind(node)) {
    case "start":
    case "send_message":
    case "send_media":
    case "collect_input":
    case "ask_media":
    case "ask_location":
    case "ask_address":
    case "send_form":
    case "send_product":
    case "send_product_list":
    case "send_catalog":
    case "set_tag":
    case "assign_agent":
    case "conversion_event":
    case "send_storefront_link":
    case "set_attribute":
      if (sourceHandle === "next") return { next_node_key: targetKey };
      return null;

    case "payment_link":
      return sourceHandle === "paid" ? { paid_next: targetKey } : null;

    case "book_appointment":
      return sourceHandle === "success" ? { success_next: targetKey } : null;

    case "ai_reply":
      return sourceHandle === "answered" ? { next_node_key: targetKey } : null;

    case "condition":
      if (sourceHandle === "true") return { true_next: targetKey };
      if (sourceHandle === "false") return { false_next: targetKey };
      return null;

    case "api_request": {
      if (sourceHandle === "fallback") return { fallback_next: targetKey };
      const i = sourceHandle.startsWith("route:") ? Number(sourceHandle.slice("route:".length)) : NaN;
      const list = (Array.isArray(node.config.routes) ? node.config.routes : []) as Array<Record<string, unknown>>;
      if (!Number.isInteger(i) || !list[i]) return null;
      return { routes: list.map((r, j) => (j === i ? { ...r, next_node_key: targetKey } : r)) };
    }

    case "send_buttons": {
      if (!sourceHandle.startsWith("button:")) return null;
      const replyId = sourceHandle.slice("button:".length);
      const buttons = Array.isArray(
        (node.config as { buttons?: unknown }).buttons,
      )
        ? (node.config as {
            buttons: Array<Record<string, unknown>>;
          }).buttons
        : [];
      // No matching button → no-op (caller should have surfaced a
      // missing slot before letting the user drag).
      if (!buttons.some((b) => b.reply_id === replyId)) return null;
      return {
        buttons: buttons.map((b) =>
          b.reply_id === replyId ? { ...b, next_node_key: targetKey } : b,
        ),
      };
    }

    case "send_list": {
      if (!sourceHandle.startsWith("row:")) return null;
      const replyId = sourceHandle.slice("row:".length);
      const sections = Array.isArray(
        (node.config as { sections?: unknown }).sections,
      )
        ? (node.config as {
            sections: Array<Record<string, unknown>>;
          }).sections
        : [];
      let matched = false;
      const next = sections.map((s) => {
        const rows = Array.isArray(s.rows)
          ? (s.rows as Array<Record<string, unknown>>)
          : [];
        return {
          ...s,
          rows: rows.map((r) => {
            if (r.reply_id === replyId) {
              matched = true;
              return { ...r, next_node_key: targetKey };
            }
            return r;
          }),
        };
      });
      return matched ? { sections: next } : null;
    }

    case "connect_flow":
    case "handoff":
    case "end":
      return null;
  }
}

/**
 * Walk every node and clear any `next_node_key` / `true_next` /
 * `false_next` / `button.next_node_key` / `row.next_node_key`
 * reference to `deletedKey`. Cleared refs become the empty string —
 * the same "no target picked" sentinel the builder forms use.
 *
 * Returns a new array; original nodes are left untouched. Nodes
 * without any matching reference pass through by identity to avoid
 * needless re-renders downstream.
 */
export function unlinkNodeReferences(
  nodes: BuilderNode[],
  deletedKey: string,
): BuilderNode[] {
  return nodes.map((n) => {
    const patched = patchedConfigWithoutKey(n, deletedKey);
    // Optional ports (skip / attempts used up / timeout) are cleared on any node type.
    const ports = ["skip_next", "exhausted_next", "after_timeout", "expired_next", "failed_next", "handoff_next", "unavailable_next", "cancelled_next"].filter((field) => n.config[field] === deletedKey);
    if (!patched && !ports.length) return n;
    return { ...n, config: { ...(patched ?? n.config), ...Object.fromEntries(ports.map((field) => [field, ""])) } };
  });
}

function patchedConfigWithoutKey(
  node: BuilderNode,
  deletedKey: string,
): Record<string, unknown> | null {
  const cfg = node.config;
  switch (edgeKind(node)) {
    case "start":
    case "send_message":
    case "send_media":
    case "collect_input":
    case "ask_media":
    case "ask_location":
    case "ask_address":
    case "send_form":
    case "send_product":
    case "send_product_list":
    case "send_catalog":
    case "set_tag":
    case "assign_agent":
    case "conversion_event":
    case "send_storefront_link":
    case "set_attribute": {
      const next = (cfg as { next_node_key?: string }).next_node_key;
      if (next !== deletedKey) return null;
      return { ...cfg, next_node_key: "" };
    }

    case "payment_link":
      return cfg.paid_next === deletedKey ? { ...cfg, paid_next: "" } : null;

    case "book_appointment":
      return cfg.success_next === deletedKey ? { ...cfg, success_next: "" } : null;

    case "ai_reply":
      return cfg.next_node_key === deletedKey ? { ...cfg, next_node_key: "" } : null;

    case "condition": {
      const c = cfg as { true_next?: string; false_next?: string };
      const trueMatch = c.true_next === deletedKey;
      const falseMatch = c.false_next === deletedKey;
      if (!trueMatch && !falseMatch) return null;
      return {
        ...cfg,
        ...(trueMatch ? { true_next: "" } : {}),
        ...(falseMatch ? { false_next: "" } : {}),
      };
    }

    case "api_request": {
      const list = ((Array.isArray(cfg.routes) ? cfg.routes : []) as Array<Record<string, unknown>>);
      if (!list.some((r) => r.next_node_key === deletedKey) && cfg.fallback_next !== deletedKey) return null;
      return {
        ...cfg,
        routes: list.map((r) => (r.next_node_key === deletedKey ? { ...r, next_node_key: "" } : r)),
        ...(cfg.fallback_next === deletedKey ? { fallback_next: "" } : {}),
      };
    }

    case "send_buttons": {
      const buttons = Array.isArray((cfg as { buttons?: unknown }).buttons)
        ? (cfg as {
            buttons: Array<Record<string, unknown>>;
          }).buttons
        : [];
      if (!buttons.some((b) => b.next_node_key === deletedKey)) return null;
      return {
        ...cfg,
        buttons: buttons.map((b) =>
          b.next_node_key === deletedKey ? { ...b, next_node_key: "" } : b,
        ),
      };
    }

    case "send_list": {
      const sections = Array.isArray((cfg as { sections?: unknown }).sections)
        ? (cfg as {
            sections: Array<Record<string, unknown>>;
          }).sections
        : [];
      let dirty = false;
      const next = sections.map((s) => {
        const rows = Array.isArray(s.rows)
          ? (s.rows as Array<Record<string, unknown>>)
          : [];
        return {
          ...s,
          rows: rows.map((r) => {
            if (r.next_node_key === deletedKey) {
              dirty = true;
              return { ...r, next_node_key: "" };
            }
            return r;
          }),
        };
      });
      return dirty ? { ...cfg, sections: next } : null;
    }

    case "connect_flow":
    case "handoff":
    case "end":
      return null;
  }
}

