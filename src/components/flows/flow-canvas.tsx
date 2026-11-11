'use client';

/**
 * Canvas / mind-map view of a flow. Editable, in parity with the
 * list view for everything except the trigger / header / fallback
 * panels (those are list-only — they don't fit visually inside a
 * node graph and the user can switch to List for them).
 *
 * What this view does:
 *   - Renders every flow_node as a draggable tile, pan + zoom +
 *     minimap. Drag positions persist via the editor context
 *     (writing on dragStop, not every frame).
 *   - Renders edges between nodes, labeled per slot (button title,
 *     "true" / "false", list row title) so a branching flow reads
 *     as a real decision tree.
 *   - Click a node → side-sheet opens with the same per-node form
 *     the list view uses, plus "Set as entry" / "Delete".
 *   - Drag from a source handle on one node to a target handle on
 *     another → wires that slot's `next_node_key`. Per-slot handles
 *     for multi-outgoing types (condition, send_buttons, send_list)
 *     so the user picks which branch they're wiring.
 *   - Backspace / Delete on a selected node → removes it AND clears
 *     every inbound `next_node_key` reference (no dangling arrows).
 *   - Delete on a selected edge, or its × button (shown on hover /
 *     select) → clears just that slot.
 *   - Dropping a handle drag on empty canvas → a small step picker at
 *     the drop point; the picked step is created there and wired.
 *   - Lock toggle → no dragging, connecting, deleting or editing (the
 *     inspector turns read-only); pan + zoom still work.
 *   - "+ Add node" floating button drops a new node at the visible
 *     viewport center.
 *   - Runs dagre auto-layout once on mount for flows whose
 *     `position_x` / `position_y` are all zero (pre-canvas flows
 *     and brand-new flows) — otherwise everything would pile at
 *     the origin.
 *
 * Stage 5 (owner amendments 1 and 3):
 *   - A "When…" start card lists the flow's triggers ("+ New trigger" on
 *     Instagram flows) and its "Then" port connects to the first step.
 *   - Step cards carry a header in their group's colour (Content, AI,
 *     Logic); smart delays show Waiting / Passed counts.
 *   - Clicking a card (or a trigger row) opens its editor in a LEFT side
 *     panel; Escape or a click on the canvas closes it.
 *   - Right-edge tools: the round "+" (grouped add-step menu), Arrange,
 *     Zoom in, Zoom out, Fit. Canvas notes are free text, never run.
 *   - Every edit, drag included, is undoable (flow-editor-state history).
 *
 * The toggle in `flow-editor-shell.tsx` swaps this in for
 * `<FlowBuilder>` on the same page. Both views share the same
 * `BuilderState` via `useFlowEditor()` — toggling never resets
 * unsaved edits, and a drag here updates the same nodes array the
 * list view reads.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  MiniMap,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type EdgeProps,
  type OnConnectEnd,
  type Node as RfNode,
  type Edge as RfEdge,
  type NodeChange,
  type NodeProps,
  type OnNodeDrag,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { LayoutGrid, Lock, LockOpen, Maximize, PanelLeftClose, PanelLeftOpen, Plus, Search, Trash2, X, Zap, ZoomIn, ZoomOut } from 'lucide-react';

import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CAPABILITY_SETUP_HREF, filterPaletteTypes, paletteBlock, useWorkspaceCapabilities } from './palette';
import { canvasNodeDimensions } from './canvas-layout';
import {
  applyEdgeConnection,
  deriveCanvasEdges,
  outgoingSlots,
} from '@/lib/flows/edges';
import { autoLayout, shouldAutoLayout } from '@/lib/flows/layout';
import {
  NodeIconChip,
  groupNodeTypesByCategory,
  nodeColors,
  summarizeNode,
  type BuilderNode,
  type NodeType,
} from './shared';
import { commentTriggerOf, useFlowEditor } from './flow-editor-state';
import { NodeConfigForm } from './forms/node-config-form';
import { canRouteInto, entryLocked } from './nodes/ig-node-config';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CANVAS_NOTE_LIMITS, type FlowTriggerType } from '@/lib/flows/types';
import {
  AddStepList,
  addNote,
  groupColors,
  groupOf,
  isNoteNodeId,
  NodeStatsLine,
  noteNodeId,
  NoteCard,
  readNotes,
  removeNote,
  STATS_STEPS,
  updateNote,
  useHasStatsSteps,
  useNodeStats,
  WHEN_HANDLE,
  WHEN_NODE_ID,
  WhenCard,
  type NodeStat,
  type NoteData,
  type WhenData,
} from './canvas-extras';
import {
  addExtraTrigger,
  addTriggerBlock,
  MAX_TRIGGERS,
  removeTrigger,
  setTriggerConfig,
  stackTriggers,
  triggerDetail,
  TriggerPickerDialog,
} from './triggers/trigger-stack';
import { TRIGGER_TITLE_KEYS, TriggerForm } from './triggers/trigger-form';
import { applyTriggerType } from './triggers/ig-trigger-config';
import { useShareToStoryEnabled } from './triggers/ig-post-picker';

// React-Flow node `data` payload — the bits our custom renderer needs.
interface NodeData extends Record<string, unknown> {
  node: BuilderNode;
  isEntry: boolean;
  /** Validator's "look here" pulse — flashes the card border for
   *  ~1.6s. Drives a CSS animation, doesn't change layout. */
  isFlashed: boolean;
  /** Stage 5: Waiting / Passed counts (smart delays), when loaded. */
  stat?: NodeStat | null;
}

const NODE_WIDTH = 260;
/** Room the "When…" card keeps to the left of the first step. */
const WHEN_GAP = 340;
// Best-effort default; actual height varies by summary length but
// dagre needs SOMETHING to compute rank spacing. Underestimating is
// safer than over (tighter layout that still doesn't overlap).
const NODE_HEIGHT = 240;

// ============================================================
// Custom node — one card per flow node, styled to match the list
// view's collapsed card so the two views feel like the same product.
// ============================================================

// Echo the design's green/red branch ports for the condition node's
// true / false slots; every other slot inherits the node's own hue.
// The true/false hues are derived from the start (emerald) and handoff
// (rose) node colors so all branch/port colors stay single-sourced in
// NODE_HUE — a palette tweak there can't leave these stale.
function slotColor(nodeType: NodeType, slotId: string, fallback: string) {
  if (nodeType === 'condition' && slotId === 'true') {
    return nodeColors('start').solid;
  }
  if (nodeType === 'condition' && slotId === 'false') {
    return nodeColors('handoff').solid;
  }
  return fallback;
}

/** Optional ports (edges.ts extraPorts) carry English labels; show them translated. */
const PORT_LABELS: Record<string, string> = { skip: 'ports.skip', exhausted: 'ports.exhausted', timeout: 'ports.timeout', fallback: 'ports.fallback',
  paid: 'ports.paid', expired: 'ports.expired', failed: 'ports.failed', answered: 'ports.answered', handoff: 'ports.handoff' };

function FlowNodeCard({ data, selected, isConnectable }: NodeProps) {
  const t = useTranslations('Flows.builder');
  const { node, isEntry, isFlashed, stat } = data as NodeData;
  const c = nodeColors(node.node_type);
  const g = groupColors(groupOf(node.node_type));
  const tSummary = useTranslations('Flows.summary');
  const summary = summarizeNode(node, tSummary);
  const slots = outgoingSlots(node);
  // Start nodes are entry-only; nothing ever targets them, so they
  // don't need an incoming Handle. Every other node type accepts
  // incoming edges (including terminal handoff / end — they're the
  // common targets).
  // A private reply takes incoming edges too, but only from the steps
  // allowed before it (handleConnect checks canRouteInto).
  const hasTarget = node.node_type !== 'start';
  // Single-slot nodes get a single source handle floated on the right
  // edge of the card. Multi-slot nodes (condition, send_buttons,
  // send_list) render slot rows inline so each handle visually sits
  // next to the slot it represents.
  const isMultiSlot = slots.length > 1 || node.node_type === 'send_buttons' || node.node_type === 'send_list';
  const body = typeof node.config.text === 'string' ? node.config.text : typeof node.config.prompt_text === 'string' ? node.config.prompt_text : summary;
  return (
    <div
      style={
        {
          '--nc': c.solid,
          '--nc-soft': c.soft,
          '--nc-ring': c.ring,
          '--nc-text': c.text,
          borderColor: selected ? c.solid : undefined,
          boxShadow: selected
            ? `0 0 0 1px ${c.solid}, 0 14px 36px -12px ${c.ring}`
            : undefined,
        } as React.CSSProperties
      }
      className={cn(
        'flow-studio-card bg-card relative w-[260px] rounded-2xl border px-4 pb-3.5 pt-0 text-left transition-[box-shadow,border-color]',
        selected
          ? 'border-[var(--nc)]'
          : 'border-border hover:border-[var(--nc-ring)]',
        // Flash overrides hover/selected colors briefly. Tailwind's
        // built-in `animate-pulse` is too gentle; a ring with the
        // amber accent matches the list view's flash semantics.
        isFlashed && '!border-amber-400 ring-2 ring-amber-400/60'
      )}
    >
      {hasTarget && (
        <Handle
          type="target"
          position={Position.Left}
          // Handles default to connectable; pass the canvas lock through
          // or a locked canvas still accepts drag / click connections.
          isConnectable={isConnectable}
          className="!bg-card !h-2.5 !w-2.5 !border-2 !border-[var(--nc-ring)]"
        />
      )}

      {/* Stage 5: a header in the step group's colour (Content, AI, Logic). */}
      <div className="-mx-4 mb-0 flex items-center gap-2 rounded-t-2xl px-4 py-2.5" style={{ background: g.soft }} data-step-group={groupOf(node.node_type)}>
        <NodeIconChip
          type={node.node_type}
          size={24}
          iconSize={14}
          className="rounded-md"
        />
        <span
          className="truncate text-[10.5px] font-semibold tracking-wider uppercase"
          style={{ color: g.text }}
        >
          {t(`nodes.${node.node_type}.label`)}
        </span>
        {isEntry && (
          <span className="border-border text-muted-foreground ml-auto rounded border px-1.5 py-0.5 text-[8.5px] font-bold tracking-[0.1em] uppercase">
            {t('badgeEntry')}
          </span>
        )}
      </div>
      <div className="text-muted-foreground mt-2 truncate font-mono text-[10px] opacity-70">
        {node.node_key}
      </div>
      {body && (
        <div className="flow-studio-message mt-3 break-words rounded-xl border border-border bg-background px-3 py-2.5 text-xs leading-relaxed text-foreground">
          {typeof node.config.header_text === 'string' && node.config.header_text && <p className="mb-1 whitespace-pre-wrap font-semibold">{node.config.header_text}</p>}
          <p className="line-clamp-5 whitespace-pre-wrap">{body}</p>
          {typeof node.config.footer_text === 'string' && node.config.footer_text && <p className="mt-2 whitespace-pre-wrap text-[10px] text-muted-foreground">{node.config.footer_text}</p>}
        </div>
      )}
      {STATS_STEPS.has(node.node_type) && <NodeStatsLine stat={stat} />}

      {isMultiSlot && (
        <div className="border-border mt-2.5 flex flex-col gap-1 border-t pt-2.5">
          {slots.map((slot) => (
            <div
              key={slot.id}
              className="text-primary relative flex items-center justify-between gap-2 rounded-lg border border-border bg-primary-soft px-2 py-2 text-[11px] font-medium"
            >
              <span className="truncate" title={PORT_LABELS[slot.id] ? t(PORT_LABELS[slot.id]) : slot.label}>
                {PORT_LABELS[slot.id] ? t(PORT_LABELS[slot.id]) : slot.label}
              </span>
              <Handle
                type="source"
                id={slot.id}
                position={Position.Right}
                isConnectable={isConnectable}
                style={{
                  borderColor: slotColor(node.node_type, slot.id, c.solid),
                }}
                // Override default absolute positioning so the handle
                // sits flush with the right edge of the card instead
                // of floating at vertical center. The negative offset
                // matches the card's px-3 + the handle's own radius.
                className="!bg-card !relative !top-auto !right-auto !h-2.5 !w-2.5 !translate-x-[14px] !transform-none !border-2"
              />
            </div>
          ))}
        </div>
      )}

      {!isMultiSlot && slots.length === 1 && (
        <Handle
          type="source"
          id={slots[0].id}
          position={Position.Right}
          isConnectable={isConnectable}
          style={{ borderColor: c.solid }}
          className="!bg-card !h-2.5 !w-2.5 !border-2"
        />
      )}
    </div>
  );
}

const NODE_TYPES = { flow: FlowNodeCard, when: WhenCard, note: NoteCard };

// ============================================================
// Custom edge — the default bezier plus a small × at the midpoint
// while the edge is hovered or selected. The canvas hands it the
// delete action and lock / hover state through context so the edge
// objects themselves stay plain data.
// ============================================================

interface EdgeActions {
  locked: boolean;
  hoveredId: string | null;
  hover: (id: string | null) => void;
  clearSlot: (source: string, sourceHandle: string) => void;
}

const EdgeActionsContext = createContext<EdgeActions | null>(null);

function DeletableEdge({
  id,
  source,
  sourceHandleId,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  selected,
  label,
  labelStyle,
  labelShowBg,
  labelBgStyle,
  labelBgPadding,
  labelBgBorderRadius,
  style,
  markerEnd,
  interactionWidth,
}: EdgeProps) {
  const t = useTranslations('Flows.builder');
  const actions = useContext(EdgeActionsContext);
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const show = !!actions && !actions.locked && !!sourceHandleId && (selected || actions.hoveredId === id);
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        label={label}
        labelX={labelX}
        labelY={labelY}
        labelStyle={labelStyle}
        labelShowBg={labelShowBg}
        labelBgStyle={labelBgStyle}
        labelBgPadding={labelBgPadding}
        labelBgBorderRadius={labelBgBorderRadius}
        style={style}
        markerEnd={markerEnd}
        interactionWidth={interactionWidth}
      />
      {show && (
        <EdgeLabelRenderer>
          <button
            type="button"
            aria-label={t('deleteConnection')}
            title={t('deleteConnection')}
            onMouseEnter={() => actions.hover(id)}
            onMouseLeave={() => actions.hover(null)}
            onClick={() => actions.clearSlot(source, sourceHandleId)}
            // Sits just below the slot label (when there is one) so both stay readable.
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY + (label ? 20 : 0)}px)` }}
            className="nodrag nopan border-border bg-card text-muted-foreground hover:border-red-400 hover:text-red-400 pointer-events-auto absolute flex h-5 w-5 items-center justify-center rounded-full border shadow-sm transition-colors focus-visible:outline-2 focus-visible:outline-primary"
          >
            <X className="h-3 w-3" />
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const EDGE_TYPES = { deletable: DeletableEdge };

// ============================================================
// Root canvas
// ============================================================

/**
 * Outer wrapper provides the React-Flow context to the inner body,
 * so `useReactFlow()` works from anywhere in `FlowCanvasInner`
 * (notably, the pan-to-flash effect). The split is required because
 * useReactFlow() must be called inside a ReactFlowProvider.
 */
export function FlowCanvas() {
  return (
    <ReactFlowProvider>
      <FlowCanvasInner />
    </ReactFlowProvider>
  );
}

function FlowCanvasInner() {
  const t = useTranslations('Flows.builder');
  const tm = useTranslations('Flows.multiTrigger');
  const tc = useTranslations('Flows.canvas');
  const {
    flow,
    state,
    setState,
    addNode,
    updateNodeConfig,
    updateNodePosition,
    updateNodePositions,
    removeNode,
    flashKey,
    channelScope,
    nodeTypes,
    triggerTypes,
  } = useFlowEditor();
  const caps = useWorkspaceCapabilities();
  const reactFlow = useReactFlow();
  const builderNodes = state.nodes;
  const entryNodeId = state.entry_node_id;
  const notes = useMemo(() => readNotes(state.canvas_notes), [state.canvas_notes]);
  const triggers = useMemo(() => stackTriggers(state), [state]);
  // A comment flow starts with its private reply; that entry cannot be moved (ig-node-config.ts).
  const entryIsLocked = entryLocked(commentTriggerOf(state), state.nodes, entryNodeId);
  const statsWanted = useHasStatsSteps(builderNodes.map((n) => n.node_type));
  const stats = useNodeStats(flow.id, statsWanted);

  // Side-panel state — which step's (or trigger's) form is open, in the
  // left panel. Canvas-only UI; the list view's analogue is the per-card
  // expanded set in flow-builder.tsx.
  const [selectedNodeKey, setSelectedNodeKeyRaw] = useState<string | null>(null);
  const [selectedTrigger, setSelectedTrigger] = useState<number | null>(null);
  const setSelectedNodeKey = useCallback((key: string | null) => {
    setSelectedNodeKeyRaw(key);
    if (key) setSelectedTrigger(null);
  }, []);
  const openTrigger = useCallback((index: number | null) => {
    setSelectedTrigger(index);
    if (index !== null) setSelectedNodeKeyRaw(null);
  }, []);
  // The step library (every step as tiles) sits in the left panel until a step or trigger is opened there.
  const [libraryOpen, setLibraryOpen] = useState(true);
  const [pickingTrigger, setPickingTrigger] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  // Lock: view-only canvas (pan + zoom still work). Canvas-local, not saved.
  const [locked, setLocked] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const selectNode = useCallback((key: string) => {
    setSelectedNodeKey(key);
    if (window.innerWidth < 1100) setLibraryOpen(false);
  }, [setSelectedNodeKey]);
  const selectedNode = useMemo(
    () =>
      selectedNodeKey
        ? (builderNodes.find((n) => n.node_key === selectedNodeKey) ?? null)
        : null,
    [selectedNodeKey, builderNodes]
  );

  const autoLayoutPositions = useMemo(() => {
    const canvasEdges = deriveCanvasEdges(builderNodes);

    return shouldAutoLayout(builderNodes)
      ? autoLayout(
          builderNodes.map((n) => ({ id: n.node_key, ...canvasNodeDimensions(n) })),
          canvasEdges.map((e) => ({ source: e.source, target: e.target })),
          { direction: 'TB' }
        )
      : null;
  }, [builderNodes]);

  // If dagre had to place an all-zero flow, persist the generated
  // positions into editor state once. Otherwise the next drag would
  // save only the dragged node and every other node would fall back
  // to (0,0), which feels like nodes teleporting around the canvas.
  const persistedAutoLayoutRef = useRef(false);
  useEffect(() => {
    if (!autoLayoutPositions || persistedAutoLayoutRef.current) return;
    persistedAutoLayoutRef.current = true;
    updateNodePositions(
      Object.fromEntries(
        [...autoLayoutPositions].map(([key, pos]) => [key, pos])
      )
    );
  }, [autoLayoutPositions, updateNodePositions]);

  const derivedRfNodes = useMemo(() => {
    const nodes: RfNode<NodeData>[] = builderNodes.map((n) => {
      const fallback = autoLayoutPositions?.get(n.node_key);
      return {
        id: n.node_key,
        type: 'flow',
        position: {
          x: fallback?.x ?? n.position_x ?? 0,
          y: fallback?.y ?? n.position_y ?? 0,
        },
        data: {
          node: n,
          isEntry: n.node_key === entryNodeId,
          isFlashed: n.node_key === flashKey,
          stat: stats?.[n.node_key] ?? (stats ? { waiting: 0, passed: 0 } : null),
        },
      };
    });

    return nodes;
  }, [builderNodes, entryNodeId, flashKey, autoLayoutPositions, stats]);

  // The "When…" card sits to the left of the first step (or of the
  // left-most step when no entry is set). It is not saved or dragged.
  const whenPosition = useMemo(() => {
    const entry = derivedRfNodes.find((n) => n.id === entryNodeId);
    if (entry) return { x: entry.position.x - WHEN_GAP, y: entry.position.y };
    if (!derivedRfNodes.length) return { x: 0, y: 0 };
    const left = derivedRfNodes.reduce((a, b) => (b.position.x < a.position.x ? b : a));
    return { x: left.position.x - WHEN_GAP, y: left.position.y };
  }, [derivedRfNodes, entryNodeId]);

  const addTriggerBlocked = addTriggerBlock(channelScope, state.trigger_type, triggers.length - 1);
  const removeTriggerAt = useCallback((index: number) => {
    setState((s) => removeTrigger(s, index));
    setSelectedTrigger(null);
  }, [setState]);
  const allRfNodes = useMemo(() => {
    const when: RfNode<WhenData> = {
      id: WHEN_NODE_ID,
      type: 'when',
      position: whenPosition,
      draggable: false,
      deletable: false,
      data: {
        triggers,
        scope: channelScope,
        selected: selectedTrigger,
        locked,
        onSelect: openTrigger,
        onRemove: removeTriggerAt,
        onAdd: () => setPickingTrigger(true),
      },
    };
    const noteNodes: RfNode<NoteData>[] = notes.map((note) => ({
      id: noteNodeId(note.id),
      type: 'note',
      position: { x: note.x, y: note.y },
      data: {
        note,
        locked,
        onText: (text: string) => setState((s) => ({ ...s, canvas_notes: updateNote(readNotes(s.canvas_notes), note.id, { text }) })),
        onRemove: () => setState((s) => ({ ...s, canvas_notes: removeNote(readNotes(s.canvas_notes), note.id) }), { key: null }),
      },
    }));
    return [when, ...derivedRfNodes, ...noteNodes] as RfNode<NodeData>[];
  }, [whenPosition, triggers, channelScope, selectedTrigger, locked, openTrigger, removeTriggerAt, notes, derivedRfNodes, setState]);

  const [rfNodes, setRfNodes] = useState<RfNode<NodeData>[]>(allRfNodes);

  useEffect(() => {
    setRfNodes(allRfNodes);
  }, [allRfNodes]);

  const rfEdges = useMemo(() => {
    const canvasEdges = deriveCanvasEdges(builderNodes);

    // sourceHandle is now wired up — the FlowNodeCard renders a Handle
    // per slot whose id matches the scheme in edges.ts, so React-Flow
    // can hang the arrow off the right place on each card.
    const rfEdges: RfEdge[] = canvasEdges.map((e) => ({
      id: e.id,
      type: 'deletable',
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle,
      label: PORT_LABELS[e.sourceHandle] ? t(PORT_LABELS[e.sourceHandle]) : e.label,
      // Mode-aware via CSS tokens so edge chrome flips with light/dark.
      labelStyle: { fill: 'var(--muted-foreground)', fontSize: 11 },
      labelBgStyle: { fill: 'var(--card)' },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 4,
      style: { stroke: 'var(--border)', strokeWidth: 1.5 },
      markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--primary)', width: 16, height: 16 },
    }));

    // "Then": the When… card to the first step.
    if (entryNodeId && builderNodes.some((n) => n.node_key === entryNodeId)) {
      rfEdges.unshift({
        id: `${WHEN_NODE_ID}->${entryNodeId}`,
        type: 'deletable',
        source: WHEN_NODE_ID,
        sourceHandle: WHEN_HANDLE,
        target: entryNodeId,
        deletable: !entryIsLocked,
        style: { stroke: groupColors('start').solid, strokeWidth: 1.5 },
        markerEnd: { type: MarkerType.ArrowClosed, color: groupColors('start').solid, width: 16, height: 16 },
      });
    }

    return rfEdges;
  }, [builderNodes, t, entryNodeId, entryIsLocked]);

  const handleNodesChange = useCallback(
    (changes: NodeChange<RfNode<NodeData>>[]) => {
      setRfNodes((nodes) => applyNodeChanges(changes, nodes));
    },
    []
  );

  // Drag-to-position: React-Flow tracks the visual drag internally and
  // fires this once on release. We write the final coordinate back to
  // the editor context (which flips `dirty`); save then ships the new
  // positions in the existing PUT /api/flows/[id] body (the route
  // already destructures position_x / position_y per migration 010).
  // Writing only on dragStop (not on every position-change tick during
  // the drag) keeps state updates cheap on long drags.
  const handleNodeDragStop = useCallback<OnNodeDrag<RfNode<NodeData>>>(
    (_event, node) => {
      if (node.id === WHEN_NODE_ID) return;
      if (isNoteNodeId(node.id)) {
        const id = node.id.slice('note:'.length);
        setState((s) => ({ ...s, canvas_notes: updateNote(readNotes(s.canvas_notes), id, { x: Math.round(node.position.x), y: Math.round(node.position.y) }) }), { key: null });
        return;
      }
      updateNodePosition(node.id, node.position.x, node.position.y);
    },
    [updateNodePosition, setState]
  );

  // Pan to the flashed node when the validator panel requests one.
  // Animate over 400ms; landing zoom is whatever the user already has
  // (don't force a zoom reset — that would be jarring mid-edit).
  useEffect(() => {
    if (!flashKey) return;
    const node = builderNodes.find((n) => n.node_key === flashKey);
    if (!node) return;
    const x = (node.position_x ?? 0) + NODE_WIDTH / 2;
    const y = (node.position_y ?? 0) + NODE_HEIGHT / 2;
    reactFlow.setCenter(x, y, {
      zoom: reactFlow.getZoom(),
      duration: 400,
    });
  }, [flashKey, builderNodes, reactFlow]);

  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: RfNode<NodeData>) => {
      // The When… card's rows open their own trigger; a note edits in place.
      if (node.id === WHEN_NODE_ID || isNoteNodeId(node.id)) return;
      selectNode(node.id);
    },
    [selectNode]
  );

  // Drag-to-connect: React-Flow fires onConnect when the user drops a
  // handle drag onto a target handle. We look up the source node,
  // compute the right config patch via applyEdgeConnection (matches
  // the same slot scheme as deriveCanvasEdges), and dispatch via
  // updateNodeConfig. The resulting state change re-derives edges on
  // the next render — no need to maintain a separate edge list.
  const handleConnect = useCallback(
    (connection: Connection) => {
      if (locked) return;
      if (
        !connection.source ||
        !connection.target ||
        !connection.sourceHandle
      ) {
        return;
      }
      if (isNoteNodeId(connection.target) || connection.target === WHEN_NODE_ID) return;
      // "Then" on the When… card: the target becomes the first step.
      if (connection.source === WHEN_NODE_ID) {
        if (!entryIsLocked) setState((s) => ({ ...s, entry_node_id: connection.target }), { key: null });
        return;
      }
      const sourceNode = builderNodes.find(
        (n) => n.node_key === connection.source
      );
      if (!sourceNode) return;
      // Self-loops are a footgun (a button whose target is its own
      // node = infinite reprompt). Reject silently — the user can
      // still wire one via the per-node dropdown if they really want.
      if (connection.source === connection.target) return;
      // Only a step allowed before a private reply may lead into one (Instagram's one reply per comment).
      const target = builderNodes.find((n) => n.node_key === connection.target);
      if (target && !canRouteInto(sourceNode.node_type, target)) return;
      const patch = applyEdgeConnection(
        sourceNode,
        connection.sourceHandle,
        connection.target
      );
      if (patch) updateNodeConfig(connection.source, patch);
    },
    [locked, builderNodes, updateNodeConfig, entryIsLocked, setState]
  );

  // Keyboard delete (Backspace / Delete) + drag-to-trash. React-Flow
  // fires this with the set of deleted-node objects; we route each
  // through the editor context's removeNode (which now also unlinks
  // inbound references so no dangling arrows survive). Closing the
  // side panel on delete keeps the UI honest if the user deleted the
  // node currently being edited.
  const handleNodesDelete = useCallback(
    (deleted: RfNode<NodeData>[]) => {
      for (const n of deleted) {
        if (n.id === WHEN_NODE_ID) continue;
        if (isNoteNodeId(n.id)) {
          const id = n.id.slice('note:'.length);
          setState((s) => ({ ...s, canvas_notes: removeNote(readNotes(s.canvas_notes), id) }), { key: null });
          continue;
        }
        removeNode(n.id);
        if (selectedNodeKey === n.id) setSelectedNodeKey(null);
      }
    },
    [removeNode, selectedNodeKey, setState, setSelectedNodeKey]
  );

  // Edge delete: clear the source node's slot rather than removing
  // anything. Edges are derived from configs, so the only way to
  // "delete" one is to null out its underlying next_node_key.
  const clearSlot = useCallback(
    (source: string, sourceHandle: string) => {
      if (source === WHEN_NODE_ID) {
        if (!entryIsLocked) setState((s) => ({ ...s, entry_node_id: null }), { key: null });
        return;
      }
      const sourceNode = builderNodes.find((n) => n.node_key === source);
      if (!sourceNode) return;
      const patch = applyEdgeConnection(sourceNode, sourceHandle, '');
      if (patch) updateNodeConfig(source, patch);
    },
    [builderNodes, updateNodeConfig, entryIsLocked, setState]
  );

  const handleEdgesDelete = useCallback(
    (deleted: RfEdge[]) => {
      for (const e of deleted) {
        if (e.sourceHandle) clearSlot(e.source, e.sourceHandle);
      }
    },
    [clearSlot]
  );

  // Edge hover drives the × button. Clearing waits a beat so moving
  // the pointer from the edge onto the button doesn't hide it first.
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverEdge = useCallback((id: string | null) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    if (id) setHoveredEdgeId(id);
    else hoverTimer.current = setTimeout(() => setHoveredEdgeId(null), 150);
  }, []);
  useEffect(() => () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
  }, []);
  // A removed edge unmounts its × before onMouseLeave fires, so drop a
  // hover id whose edge is gone. Edge ids are deterministic; a stale id
  // would otherwise show the × on a later re-created edge unhovered.
  const [hoverEdgesSeen, setHoverEdgesSeen] = useState(rfEdges);
  if (hoverEdgesSeen !== rfEdges) {
    setHoverEdgesSeen(rfEdges);
    if (hoveredEdgeId && !rfEdges.some((e) => e.id === hoveredEdgeId)) setHoveredEdgeId(null);
  }
  const edgeActions = useMemo<EdgeActions>(
    () => ({ locked, hoveredId: hoveredEdgeId, hover: hoverEdge, clearSlot }),
    [locked, hoveredEdgeId, hoverEdge, clearSlot]
  );

  // Drop-to-create: a handle drag released on empty canvas opens a
  // step picker at the drop point. Picking creates the step there and
  // wires the dragged slot to it.
  const [dropPicker, setDropPicker] = useState<{
    x: number;
    y: number;
    flow: { x: number; y: number };
    source: string;
    handle: string;
  } | null>(null);

  const handleConnectEnd = useCallback<OnConnectEnd>(
    (event, connection) => {
      if (locked || connection.isValid || connection.toNode) return;
      const { fromNode, fromHandle } = connection;
      if (!fromNode || fromHandle?.type !== 'source' || !fromHandle.id) return;
      const point = 'changedTouches' in event ? event.changedTouches[0] : event;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!point || !rect) return;
      // Released on a card body (away from its handle): link to that
      // card instead of offering a new step. event.target can be where
      // the drag started, so look the card up from the pointer.
      const card = document.elementFromPoint(point.clientX, point.clientY)?.closest('.react-flow__node');
      if (card) {
        const target = card.getAttribute('data-id');
        if (!target || target === WHEN_NODE_ID || isNoteNodeId(target)) return;
        const targetNode = builderNodes.find((n) => n.node_key === target);
        // Start nodes take no inbound edges; handleConnect drops self-loops.
        if (target && targetNode && targetNode.node_type !== 'start') {
          handleConnect({ source: fromNode.id, sourceHandle: fromHandle.id, target, targetHandle: null });
        }
        return;
      }
      // Keep the picker inside the canvas when the drop is near an edge.
      setDropPicker({
        x: Math.max(8, Math.min(point.clientX - rect.left, rect.width - PICKER_WIDTH - 8)),
        y: Math.max(8, Math.min(point.clientY - rect.top, rect.height - PICKER_HEIGHT - 8)),
        flow: reactFlow.screenToFlowPosition({ x: point.clientX, y: point.clientY }),
        source: fromNode.id,
        handle: fromHandle.id,
      });
    },
    [locked, reactFlow, builderNodes, handleConnect]
  );

  const handleDropPick = useCallback(
    (type: NodeType) => {
      if (!dropPicker) return;
      const sourceNode = builderNodes.find((n) => n.node_key === dropPicker.source);
      const key = addNode(type);
      // The target handle sits on the card's left edge, so placing the
      // card's top-left at the drop point lands the arrow there.
      updateNodePosition(key, dropPicker.flow.x, dropPicker.flow.y - 24);
      if (dropPicker.source === WHEN_NODE_ID) {
        if (!entryIsLocked) setState((s) => ({ ...s, entry_node_id: key }), { key: null });
      } else if (sourceNode) {
        const patch = applyEdgeConnection(sourceNode, dropPicker.handle, key);
        if (patch) updateNodeConfig(sourceNode.node_key, patch);
      }
      setDropPicker(null);
      selectNode(key);
    },
    [dropPicker, builderNodes, addNode, updateNodePosition, updateNodeConfig, selectNode, entryIsLocked, setState]
  );

  // ---- Stage 5 add-step menu, notes and tools ----
  const viewportCenter = useCallback(() => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return reactFlow.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  }, [reactFlow]);
  const addStepAtCenter = useCallback((type: NodeType) => {
    const key = addNode(type);
    const center = viewportCenter();
    updateNodePosition(key, center.x - NODE_WIDTH / 2, center.y - NODE_HEIGHT / 2);
    setAddMenuOpen(false);
    selectNode(key);
  }, [addNode, viewportCenter, updateNodePosition, selectNode]);
  const addNoteAtCenter = useCallback(() => {
    const center = viewportCenter();
    setState((s) => ({ ...s, canvas_notes: addNote(readNotes(s.canvas_notes), center.x - 110, center.y - 40) }), { key: null });
    setAddMenuOpen(false);
  }, [viewportCenter, setState]);
  const arrange = useCallback(() => {
    const measured = new Map(reactFlow.getNodes().map(n => [n.id, n.measured]));
    const positions = autoLayout(builderNodes.map(n => ({ id: n.node_key, ...canvasNodeDimensions(n, measured.get(n.node_key)) })), deriveCanvasEdges(builderNodes), { direction: 'LR', rankSep: 100, nodeSep: 70 });
    // Arrange is an edit: one undo step puts every card back.
    updateNodePositions(Object.fromEntries(positions), { record: true });
    requestAnimationFrame(() => requestAnimationFrame(() => void reactFlow.fitView({ padding: 0.2, duration: 300 })));
  }, [reactFlow, builderNodes, updateNodePositions]);
  const triggerBlockedReason = addTriggerBlocked === 'onlyInstagram' ? tm('onlyInstagram')
    : addTriggerBlocked ? tm(addTriggerBlocked === 'limitReached' ? 'limitReached' : 'notCombinable', { max: MAX_TRIGGERS }) : null;
  const pickTrigger = useCallback((type: FlowTriggerType) => {
    setState((s) => addExtraTrigger(s, type), { key: null });
    openTrigger(triggers.length);
  }, [setState, openTrigger, triggers.length]);

  // Escape closes the side panel (a field's own Escape, a menu or a dialog wins).
  useEffect(() => {
    if (!selectedNodeKey && selectedTrigger === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if ((event.target as Element | null)?.closest?.('[role="dialog"],[role="listbox"],[role="menu"]')) return;
      setSelectedNodeKey(null);
      setSelectedTrigger(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedNodeKey, selectedTrigger, setSelectedNodeKey]);

  // Wrapped mutators that target the currently-selected node — pass to
  // the form so each keystroke goes through the editor context (which
  // flips `dirty` and feeds the validator).
  const onSelectedUpdateConfig = useCallback(
    (patch: Record<string, unknown>) => {
      if (selectedNodeKey) updateNodeConfig(selectedNodeKey, patch);
    },
    [selectedNodeKey, updateNodeConfig]
  );

  const handleDeleteSelected = useCallback(() => {
    if (!selectedNodeKey) return;
    removeNode(selectedNodeKey);
    setSelectedNodeKey(null);
  }, [selectedNodeKey, removeNode, setSelectedNodeKey]);

  const handleSetEntry = useCallback(() => {
    if (!selectedNodeKey) return;
    setState((s) => ({ ...s, entry_node_id: selectedNodeKey }));
  }, [selectedNodeKey, setState]);

  const panelOpen = !!selectedNode || selectedTrigger !== null;
  const tools = 'inline-flex size-9 items-center justify-center rounded-full border border-border bg-card text-foreground shadow-sm transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50';

  return (
    <div className="flow-studio-workspace h-full min-h-0">
      <div className="flex h-full min-h-0">
      {/* Left side panel: the selected step's or trigger's editor; otherwise the optional step library. */}
      {selectedNode ? (
        <NodeInspector
          node={selectedNode}
          isEntry={selectedNode.node_key === entryNodeId}
          allNodes={builderNodes}
          onClose={() => setSelectedNodeKey(null)}
          onUpdateConfig={onSelectedUpdateConfig}
          onDelete={locked ? undefined : handleDeleteSelected}
          onSetEntry={entryIsLocked ? undefined : handleSetEntry}
          readOnly={locked}
          t={t}
        />
      ) : selectedTrigger !== null && triggers[selectedTrigger] ? (
        // Keyed by trigger, so opening another trigger starts on its summary, not the last one's form.
        <TriggerInspector key={selectedTrigger} index={selectedTrigger} onClose={() => setSelectedTrigger(null)} onRemove={removeTriggerAt}
          triggerTypes={triggerTypes} readOnly={locked} />
      ) : libraryOpen ? (
        <CanvasBlockLibrary t={t} onAdded={selectNode} />
      ) : null}
      <div ref={containerRef} className="relative h-full min-w-0 flex-1 overflow-hidden" data-panel={panelOpen ? 'open' : 'closed'}>
        <EdgeActionsContext.Provider value={edgeActions}>
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
          proOptions={{ hideAttribution: true }}
          onNodesChange={handleNodesChange}
          onNodeDragStop={handleNodeDragStop}
          onNodeClick={handleNodeClick}
          // A click on empty canvas closes the side panel.
          onPaneClick={() => { setSelectedNodeKey(null); setSelectedTrigger(null); }}
          onConnect={handleConnect}
          onConnectEnd={handleConnectEnd}
          onNodesDelete={handleNodesDelete}
          onEdgesDelete={handleEdgesDelete}
          onEdgeMouseEnter={(_event, edge) => hoverEdge(edge.id)}
          onEdgeMouseLeave={() => hoverEdge(null)}
          // Default is "Backspace" only — accept both so Mac users
          // hitting Delete (Fn+Backspace) get the same behavior.
          // Locked: nothing is deletable, draggable or connectable.
          deleteKeyCode={locked ? null : ['Backspace', 'Delete']}
          nodesDraggable={!locked}
          nodesConnectable={!locked}
          edgesFocusable={!locked}
          elementsSelectable={!locked}
          // Lower default min/max zoom than the lib's defaults; the
          // tiles already truncate their summary at a reasonable
          // size, so we don't need to zoom past 1.5x.
          minZoom={0.2}
          maxZoom={1.5}
        >
          {/* Dot grid, matching the design's faint canvas backdrop. */}
          <Background
            variant={BackgroundVariant.Dots}
            gap={22}
            size={1.4}
            color="var(--border)"
          />
          <MiniMap
            style={{ width: 180, height: 110 }}
            pannable
            zoomable
            nodeColor={(n) => {
              const data = n.data as Partial<NodeData>;
              return data.node ? nodeColors(data.node.node_type).solid : n.type === 'note' ? groupColors('extras').solid : groupColors('start').solid;
            }}
            nodeStrokeWidth={0}
            nodeBorderRadius={3}
            maskColor="color-mix(in oklch, var(--background) 70%, transparent)"
            maskStrokeColor="var(--primary)"
            maskStrokeWidth={1.5}
            className="!border-border !bg-card !overflow-hidden !rounded-xl !border !shadow-sm"
          />
          <Panel position="top-left" className="!top-4 !left-4">
            <div className="flex items-center gap-2">
            <Button variant="outline" size="icon-sm" className="bg-card shadow-sm" onClick={() => setLibraryOpen(value => !value)} aria-label={t('studioToggleLibrary')} aria-expanded={libraryOpen}>
              {libraryOpen ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeftOpen className="h-4 w-4" />}
            </Button>
            <Button variant="outline" size="icon-sm" className="bg-card shadow-sm" onClick={() => setLocked(value => !value)} aria-pressed={locked} aria-label={locked ? t('unlockCanvas') : t('lockCanvas')} title={locked ? t('unlockCanvas') : t('lockCanvas')}>
              {locked ? <Lock className="h-4 w-4 text-primary" /> : <LockOpen className="h-4 w-4" />}
            </Button>
            {!panelOpen && <span className="rounded-full border border-border bg-card px-3 py-1 text-[11px] text-muted-foreground shadow-sm">{tc('tapToEdit')}</span>}
            </div>
          </Panel>
          {/* Right-edge tools: add step, arrange, zoom in, zoom out, fit. */}
          <Panel position="top-right" className="!top-4 !right-4">
            <div className="flex flex-col items-center gap-2" role="toolbar" aria-orientation="vertical" aria-label={tc('tools')}>
              <Popover open={addMenuOpen && !locked} onOpenChange={setAddMenuOpen}>
                <PopoverTrigger aria-label={tc('addStep')} title={tc('addStep')} disabled={locked} data-testid="add-step-button"
                  className="inline-flex size-11 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md transition-transform hover:scale-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-50">
                  <Plus className="size-5" />
                </PopoverTrigger>
                <PopoverContent side="left" align="start" className="flex max-h-[70vh] w-72 flex-col overflow-hidden p-0">
                  <AddStepList nodeTypes={nodeTypes} caps={caps} onPick={addStepAtCenter}
                    onTrigger={addTriggerBlocked ? undefined : () => { setAddMenuOpen(false); setPickingTrigger(true); }}
                    triggerBlockedReason={triggerBlockedReason}
                    onNote={notes.length < CANVAS_NOTE_LIMITS.notes ? addNoteAtCenter : undefined} />
                </PopoverContent>
              </Popover>
              <button type="button" className={tools} disabled={locked} onClick={arrange} aria-label={tc('arrange')} title={tc('arrange')}>
                <LayoutGrid className="size-4" />
              </button>
              <button type="button" className={tools} onClick={() => void reactFlow.zoomIn({ duration: 200 })} aria-label={tc('zoomIn')} title={tc('zoomIn')}>
                <ZoomIn className="size-4" />
              </button>
              <button type="button" className={tools} onClick={() => void reactFlow.zoomOut({ duration: 200 })} aria-label={tc('zoomOut')} title={tc('zoomOut')}>
                <ZoomOut className="size-4" />
              </button>
              <button type="button" className={tools} onClick={() => void reactFlow.fitView({ padding: 0.2, duration: 300 })} aria-label={tc('fit')} title={tc('fit')}>
                <Maximize className="size-4" />
              </button>
            </div>
          </Panel>
        </ReactFlow>
        </EdgeActionsContext.Provider>
        {dropPicker && !locked && (
          <DropStepPicker
            x={dropPicker.x}
            y={dropPicker.y}
            onPick={handleDropPick}
            onClose={() => setDropPicker(null)}
            t={t}
          />
        )}
        {builderNodes.length === 0 && <div className="pointer-events-none absolute inset-x-0 bottom-8 flex justify-center p-8 text-center text-sm text-muted-foreground">{t('studioEmpty')}</div>}
      </div>
      </div>
      <TriggerPickerDialog open={pickingTrigger} onOpenChange={setPickingTrigger} offered={triggerTypes} onPick={pickTrigger} />
    </div>
  );
}

// ============================================================
// Side panel — opens when a canvas node is clicked. Mounts the
// shared NodeConfigForm dispatcher so edits made here behave
// identically to the list view's per-card editor. Stage 5: it sits
// on the LEFT, with a header in the step group's colour.
// ============================================================

const SIDE_PANEL = 'flex w-[380px] max-w-[85vw] shrink-0 min-h-0 flex-col border-r border-border bg-card';

function NodeInspector({
  node,
  isEntry,
  allNodes,
  onClose,
  onUpdateConfig,
  onDelete,
  onSetEntry,
  readOnly,
  t,
}: {
  node: BuilderNode | null;
  isEntry: boolean;
  allNodes: BuilderNode[];
  onClose: () => void;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
  /** Omitted while the canvas is locked. */
  onDelete?: () => void;
  /** Absent while the entry is locked (a comment flow starts with its private reply). */
  onSetEntry?: () => void;
  /** Canvas locked: show the settings but block every edit. */
  readOnly: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  if (!node) return null;
  const g = groupColors(groupOf(node.node_type));
  return (
    <aside className={cn('flow-studio-inspector', SIDE_PANEL)} aria-label={t('studioInspector')} data-testid="step-panel">
        <div className="border-border flex items-center gap-3 border-b px-4 py-4" style={{ background: g.soft }}>
          <NodeIconChip type={node.node_type} size={36} iconSize={18} />
          <div className="min-w-0 flex-1">
            <h3 className="flex items-center gap-2 text-[11px] font-semibold tracking-wider uppercase">
              <span style={{ color: g.text }}>{t(`nodes.${node.node_type}.label`)}</span>
              {isEntry && (
                <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-semibold tracking-wider text-emerald-600 dark:text-emerald-300 uppercase">
                  {t('badgeEntry')}
                </span>
              )}
            </h3>
            <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
              {t(`nodes.${node.node_type}.blurb`)}
            </p>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t('studioClose')}><X className="h-4 w-4" /></Button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
          <code className="text-[10px] text-muted-foreground">{node.node_key}</code>
          {readOnly && <p className="text-muted-foreground flex items-center gap-1.5 text-xs"><Lock className="h-3.5 w-3.5" />{t('studioLockedHint')}</p>}
          {/* disabled stops native controls; inert also stops custom
              clickable rows, so a locked canvas can't be rewired here. */}
          <fieldset disabled={readOnly} inert={readOnly} className="m-0 min-w-0 border-0 p-0">
            <NodeConfigForm
              // Remount per node so per-form state (the delay unit) never carries across nodes.
              key={node.node_key}
              node={node}
              allNodes={allNodes}
              showAdvanced={false}
              onUpdateConfig={onUpdateConfig}
            />
          </fieldset>
        </div>

        <div className="border-border flex items-center justify-between gap-1 border-t px-3 py-3">
          {!isEntry && !readOnly && onSetEntry ? (
            <Button variant="ghost" size="sm" onClick={onSetEntry}>
              {t('setAsEntry')}
            </Button>
          ) : (
            <span />
          )}
          {onDelete && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onDelete}
              className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t('deleteNode')}
            </Button>
          )}
        </div>
    </aside>
  );
}

/**
 * The trigger editor in the left side panel: a summary of what starts the
 * flow with an Edit button that opens the trigger's settings (the existing
 * trigger forms). The first trigger may change type while it is the only
 * one; a further trigger (Instagram, combinable types only) can be removed.
 */
function TriggerInspector({ index, onClose, onRemove, triggerTypes, readOnly }: {
  index: number;
  onClose: () => void;
  onRemove: (index: number) => void;
  triggerTypes: FlowTriggerType[];
  readOnly: boolean;
}) {
  const t = useTranslations('Flows.builder');
  const tm = useTranslations('Flows.multiTrigger');
  const { state, setState, channelScope } = useFlowEditor();
  const shareToStoryOn = useShareToStoryEnabled();
  const [editing, setEditing] = useState(false);
  const triggers = stackTriggers(state);
  const trigger = triggers[index];
  if (!trigger) return null;
  const g = groupColors('start');
  const detail = triggerDetail(trigger);
  const canChangeType = index === 0 && triggers.length === 1 && !readOnly;
  return (
    <aside className={SIDE_PANEL} aria-label={t(TRIGGER_TITLE_KEYS[trigger.trigger_type])} data-testid="trigger-panel">
      <div className="border-border flex items-center gap-3 border-b px-4 py-4" style={{ background: g.soft }}>
        <span className="flex size-9 items-center justify-center rounded-lg bg-card" style={{ color: g.solid }}><Zap className="size-[18px]" /></span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: g.text }}>{index === 0 ? tm('primary') : tm('when')}</h3>
          <p className="mt-0.5 truncate text-sm font-medium text-foreground">{t(TRIGGER_TITLE_KEYS[trigger.trigger_type])}</p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t('studioClose')}><X className="h-4 w-4" /></Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
        {canChangeType && (
          <div>
            <label htmlFor="canvas-trigger-type" className="mb-1 block text-xs text-muted-foreground">{tm('triggerType')}</label>
            <Select value={trigger.trigger_type} onValueChange={(type) => setState((s) => applyTriggerType(s, type as FlowTriggerType), { key: null })}>
              <SelectTrigger id="canvas-trigger-type" className="bg-muted"><SelectValue>{t(TRIGGER_TITLE_KEYS[trigger.trigger_type])}</SelectValue></SelectTrigger>
              <SelectContent>
                {triggerTypes.map((type) => <SelectItem key={type} value={type}>{t(TRIGGER_TITLE_KEYS[type])}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        )}
        {editing ? (
          <fieldset disabled={readOnly} inert={readOnly} className="m-0 grid min-w-0 grid-cols-1 gap-3 border-0 p-0">
            <TriggerForm type={trigger.trigger_type} config={trigger.config} instagramOnly={channelScope === 'instagram'} shareToStoryOn={shareToStoryOn}
              onChange={(config) => setState((s) => setTriggerConfig(s, index, config))} />
          </fieldset>
        ) : (
          <div className="rounded-lg border border-border bg-background p-3">
            <p className="text-xs font-medium text-foreground">{t(TRIGGER_TITLE_KEYS[trigger.trigger_type])}</p>
            {detail && <p className="mt-1 break-words text-xs text-muted-foreground">{detail}</p>}
            <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => setEditing(true)} disabled={readOnly}>
              {tm('edit')}
            </Button>
          </div>
        )}
      </div>
      {triggers.length > 1 && !readOnly && (
        <div className="border-border flex justify-end border-t px-3 py-3">
          <Button variant="ghost" size="sm" onClick={() => onRemove(index)} className="text-red-400 hover:bg-red-500/10 hover:text-red-300">
            <Trash2 className="h-3.5 w-3.5" />{tm('removeTrigger')}
          </Button>
        </div>
      )}
    </aside>
  );
}

// ============================================================
// Floating add-node button — bottom-right of the canvas. Mirrors
// the list view's AddNodeButton (same dropdown menu, same NodeType
// list, same icons via NODE_META) but drops the new node into the
// center of the visible viewport rather than appending to a list.
// ============================================================


function CanvasBlockLibrary({ t, onAdded }: { t: ReturnType<typeof useTranslations>; onAdded: (key: string) => void }) {
  const reactFlow = useReactFlow();
  const { addNode, updateNodePosition, nodeTypes } = useFlowEditor();
  const caps = useWorkspaceCapabilities();
  const [query, setQuery] = useState('');
  // Only the steps the flow's channel runs (Stage 1).
  const matching = filterPaletteTypes(nodeTypes.map(type => ({ type, label: t(`nodes.${type}.label`), description: t(`nodes.${type}.blurb`) })), query);

  const handleAdd = (type: NodeType) => {
    const key = addNode(type);
    onAdded(key);
    // Place the new node at the visible canvas center. The Panel's
    // own DOM lives inside ReactFlow so we can climb up to find the
    // .react-flow root and read its bounding rect. If we can't find
    // it (test envs, etc.), addNode's default (0, 0) is the fallback
    // and the user can drag the node into view.
    const root = document.querySelector('.react-flow') as HTMLElement | null;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    const center = reactFlow.screenToFlowPosition({
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    });
    // NODE_WIDTH / NODE_HEIGHT are the dagre layout defaults; offset
    // so the card sits visually centered rather than top-left at the
    // viewport center.
    updateNodePosition(
      key,
      center.x - NODE_WIDTH / 2,
      center.y - NODE_HEIGHT / 2
    );
  };

  return (
    <aside className="flow-studio-library flex min-h-0 flex-col border-r border-border bg-card" aria-label={t('studioLibrary')}>
      <div className="border-b border-border px-4 py-4">
        <div className="mb-1 flex items-center gap-2 text-sm font-semibold"><LayoutGrid className="h-4 w-4 text-primary" />{t('studioLibrary')}</div>
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">{t('studioLibraryHelp')}</p>
        <div className="relative"><Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" /><Input aria-label={t('studioSearch')} placeholder={t('studioSearch')} value={query} onChange={event => setQuery(event.target.value)} className="h-9 pl-8 text-xs" /></div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {groupNodeTypesByCategory(matching.map(item => item.type)).map(group => (
          <section key={group.id} className="mb-5">
            <h3 className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{t(`categories.${group.id}`)}</h3>
            <div className="grid grid-cols-2 gap-2">{group.types.map(type => {
              const blocked = paletteBlock(type, caps);
              if (blocked) {
                // Provider not configured: the step could not be published, so it is not offered.
                return (
                  <div key={type} title={t(`capabilityBlocked.${blocked}`)} aria-disabled="true" data-blocked={blocked} className="flow-studio-block flex min-h-24 w-full flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-border px-2 py-3 text-center opacity-60">
                    <NodeIconChip type={type} size={30} iconSize={15} />
                    <span className="text-xs font-medium text-muted-foreground">{t(`nodes.${type}.label`)}</span>
                    <a href={CAPABILITY_SETUP_HREF[blocked]} className="text-[10px] font-medium text-primary hover:underline">{t('capabilitySetUp')}</a>
                  </div>
                );
              }
              return (
                <button key={type} type="button" title={t(`nodes.${type}.blurb`)} onClick={() => handleAdd(type)} className="flow-studio-block group flex min-h-24 w-full flex-col items-center justify-center gap-2 rounded-xl border border-border px-2 py-3 text-center transition-colors hover:bg-primary-soft focus-visible:outline-2 focus-visible:outline-primary">
                  <NodeIconChip type={type} size={30} iconSize={15} />
                  <span className="text-xs font-medium text-foreground">{t(`nodes.${type}.label`)}</span>
                </button>
              );
            })}</div>
          </section>
        ))}
        {matching.length === 0 && <p className="px-2 py-6 text-center text-xs text-muted-foreground">{t('studioNoResults')}</p>}
      </div>
    </aside>
  );
}

// ============================================================
// Drop-to-create picker — opens where a handle drag was released on
// empty canvas. Same search + categories as the block library.
// Escape or a click outside closes it.
// ============================================================

const PICKER_WIDTH = 260;
const PICKER_HEIGHT = 340;

function DropStepPicker({ x, y, onPick, onClose, t }: {
  x: number;
  y: number;
  onPick: (type: NodeType) => void;
  onClose: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const { nodeTypes } = useFlowEditor();
  const caps = useWorkspaceCapabilities();
  // Same grouped list as the "+" button. A step dropped here follows
  // another one, so the first-only private reply is never offered.
  return (
    <>
      <div className="absolute inset-0 z-10" onMouseDown={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-label={t('addStepHere')}
        onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}
        style={{ left: x, top: y, width: PICKER_WIDTH, maxHeight: PICKER_HEIGHT }}
        className="border-border bg-card absolute z-20 flex flex-col overflow-hidden rounded-xl border shadow-[0_14px_36px_-12px_rgba(0,0,0,0.45)]"
      >
        <p className="text-muted-foreground px-3 pt-2 text-[11px] font-semibold uppercase tracking-wider">{t('addStepHere')}</p>
        <AddStepList nodeTypes={nodeTypes} caps={caps} onPick={onPick} />
      </div>
    </>
  );
}
