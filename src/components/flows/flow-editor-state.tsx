"use client";
import { authFetch } from "@/lib/auth/client";

/**
 * Single source of truth for the flow editor's state.
 *
 * Both views (list and canvas) read and mutate the same `BuilderState`
 * via `useFlowEditor()`. The provider mounts once inside
 * `FlowEditorShell`, so toggling views never resets unsaved edits.
 *
 * What lives here:
 *   - `BuilderState` shape (header fields, trigger config, nodes).
 *   - Dirty / saving / activating flags so the header save state
 *     and the leave guard share the same source.
 *   - Stage 5: undo / redo (use-history.ts) over every edit, autosave
 *     1.5 s after the last edit with a `draft_changed` conflict stop
 *     (use-autosave.ts), extra triggers, test usernames, canvas notes.
 *   - All mutations: name / description / trigger / fallback,
 *     addNode / updateNode / updateNodeConfig / updateNodePosition /
 *     removeNode, setEntryNodeId.
 *   - Side effects: save (PUT), setStatus (POST /activate),
 *     deleteFlow (DELETE then router.push).
 *   - Validation issues + the canActivate boolean.
 *
 * What does NOT live here:
 *   - List-view UI state (expanded card set, scroll refs,
 *     flash-on-jump) — those are list-only and stay in
 *     `flow-builder.tsx`.
 *   - Canvas-view UI state (selected node id, side-sheet open) —
 *     those are canvas-only and stay in `flow-canvas.tsx`.
 *
 * `removeNode` does NOT auto-clean inbound edges. The list-view's
 * NodeKeySelect dropdowns and the validator both surface dangling
 * `next_node_key` references; that visibility is enough for v1. PR 2b
 * (canvas delete via keyboard) will revisit if the canvas adds an
 * implicit-delete affordance that's easier to trip accidentally.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  validateFlowForActivation,
  type ValidationIssue,
} from "@/lib/flows/validate";
import { useTranslations } from "next-intl";
import { getT } from "@/lib/i18n/translate";
import { unlinkNodeReferences } from "@/lib/flows/edges";
import { startsFromComment, type CanvasNote, type FlowChannelScope, type FlowNodeRow, type FlowNodeType, type FlowRow, type FlowTriggerType } from "@/lib/flows/types";
import { focusedFieldKey, historyShortcut, isTextEditingTarget, useHistory } from "./use-history";
import { useAutosave, type AutosaveStatus, type SaveOutcome } from "./use-autosave";
import { resolveFallbackPolicy } from "@/lib/flows/fallback";
import { flowNodesFor, scopeChannels, triggerAvailableOn } from "@/lib/channels/capabilities";
import { channelPath } from "@/lib/channels/routes";
import type { Channel } from "@/types";
import { ADD_NODE_TYPES, NODE_META, STAGE5_ADD_NODE_TYPES, slugify, type BuilderNode, type NodeType } from "./shared";
import { placeableNodeTypes, withPrivateReplyEntry } from "./nodes/ig-node-config";

// ============================================================
// State shape
// ============================================================

export interface BuilderState {
  name: string;
  description: string;
  trigger_type: FlowTriggerType;
  trigger_config: Record<string, unknown>;
  entry_node_id: string | null;
  status: FlowRow["status"];
  fallback_policy: FlowRow["fallback_policy"];
  /** Numbers a draft runs for while it is being tested (digits, up to 3). */
  test_numbers: string[];
  nodes: BuilderNode[];
  /** Stage 5: further triggers (Instagram flows; triggers/trigger-stack.tsx). Absent = none. */
  extra_triggers?: Array<{ trigger_type: FlowTriggerType; config: Record<string, unknown> }>;
  /** Stage 5: Instagram usernames a draft runs for (lowercase, no @, up to 3). */
  test_usernames?: string[];
  /** Stage 5: sticky notes on the canvas (never run). */
  canvas_notes?: CanvasNote[];
}

/** Options for an edit: `key` coalesces repeated edits of one field into one undo step. */
export interface EditOptions {
  key?: string | null;
}

/** Undo and redo of every edit made in this session (use-history.ts). */
export interface EditorHistory {
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

export interface FlowEditorContextValue {
  /** Immutable post-load envelope: id, created_at, fallback_policy, etc. */
  flow: FlowRow;

  // Authored state
  state: BuilderState;
  /**
   * Dirty-tracking React setState. Flips `dirty` on every call. Used
   * by the list view's existing subcomponents (Header, TriggerPanel,
   * EntryPicker) which mutate multiple fields atomically — granular
   * setters below would force them to fan out the update.
   */
  setState: (
    updaterOrValue:
      | BuilderState
      | ((prev: BuilderState) => BuilderState),
    options?: EditOptions,
  ) => void;
  /** Edits the last save did not include (autosave saves them shortly). */
  dirty: boolean;
  saving: boolean;
  activating: boolean;
  /** Undo / redo (Stage 5). */
  history: EditorHistory;
  /** Autosave state for the header (Saving…, Saved, Not saved, conflict). */
  saveStatus: AutosaveStatus;
  /**
   * Saves now if anything is unsaved (after a save in flight) and resolves
   * whether the draft is saved. Publish, Pause and Archive await it.
   */
  flush: () => Promise<boolean>;
  /** Someone saved a newer draft: autosave stopped until the author reloads or overwrites. */
  conflict: boolean;
  /** Reloads the page to show the newer draft (drops this session's edits and history). */
  reloadDraft: () => void;
  /** Saves this editor's draft over the newer one and resumes autosave. */
  overwriteDraft: () => Promise<void>;
  issues: ValidationIssue[];
  canActivate: boolean;

  // Node mutations. addNode returns the generated key so the caller
  // (a NodeCard "Add" button or canvas "+" button) can scroll to /
  // focus / open the new node.
  addNode: (type: NodeType) => string;
  updateNode: (key: string, patch: Partial<BuilderNode>) => void;
  updateNodeConfig: (key: string, patch: Record<string, unknown>) => void;
  updateNodePosition: (key: string, x: number, y: number) => void;
  /**
   * Moves nodes without dirtying the editor (layout of a flow that had no
   * positions yet). `record: true` makes it an undoable edit (Arrange).
   */
  updateNodePositions: (
    positions: Record<string, { x: number; y: number }>,
    options?: { record?: boolean },
  ) => void;
  removeNode: (key: string) => void;

  // Actions
  /** "Save now": saves the draft; resolves false when the save failed (already shown). */
  save: () => Promise<boolean>;
  setStatus: (status: BuilderState["status"]) => Promise<void>;
  /**
   * Hash of the draft as this editor last loaded or saved it. Publishing
   * sends it, so a draft another member saved since is refused (409)
   * instead of going live unseen.
   */
  draftHash: string | null;
  /** Publishes the saved draft (no save first) by draftHash; resolves true when it went live. */
  publish: () => Promise<boolean>;
  deleteFlow: () => Promise<void>;

  /**
   * Transient "look here" signal. Set when the validation panel's
   * issue is clicked — both views subscribe: list scrolls the row
   * into view and flashes its border, canvas pans the viewport to
   * the node and flashes its card. Auto-clears after 1600ms so the
   * flash is a one-shot.
   *
   * Lives in context (not local view state) so the panel can be
   * rendered ONCE in the shell and trigger flashes in whichever
   * view is currently mounted, without per-view plumbing.
   */
  flashKey: string | null;
  requestFlash: (key: string) => void;

  /**
   * The WhatsApp number the flow triggers on (null = every number).
   * Saved on its own through PUT /api/flows/[id]/number, not by Save,
   * so it is not part of `state` and never marks the form dirty. Kept
   * here rather than in the Settings popover, which unmounts on close:
   * reopening it must show the last saved number, not the loaded row's.
   */
  triggerNumber: string | null;
  setTriggerNumber: (next: string | null) => void;
  /** Which channels the flow runs on (Phase 11). Saved on its own, like the trigger number. */
  channelScope: FlowChannelScope;
  setChannelScope: (next: FlowChannelScope) => void;
  /** The channel section the editor is open in (Stage 1): its back and delete links go there. */
  section: Channel;
  /** The steps the add-step menus offer: those every channel of the flow runs (canvas and list). */
  nodeTypes: NodeType[];
  /** The triggers the trigger picker offers, likewise. */
  triggerTypes: BuilderState["trigger_type"][];
  /**
   * The trigger comment steps are judged by: the primary one, or a comment
   * trigger among the extra triggers (Stage 5), so a flow that also starts
   * from a comment may take a private reply.
   */
  commentTrigger: FlowTriggerType;
}

/** The trigger type comment steps follow (see FlowEditorContextValue.commentTrigger). */
export function commentTriggerOf(state: Pick<BuilderState, "trigger_type" | "extra_triggers">): FlowTriggerType {
  if (startsFromComment(state.trigger_type)) return state.trigger_type;
  return (state.extra_triggers ?? []).find((t) => startsFromComment(t.trigger_type))?.trigger_type ?? state.trigger_type;
}

/** The PUT /api/flows/[id] body for a draft (Stage 5 adds triggers, usernames, notes and the autosave base). */
export function draftPayload(state: BuilderState, channelScope: FlowChannelScope, baseUpdatedAt: string | null): Record<string, unknown> {
  return {
    name: state.name,
    description: state.description || null,
    fallback_policy: state.fallback_policy,
    trigger_type: state.trigger_type,
    trigger_config: state.trigger_config,
    extra_triggers: state.extra_triggers ?? [],
    entry_node_id: state.entry_node_id,
    test_numbers: state.test_numbers,
    test_usernames: state.test_usernames ?? [],
    canvas_notes: state.canvas_notes ?? [],
    channel_scope: channelScope,
    nodes: state.nodes,
    // The server refuses (409 draft_changed) when its draft is newer than this; omitted, it overwrites.
    ...(baseUpdatedAt ? { base_updated_at: baseUpdatedAt } : {}),
  };
}

/** Whether a PUT answer means another save got there first (Stage 5 autosave contract). */
export function isDraftConflict(status: number, json: unknown): boolean {
  if (status !== 409 || !json || typeof json !== "object") return false;
  const body = json as Record<string, unknown>;
  return body.code === "draft_changed" || body.error === "draft_changed" || body.reason === "draft_changed";
}

/**
 * Every trigger the editor knows, in picker order. The record makes a trigger
 * type added to FlowTriggerConfig a compile error until it is placed here.
 */
const BUILDER_TRIGGER_ORDER = {
  keyword: 1, ig_comment: 2, ig_live_comment: 3, ig_story_reply: 4, ig_story_mention: 5, ig_ref: 6, template_reply: 7,
  first_inbound_message: 8, order_received: 9, ad_click: 10, default_reply: 11, manual: 12, ig_share_to_story: 13,
} satisfies Record<FlowTriggerType, number>;
const BUILDER_TRIGGERS = (Object.keys(BUILDER_TRIGGER_ORDER) as FlowTriggerType[])
  .sort((a, b) => BUILDER_TRIGGER_ORDER[a] - BUILDER_TRIGGER_ORDER[b]);

/**
 * The add-step menu for a scope: steps every channel it runs on offers ('any'
 * gets the overlap). The Stage 5 steps (Actions, Randomizer, Smart delay,
 * Google Sheets) join Instagram flows' menus; WhatsApp builder menus stay as
 * they were (capabilities.ts still decides per channel what can run).
 */
export function nodeTypesForScope(scope: FlowChannelScope | null | undefined): NodeType[] {
  const offered = scopeChannels(scope).map((channel) => new Set<string>(flowNodesFor(channel)));
  const types = scope === "instagram" ? [...ADD_NODE_TYPES, ...STAGE5_ADD_NODE_TYPES] : ADD_NODE_TYPES;
  return types.filter((type) => offered.every((set) => set.has(type as FlowNodeType)));
}

/** The trigger picker for a scope: triggers every channel it runs on offers. */
export function triggerTypesForScope(scope: FlowChannelScope | null | undefined): BuilderState["trigger_type"][] {
  const channels = scopeChannels(scope);
  return BUILDER_TRIGGERS.filter((trigger) => channels.every((channel) => triggerAvailableOn(trigger, channel)));
}

/** The section a flow opens in when the page does not say: its own channel, WhatsApp for a legacy 'any' flow. */
export function defaultSection(scope: FlowChannelScope | null | undefined): Channel {
  return scope === "instagram" ? "instagram" : "whatsapp";
}

// ============================================================
// Helpers — node_key generation + per-type default configs
// ============================================================

export function uniqueNodeKey(base: string, existing: BuilderNode[]): string {
  if (!existing.some((n) => n.node_key === base)) return base;
  let i = 2;
  while (existing.some((n) => n.node_key === `${base}_${i}`)) i += 1;
  return `${base}_${i}`;
}

export function defaultConfigFor(type: NodeType): Record<string, unknown> {
  const t = getT("Flows.editorState");
  const tForm = getT("Flows.builder.form");
  switch (type) {
    case "start":
      return { next_node_key: "" };
    case "send_message":
      return { text: "", next_node_key: "" };
    case "send_buttons":
      return {
        text: "",
        buttons: [{ reply_id: "yes", title: t("defaultYes"), next_node_key: "" }],
      };
    case "send_list":
      return {
        text: "",
        button_label: t("defaultListButton"),
        sections: [
          {
            title: "",
            rows: [
              { reply_id: "row_1", title: tForm("optionN", { n: 1 }), next_node_key: "" },
            ],
          },
        ],
      };
    case "send_media":
      return {
        media_type: "image",
        media_url: "",
        caption: "",
        filename: "",
        next_node_key: "",
      };
    case "collect_input":
      return {
        prompt_text: "",
        var_key: "answer",
        next_node_key: "",
      };
    case "ask_media":
      return { prompt_text: "", media_types: [], var_key: "media", next_node_key: "" };
    case "ask_location":
      return { prompt_text: "", var_key: "location", next_node_key: "" };
    case "ask_address":
      return { prompt_text: "", var_key: "address", next_node_key: "" };
    case "send_form":
      return { form_id: "", cta: "", body: "", var_key: "form", next_node_key: "" };
    case "payment_link":
      return { amount: "", currency: "INR", description: "", message: "", paid_next: "", expired_next: "", failed_next: "" };
    case "book_appointment":
      // No services picked = every bookable service, so a fresh step works as soon as appointments are set up.
      return { service_ids: [], staff_mode: "any", days_ahead: 7, success_next: "", unavailable_next: "", cancelled_next: "" };
    case "send_product":
      return { product_retailer_id: "", body_text: "", next_node_key: "" };
    case "send_product_list":
      return { header_text: "", body_text: "", sections: [{ title: "", product_retailer_ids: [] }], next_node_key: "" };
    case "send_catalog":
      return { body_text: "", next_node_key: "" };
    case "set_attribute":
      return { target: "var", key: "", value: "", next_node_key: "" };
    case "send_template":
      return { template_name: "", body_params: [], buttons: [], next_node_key: "" };
    case "api_request":
      return { method: "GET", url: "", params: [], headers: [], body: "", mappings: [], routes: [{ status: "2xx", next_node_key: "" }], fallback_next: "" };
    case "assign_agent":
      return { mode: "round_robin", next_node_key: "" };
    case "connect_flow":
      return { flow_id: "" };
    case "condition":
      return {
        subject: "var",
        subject_key: "",
        operator: "equals",
        value: "",
        true_next: "",
        false_next: "",
      };
    case "set_tag":
      return { mode: "add", tag_id: "", next_node_key: "" };
    case "ai_reply":
      // One answer from the knowledge base; both ports are wired by the author.
      return { instructions: "", use_knowledge: true, max_turns: 1, next_node_key: "", handoff_next: "" };
    case "conversion_event":
      return { event_name: "LeadSubmitted", next_node_key: "" };
    case "send_storefront_link":
      return { message: "", ttl_hours: 24, purpose: "shop", next_node_key: "", failed_next: "" };
    // Instagram-only steps (Stage 2).
    case "ig_comment_reply":
      return { replies: [""], next_node_key: "" };
    case "ig_private_reply":
      return { text: "", opt_in_label: t("defaultOptInLabel"), next_node_key: "" };
    case "send_card":
      return { card: { title: "", subtitle: "", buttons: [] }, next_node_key: "" };
    case "send_gallery":
      return { cards: [{ title: "", subtitle: "", buttons: [] }], next_node_key: "" };
    // Stage 5 steps (5A defaults; 5C's forms edit them).
    case "actions":
      return { actions: [], next_node_key: "" };
    case "randomizer":
      return { paths: [{ id: "A", weight: 50, next_node_key: "" }, { id: "B", weight: 50, next_node_key: "" }], sticky: false };
    case "smart_delay":
      return { mode: "duration", amount: 1, unit: "hours", next_node_key: "" };
    case "google_sheets":
      return { op: "insert_row", spreadsheet_id: "", sheet: "", columns: [], next_node_key: "", failure_next: "" };
    case "handoff":
      return { note: "" };
    case "end":
      return {};
  }
}

/**
 * Appends a new node under an already-chosen key. The key is picked
 * outside the state updater (see addNode) so the caller always gets
 * back the key the node actually receives.
 */
export function appendNode(
  s: BuilderState,
  type: NodeType,
  node_key: string,
): BuilderState {
  const next: BuilderNode = {
    node_key,
    node_type: type,
    config: defaultConfigFor(type),
  };
  // A private reply is a comment flow's first step: it becomes the entry, ahead of the old one.
  if (type === "ig_private_reply") {
    const placed = withPrivateReplyEntry([...s.nodes, next], s.entry_node_id, node_key);
    return { ...s, nodes: placed.nodes, entry_node_id: placed.entry };
  }
  return {
    ...s,
    nodes: [...s.nodes, next],
    // If this is the first node and it's a start, pick it as
    // the entry automatically. Saves a click.
    entry_node_id: s.entry_node_id ?? (type === "start" ? node_key : null),
  };
}

export function applyNodePositions(
  nodes: BuilderNode[],
  positions: Record<string, { x: number; y: number }>,
): BuilderNode[] {
  return nodes.map((n) => {
    const next = positions[n.node_key];
    return next
      ? {
          ...n,
          position_x: Math.round(next.x),
          position_y: Math.round(next.y),
        }
      : n;
  });
}

// ============================================================
// Context
// ============================================================

const FlowEditorCtx = createContext<FlowEditorContextValue | null>(null);

export function useFlowEditor(): FlowEditorContextValue {
  const ctx = useContext(FlowEditorCtx);
  if (!ctx) {
    throw new Error(
      "useFlowEditor must be called inside <FlowEditorProvider>",
    );
  }
  return ctx;
}

// ============================================================
// Provider
// ============================================================

interface ProviderProps {
  initialFlow: FlowRow;
  initialNodes: FlowNodeRow[];
  /** draft_hash from the page-load GET. */
  initialDraftHash?: string | null;
  /** The channel section the editor is open in; defaults to the flow's own channel. */
  section?: Channel;
  children: ReactNode;
}

export type PublishOutcome =
  /** `updatedAt`: the flow row's new updated_at, the base the next autosave sends (absent when the server sent none). */
  | { kind: "published"; status: BuilderState["status"]; updatedAt?: string }
  | { kind: "save_failed" }
  | { kind: "draft_changed"; message: string | null }
  | { kind: "failed"; message: string | null; status: number };

/**
 * Publishes a flow's saved draft. With saveFirst, saves and stops when the
 * save fails; the hash sent is the one that save returned, else draftHash.
 * The server refuses (409) a draft other than the hashed one.
 */
export async function publishDraft(args: {
  flowId: string;
  draftHash: string | null;
  saveFirst?: () => Promise<string | null | false>;
  fetcher?: typeof authFetch;
}): Promise<PublishOutcome> {
  let hash = args.draftHash;
  if (args.saveFirst) {
    const saved = await args.saveFirst();
    if (saved === false) return { kind: "save_failed" };
    hash = saved ?? hash;
  }
  const res = await (args.fetcher ?? authFetch)(`/api/flows/${args.flowId}/activate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(hash ? { status: "active", draft_hash: hash } : { status: "active" }),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: unknown; draft_hash?: unknown; flow?: { status?: BuilderState["status"]; updated_at?: unknown } };
  const message = typeof json.error === "string" ? json.error : null;
  if (res.status === 409 && json.draft_hash !== undefined) return { kind: "draft_changed", message };
  if (!res.ok) return { kind: "failed", message, status: res.status };
  const updatedAt = json.flow?.updated_at;
  return { kind: "published", status: json.flow?.status ?? "active", ...(typeof updatedAt === "string" ? { updatedAt } : {}) };
}

/** True when a click on `event` follows an in-app link the leave guard should confirm. */
export function isGuardedLinkClick(event: Pick<MouseEvent, "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "defaultPrevented" | "target">, origin: string): boolean {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return false;
  try {
    const url = new URL(anchor.href, origin);
    return url.origin === origin;
  } catch {
    return false;
  }
}

export function FlowEditorProvider({
  initialFlow,
  initialNodes,
  initialDraftHash = null,
  section: sectionProp,
  children,
}: ProviderProps) {
  const router = useRouter();
  const t = useTranslations("Flows.editorState");
  const tAuto = useTranslations("Flows.autosave");

  // Authored state with undo / redo (use-history.ts). Status changes and the
  // first layout of a position-less flow are not edits (history.replace).
  const history = useHistory<BuilderState>(() => ({
    name: initialFlow.name,
    description: initialFlow.description ?? "",
    trigger_type: initialFlow.trigger_type,
    trigger_config: initialFlow.trigger_config as Record<string, unknown>,
    extra_triggers: (initialFlow.extra_triggers ?? []) as BuilderState["extra_triggers"],
    entry_node_id: initialFlow.entry_node_id,
    fallback_policy: initialFlow.fallback_policy ?? resolveFallbackPolicy(null),
    status: initialFlow.status,
    test_numbers: initialFlow.test_numbers ?? [],
    test_usernames: initialFlow.test_usernames ?? [],
    canvas_notes: initialFlow.canvas_notes ?? [],
    nodes: initialNodes.map((n) => ({
      node_key: n.node_key,
      node_type: n.node_type as NodeType,
      config: n.config as Record<string, unknown>,
      position_x: n.position_x,
      position_y: n.position_y,
    })),
  }));
  const state = history.present;
  const { record, replace } = history;

  // Latest nodes for addNode's key choice. Kept in sync after each
  // commit, and addNode appends to it eagerly so several adds in one
  // batch still get distinct keys.
  const nodesRef = useRef(state.nodes);
  useLayoutEffect(() => {
    nodesRef.current = state.nodes;
  }, [state.nodes]);

  const [activating, setActivating] = useState(false);
  // The ref is read right after a save in the same tick; the state re-renders consumers.
  const [draftHash, setDraftHashState] = useState<string | null>(initialDraftHash);
  const draftHashRef = useRef<string | null>(initialDraftHash);
  const setDraftHash = useCallback((next: string | null) => {
    draftHashRef.current = next;
    setDraftHashState(next);
  }, []);
  const [triggerNumber, setTriggerNumber] = useState<string | null>(initialFlow.whatsapp_config_id ?? null);
  const [channelScope, setChannelScope] = useState<FlowChannelScope>(initialFlow.channel_scope ?? "whatsapp");
  const section = sectionProp ?? defaultSection(initialFlow.channel_scope);
  const commentTrigger = useMemo(() => commentTriggerOf(state), [state]);
  // The channel palette, less the comment steps this flow cannot take (ig-node-config.ts).
  const nodeTypes = useMemo(() => placeableNodeTypes(nodeTypesForScope(channelScope), commentTrigger, state.nodes),
    [channelScope, commentTrigger, state.nodes]);
  const triggerTypes = useMemo(() => triggerTypesForScope(channelScope), [channelScope]);

  // ---- Dirty tracking: history.seq counts edits; savedSeq is the seq the last save included. ----
  const seqRef = useRef(history.seq);
  useLayoutEffect(() => {
    seqRef.current = history.seq;
  }, [history.seq]);
  const savedSeqRef = useRef(0);
  const [savedSeq, setSavedSeq] = useState(0);
  const dirty = history.seq !== savedSeq;

  // Every edit goes through history. While a text field has focus the edit
  // coalesces with the previous one from that field (one undo step per burst).
  const setState = useCallback((
    updaterOrValue: BuilderState | ((prev: BuilderState) => BuilderState),
    options?: EditOptions,
  ) => {
    const key = options?.key !== undefined ? options.key : focusedFieldKey(typeof document === "undefined" ? null : document.activeElement);
    record(updaterOrValue, key);
  }, [record]);

  // Cross-view "look here" signal (see FlowEditorContextValue docs).
  // Tracked via a ref alongside state so a rapid second click on a
  // different issue cancels the previous timeout instead of letting
  // the first flash linger past the new one.
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const flashTimeoutRef = useRef<number | null>(null);
  const requestFlash = useCallback((key: string) => {
    if (flashTimeoutRef.current !== null) {
      window.clearTimeout(flashTimeoutRef.current);
    }
    setFlashKey(key);
    flashTimeoutRef.current = window.setTimeout(() => {
      setFlashKey(null);
      flashTimeoutRef.current = null;
    }, 1600);
  }, []);
  useEffect(
    () => () => {
      if (flashTimeoutRef.current !== null) {
        window.clearTimeout(flashTimeoutRef.current);
      }
    },
    [],
  );

  // ---- Validation ----
  const issues = useMemo<ValidationIssue[]>(
    () =>
      validateFlowForActivation(
        {
          name: state.name,
          trigger_type: state.trigger_type,
          trigger_config: state.trigger_config,
          extra_triggers: state.extra_triggers ?? [],
          entry_node_id: state.entry_node_id,
          fallback_policy: state.fallback_policy,
          channel_scope: channelScope,
          id: initialFlow.id,
        },
        state.nodes,
      ),
    [state, channelScope, initialFlow.id],
  );
  const canActivate = useMemo(
    () => issues.every((i) => i.severity !== "error"),
    [issues],
  );

  // ---- Save (PUT) ----
  // The latest state for the save callbacks, which the autosave controller
  // calls outside React's render.
  const stateRef = useRef(state);
  const scopeRef = useRef(channelScope);
  useLayoutEffect(() => {
    stateRef.current = state;
    scopeRef.current = channelScope;
  }, [state, channelScope]);
  // updated_at of the draft this editor last loaded or saved: the PUT sends it
  // so a newer draft saved elsewhere is refused (409 draft_changed), not overwritten.
  const baseUpdatedAtRef = useRef<string | null>(initialFlow.updated_at ?? null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);

  /** One PUT of the current draft. `overwrite` omits the base, replacing a newer draft. */
  const putDraft = useCallback(async (overwrite = false): Promise<SaveOutcome> => {
    const startSeq = seqRef.current;
    setSaving(true);
    try {
      const res = await authFetch(`/api/flows/${initialFlow.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draftPayload(stateRef.current, scopeRef.current, overwrite ? null : baseUpdatedAtRef.current)),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: unknown; draft_hash?: unknown; flow?: { updated_at?: unknown } };
      if (isDraftConflict(res.status, json)) {
        setConflict(true);
        return { ok: false, conflict: true };
      }
      if (!res.ok) {
        return { ok: false, reason: "server", message: typeof json.error === "string" ? json.error : t("saveFailedStatus", { status: res.status }) };
      }
      if (typeof json.draft_hash === "string") setDraftHash(json.draft_hash);
      if (typeof json.flow?.updated_at === "string") baseUpdatedAtRef.current = json.flow.updated_at;
      savedSeqRef.current = startSeq;
      setSavedSeq(startSeq);
      setConflict(false);
      return { ok: true };
    } catch {
      return { ok: false, reason: typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "failed" };
    } finally {
      setSaving(false);
    }
  }, [initialFlow.id, setDraftHash, t]);

  const isDirty = useCallback(() => seqRef.current !== savedSeqRef.current, []);
  const autosave = useAutosave({ save: () => putDraft(false), isDirty, seq: history.seq, enabled: !conflict });
  const { controller } = autosave;
  const saveStatus = autosave.status;

  const flush = useCallback(() => controller.flush(), [controller]);

  // "Save now": saves at once (or confirms nothing is unsaved) and says so.
  const save = useCallback(async () => {
    const ok = await controller.flush();
    if (ok) toast.success(t("saved"));
    else if (!controller.conflicted) toast.error(t("saveFailed"));
    return ok;
  }, [controller, t]);

  const reloadDraft = useCallback(() => {
    savedSeqRef.current = seqRef.current;
    controller.dispose();
    window.location.reload();
  }, [controller]);

  const overwriteDraft = useCallback(async () => {
    const outcome = await putDraft(true);
    if (outcome.ok) {
      controller.resume();
      toast.success(t("saved"));
    } else if (!(!outcome.ok && outcome.conflict)) {
      toast.error(t("saveFailed"));
    }
  }, [controller, putDraft, t]);

  // ---- Leave guard ----
  // Reload / tab close: the browser prompt. In-app links: a confirm while a
  // save is pending or edits are unsaved (Next's App Router fires no
  // beforeunload on client-side navigation).
  const unsaved = dirty || saving || controller.busy;
  useEffect(() => {
    if (!unsaved) return;
    const beforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Modern browsers ignore the return value but require something
      // truthy to actually show the native prompt.
      e.returnValue = "";
    };
    const click = (e: MouseEvent) => {
      if (!isGuardedLinkClick(e, window.location.origin)) return;
      if (!window.confirm(tAuto("leaveWarning"))) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", click, true);
    };
  }, [unsaved, tAuto]);

  // Applies a publish outcome. A draft another member changed is never
  // retried: the page reloads so the author sees what is saved now.
  const finishPublish = useCallback((outcome: PublishOutcome): boolean => {
    if (outcome.kind === "published") {
      // A status change moves the row's updated_at; the next autosave must not read it as someone else's save.
      if (outcome.updatedAt) baseUpdatedAtRef.current = outcome.updatedAt;
      replace((s) => ({ ...s, status: outcome.status }));
      toast.success(t("statusActivated"));
      return true;
    }
    if (outcome.kind === "draft_changed") {
      toast.error(outcome.message ?? t("draftChanged"));
      reloadDraft();
    } else if (outcome.kind === "failed") {
      toast.error(outcome.message ?? t("statusUpdateFailedStatus", { status: outcome.status }));
    } else if (!controller.conflicted) {
      toast.error(t("saveFailed"));
    }
    return false;
  }, [t, replace, reloadDraft, controller]);

  // Waits for any pending save, then hands publishDraft the saved draft's hash.
  const saveFirst = useCallback(async (): Promise<string | null | false> => {
    const ok = await controller.flush();
    return ok ? draftHashRef.current : false;
  }, [controller]);

  const publish = useCallback(async () => {
    setActivating(true);
    try {
      return finishPublish(await publishDraft({ flowId: initialFlow.id, draftHash: draftHashRef.current, saveFirst }));
    } catch {
      toast.error(t("statusUpdateFailed"));
      return false;
    } finally {
      setActivating(false);
    }
  }, [finishPublish, initialFlow.id, saveFirst, t]);

  // ---- Activate / Pause / Archive ----
  const setStatus = useCallback(
    async (next: BuilderState["status"]) => {
      if (next === "active" && !canActivate) {
        toast.error(t("fixIssues"));
        return;
      }
      setActivating(true);
      try {
        // Wait for the pending save so the activation validator sees the
        // latest state, and publish exactly what was saved (by its hash). A
        // failed save stops here: the older server draft must not go live.
        if (next === "active") {
          finishPublish(await publishDraft({ flowId: initialFlow.id, draftHash: draftHashRef.current, saveFirst }));
          return;
        }
        if (!(await controller.flush())) {
          if (!controller.conflicted) toast.error(t("saveFailed"));
          return;
        }
        const res = await authFetch(`/api/flows/${initialFlow.id}/activate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: next }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(json.error ?? t("statusUpdateFailedStatus", { status: res.status }));
        }
        // The server decides the resulting status: asking a published flow
        // for "draft" pauses it, so trust the response over `next`.
        const applied: BuilderState["status"] = json.flow?.status ?? next;
        if (typeof json.flow?.updated_at === "string") baseUpdatedAtRef.current = json.flow.updated_at;
        replace((s) => ({ ...s, status: applied }));
        toast.success(
          applied === "active"
            ? t("statusActivated")
            : applied === "archived"
              ? t("statusArchived")
              : applied === "paused"
                ? t("statusPaused")
                : t("statusDraft")
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : t("statusUpdateFailed");
        toast.error(msg);
      } finally {
        setActivating(false);
      }
    },
    [canActivate, saveFirst, finishPublish, initialFlow.id, t, controller, replace],
  );

  // ---- Delete ----
  const deleteFlow = useCallback(async () => {
    const yes = window.confirm(t("deleteConfirm", { name: state.name }));
    if (!yes) return;
    try {
      const res = await authFetch(`/api/flows/${initialFlow.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        // 409: a published flow must be archived (with no runs left) first;
        // the server's message says so.
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? t("deleteFailedStatus", { status: res.status }));
      }
      // Nothing left to save: leave without the unsaved-changes prompt.
      savedSeqRef.current = seqRef.current;
      setSavedSeq(seqRef.current);
      controller.dispose();
      router.push(channelPath(section, "flows"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("deleteFailed");
      toast.error(msg);
    }
  }, [initialFlow.id, router, section, state.name, t, controller]);

  // ---- Node mutations ----
  const updateNode = useCallback(
    (key: string, patch: Partial<BuilderNode>) => {
      setState((s) => ({
        ...s,
        nodes: s.nodes.map((n) =>
          n.node_key === key ? { ...n, ...patch } : n,
        ),
      }));
    },
    [setState],
  );

  const updateNodeConfig = useCallback(
    (key: string, configPatch: Record<string, unknown>) => {
      setState((s) => ({
        ...s,
        nodes: s.nodes.map((n) =>
          n.node_key === key
            ? { ...n, config: { ...n.config, ...configPatch } }
            : n,
        ),
      }));
    },
    [setState],
  );

  const updateNodePosition = useCallback(
    (key: string, x: number, y: number) => {
      setState((s) => ({
        ...s,
        nodes: s.nodes.map((n) =>
          n.node_key === key
            ? { ...n, position_x: Math.round(x), position_y: Math.round(y) }
            : n,
        ),
      }), { key: null });
    },
    [setState],
  );

  const updateNodePositions = useCallback(
    (positions: Record<string, { x: number; y: number }>, options?: { record?: boolean }) => {
      // Arrange is an edit (undoable). The initial Dagre layout of a
      // position-less flow is not: opening a legacy all-zero flow must not
      // dirty the editor or start an autosave before the user edits anything.
      if (options?.record) {
        setState((s) => ({ ...s, nodes: applyNodePositions(s.nodes, positions) }), { key: null });
        return;
      }
      replace((s) => ({ ...s, nodes: applyNodePositions(s.nodes, positions) }));
    },
    [replace, setState],
  );

  const addNode = useCallback(
    (type: NodeType): string => {
      const meta = NODE_META[type];
      const base = slugify(meta.slugSeed, type);
      // Choose the key here, not inside the updater: React may defer
      // the updater, and the caller needs the real key now to position /
      // wire / select it.
      const node_key = uniqueNodeKey(base, nodesRef.current);
      nodesRef.current = [
        ...nodesRef.current,
        { node_key, node_type: type, config: {} },
      ];
      setState((s) => appendNode(s, type, node_key), { key: null });
      return node_key;
    },
    [setState],
  );

  const removeNode = useCallback(
    (key: string) => {
      // Auto-unlink inbound references so canvas / list deletes don't
      // leave dangling arrows behind that the validator would flag.
      // Cleared refs become "" (the "no target picked" sentinel the
      // builder forms already use).
      setState((s) => ({
        ...s,
        nodes: unlinkNodeReferences(
          s.nodes.filter((n) => n.node_key !== key),
          key,
        ),
        entry_node_id: s.entry_node_id === key ? null : s.entry_node_id,
      }), { key: null });
    },
    [setState],
  );

  const editorHistory = useMemo<EditorHistory>(
    () => ({ undo: history.undo, redo: history.redo, canUndo: history.canUndo, canRedo: history.canRedo }),
    [history.undo, history.redo, history.canUndo, history.canRedo],
  );

  // Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z and Ctrl+Y redo, in both views. While
  // focus is in a text field the browser's own undo applies to its text.
  const { undo: undoEdit, redo: redoEdit } = history;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const command = historyShortcut(e);
      if (!command || e.defaultPrevented || isTextEditingTarget(e.target)) return;
      e.preventDefault();
      if (command === "undo") undoEdit();
      else redoEdit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undoEdit, redoEdit]);

  const value = useMemo<FlowEditorContextValue>(
    () => ({
      flow: initialFlow,
      state,
      setState,
      dirty,
      saving,
      activating,
      history: editorHistory,
      saveStatus,
      flush,
      conflict,
      reloadDraft,
      overwriteDraft,
      issues,
      canActivate,
      addNode,
      updateNode,
      updateNodeConfig,
      updateNodePosition,
      updateNodePositions,
      removeNode,
      save,
      setStatus,
      draftHash,
      publish,
      deleteFlow,
      flashKey,
      requestFlash,
      triggerNumber,
      setTriggerNumber,
      channelScope,
      setChannelScope,
      section,
      nodeTypes,
      triggerTypes,
      commentTrigger,
    }),
    [
      initialFlow,
      state,
      setState,
      dirty,
      saving,
      activating,
      editorHistory,
      saveStatus,
      flush,
      conflict,
      reloadDraft,
      overwriteDraft,
      issues,
      canActivate,
      addNode,
      updateNode,
      updateNodeConfig,
      updateNodePosition,
      updateNodePositions,
      removeNode,
      save,
      setStatus,
      draftHash,
      publish,
      deleteFlow,
      flashKey,
      requestFlash,
      triggerNumber,
      channelScope,
      section,
      nodeTypes,
      triggerTypes,
      commentTrigger,
    ],
  );

  return <FlowEditorCtx.Provider value={value}>{children}</FlowEditorCtx.Provider>;
}
