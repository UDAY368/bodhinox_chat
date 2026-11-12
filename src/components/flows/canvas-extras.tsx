'use client';

/**
 * Stage 5 canvas pieces (owner amendment 1 and 3):
 *   - Step-group colours: Content, AI, Logic and Extras each have one header
 *     colour (start uses the trigger green).
 *   - The "When…" start card: the flow's triggers as rows, "+ New trigger"
 *     (Instagram flows) and a "Then" port that connects to the first step.
 *   - Canvas notes: free text, no ports, never run (flows.canvas_notes).
 *   - The grouped add-step list behind the round "+" button and the
 *     drop-on-empty-canvas picker: Starting step, Content, AI, Logic, Extras.
 *   - Waiting / Passed counts per step from GET /api/flows/[id]/node-stats.
 *
 * Colours, icons, components and wording are Bodhinox's own.
 */

import { createContext, useContext, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { ChevronDown, Search, StickyNote, Trash2, Zap } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';
import { authFetch } from '@/lib/auth/client';
import { Input } from '@/components/ui/input';
import { CANVAS_NOTE_LIMITS, type CanvasNote, type FlowChannelScope } from '@/lib/flows/types';
import type { WorkspaceCapabilities } from '@/lib/flows/node-registry';
import { CAPABILITY_SETUP_HREF, filterPaletteTypes, paletteBlock } from './palette';
import { NodeIconChip, STEP_GROUP, type NodeType, type StepGroup } from './shared';
import { TriggerStackRows, type StackTrigger } from './triggers/trigger-stack';

// ------------------------------------------------------------ next-step menu

/**
 * Clicking a step's output (or the "When…" card's Then port) opens the
 * next-step menu at the pointer; the canvas provides the opener.
 */
export type OpenNextStep = (source: string, handle: string, clientX: number, clientY: number) => void;
export const NextStepContext = createContext<OpenNextStep | null>(null);

/** Props for an output Handle: a click opens the next-step menu (a drag still connects). */
export function useOutputClick(source: string, handle: string, enabled: boolean) {
  const open = useContext(NextStepContext);
  if (!open || !enabled) return {};
  return {
    onClick: (event: React.MouseEvent) => {
      event.stopPropagation();
      open(source, handle, event.clientX, event.clientY);
    },
  };
}

// ------------------------------------------------------------ group colours

/** The add-step menu's groups: the four step groups plus Extras (notes). */
export type CanvasGroup = StepGroup | 'extras';
export const CANVAS_GROUPS: CanvasGroup[] = ['start', 'content', 'ai', 'logic', 'extras'];

const GROUP_HUE: Record<CanvasGroup, { l: number; c: number; h: number }> = {
  start: { l: 0.62, c: 0.13, h: 162 }, // green: where the flow begins
  content: { l: 0.62, c: 0.17, h: 352 }, // rose: what the contact sees
  ai: { l: 0.6, c: 0.17, h: 295 }, // violet: the AI step
  logic: { l: 0.74, c: 0.15, h: 80 }, // amber: decisions and actions
  extras: { l: 0.7, c: 0.15, h: 50 }, // orange: notes
};

/** One token colour per group, with soft and readable-text variants for both themes. */
export function groupColors(group: CanvasGroup): { solid: string; soft: string; text: string } {
  const g = GROUP_HUE[group];
  const solid = `oklch(${g.l} ${g.c} ${g.h})`;
  return { solid, soft: `oklch(${g.l} ${g.c} ${g.h} / 0.16)`, text: `color-mix(in oklch, ${solid}, var(--foreground) 35%)` };
}

export const groupOf = (type: NodeType): CanvasGroup => STEP_GROUP[type];

// ------------------------------------------------------------ add-step list

/**
 * The step types the "+" menu offers, grouped. The private reply is not
 * listed: on a comment flow the message step's send mode picks it. Google
 * Sheets shows only with the `sheets` capability.
 */
export function addStepGroups(
  nodeTypes: readonly NodeType[],
  caps: WorkspaceCapabilities | null,
  opts: { query?: string; label?: (type: NodeType) => string } = {},
): Array<{ group: CanvasGroup; types: NodeType[] }> {
  const offered = nodeTypes.filter((type) => type !== 'ig_private_reply' && type !== 'start' && (type !== 'google_sheets' || !!caps?.sheets));
  const label = opts.label ?? ((type: NodeType) => type);
  const matching = opts.query
    ? filterPaletteTypes(offered.map((type) => ({ type, label: label(type), description: '' })), opts.query).map((m) => m.type)
    : offered;
  return (['content', 'ai', 'logic'] as const)
    .map((group) => ({ group: group as CanvasGroup, types: matching.filter((type) => groupOf(type) === group) }))
    .filter((g) => g.types.length > 0);
}

/**
 * The grouped list: Starting step (a trigger), Content, AI, Logic, Extras
 * (note). `onTrigger` is absent when no trigger can be added (the entry is
 * shown, disabled, with the reason). `tiles` (the round + menu) lays each
 * group out as two columns of dashed tiles under a heading that folds the
 * group open and closed: one group at a time, Content first, every group
 * with a match while searching. A step whose provider is not set up shows
 * a "Set up" link there. `list` (the next-step menu) keeps one compact row
 * per step with every group open.
 */
export function AddStepList({ nodeTypes, caps, onPick, onTrigger, triggerBlockedReason, onNote, autoFocus = true, variant = 'list' }: {
  nodeTypes: readonly NodeType[];
  caps: WorkspaceCapabilities | null;
  onPick: (type: NodeType) => void;
  onTrigger?: () => void;
  triggerBlockedReason?: string | null;
  onNote?: () => void;
  autoFocus?: boolean;
  variant?: 'list' | 'tiles';
}) {
  const t = useTranslations('Flows.builder');
  const tc = useTranslations('Flows.canvas');
  const tm = useTranslations('Flows.multiTrigger');
  const [query, setQuery] = useState('');
  const [openGroup, setOpenGroup] = useState<CanvasGroup | null>('content');
  const baseId = useId();
  const groups = addStepGroups(nodeTypes, caps, { query, label: (type) => t(`nodes.${type}.label`) });
  const q = query.trim().toLocaleLowerCase();
  const showTrigger = (onTrigger || triggerBlockedReason) && (!q || tm('addTrigger').toLocaleLowerCase().includes(q));
  const showNote = onNote && (!q || tc('addNote').toLocaleLowerCase().includes(q));
  const tiles = variant === 'tiles';
  const item = tiles
    ? 'flex min-h-[52px] w-full items-center gap-2.5 rounded-xl border border-dashed border-border bg-card px-3 py-2 text-left text-[13px] font-medium text-foreground transition-colors hover:border-solid hover:border-primary/40 hover:bg-primary-soft focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent'
    : 'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs font-medium text-foreground transition-colors hover:bg-primary-soft focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent';
  const chip = tiles ? 28 : 22;
  const grid = tiles ? 'grid grid-cols-2 gap-2' : undefined;

  const section = (group: CanvasGroup, count: number, body: ReactNode) => {
    if (!tiles) {
      return (
        <section key={group} className="mb-1.5">
          <h3 className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            <span className="size-2 rounded-full" style={{ background: groupColors(group).solid }} aria-hidden />
            {tc(`groups.${group}`)}
          </h3>
          {body}
        </section>
      );
    }
    // Searching shows every group that has a match; otherwise one group is open at a time.
    const open = q.length > 0 || openGroup === group;
    const panelId = `${baseId}-${group}`;
    return (
      <section key={group} className="border-border/70 border-b last:border-b-0" data-group={group} data-open={open || undefined}>
        <h3>
          <button type="button" aria-expanded={open} aria-controls={panelId} disabled={q.length > 0}
            onClick={(event) => {
              const opening = openGroup !== group;
              setOpenGroup(opening ? group : null);
              // Once it has unfolded, bring the opened group's tiles into view (no motion when the user asked for less).
              const sectionEl = event.currentTarget.closest('section');
              if (opening && sectionEl) window.setTimeout(() => sectionEl.scrollIntoView({ block: 'nearest',
                behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }), 300);
            }}
            className="group flex w-full items-center gap-2 rounded-lg px-1 py-3 text-left text-sm font-semibold text-foreground transition-colors hover:text-primary focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-default disabled:hover:text-foreground">
            <span className="size-2 rounded-full transition-transform duration-300 group-hover:scale-125" style={{ background: groupColors(group).solid }} aria-hidden />
            <span className="flex-1">{tc(`groups.${group}`)}</span>
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground" aria-hidden>{count}</span>
            <ChevronDown aria-hidden className={cn('size-4 text-muted-foreground transition-transform duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)]', !open && '-rotate-90')} />
          </button>
        </h3>
        {/* Height animates through grid rows (0fr ↔ 1fr); the tiles fade and settle into place. A closed group is inert. */}
        <div id={panelId} role="region" aria-label={tc(`groups.${group}`)} inert={!open}
          className={cn('grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)]', open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
          <div className="min-h-0 overflow-hidden">
            <div className={cn('pb-3 transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)]', open ? 'translate-y-0 opacity-100' : '-translate-y-1.5 opacity-0')}>
              {body}
            </div>
          </div>
        </div>
      </section>
    );
  };

  return (
    <div className="flex min-h-0 flex-col">
      <div className="border-border border-b p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input autoFocus={autoFocus} aria-label={t('studioSearch')} placeholder={t('studioSearch')} value={query}
            onChange={(event) => setQuery(event.target.value)} className="h-9 pl-8 text-xs" />
        </div>
      </div>
      <div className={cn('min-h-0 flex-1 overflow-y-auto', tiles ? 'px-3 pb-1' : 'p-1.5')} data-testid="add-step-list" data-variant={variant}>
        {showTrigger && section('start', 1, (
          <div className={grid}>
            <button type="button" className={item} disabled={!onTrigger} title={triggerBlockedReason ?? undefined} onClick={onTrigger}>
              <span className="flex shrink-0 items-center justify-center rounded-lg" style={{ width: chip, height: chip, background: groupColors('start').soft, color: groupColors('start').solid }}>
                <Zap size={tiles ? 15 : 12} />
              </span>
              {tm('addTrigger')}
            </button>
          </div>
        ))}
        {groups.map((g) => section(g.group, g.types.length, (
          <div className={grid}>
            {g.types.map((type) => {
              const blocked = paletteBlock(type, caps);
              if (blocked && tiles) {
                // Its provider is not set up, so it could not be published: say where to set it up instead.
                return (
                  <div key={type} data-step-type={type} data-blocked={blocked} aria-disabled="true" title={t(`capabilityBlocked.${blocked}`)}
                    className="flex min-h-[52px] w-full items-center gap-2.5 rounded-xl border border-dashed border-border px-3 py-2 text-[13px] font-medium">
                    <span className="opacity-50"><NodeIconChip type={type} size={chip} iconSize={15} /></span>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-muted-foreground">{t(`nodes.${type}.label`)}</span>
                      <a href={CAPABILITY_SETUP_HREF[blocked]} className="text-[11px] font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-primary">{t('capabilitySetUp')}</a>
                    </span>
                  </div>
                );
              }
              return (
                <button key={type} type="button" disabled={!!blocked} data-step-type={type}
                  title={blocked ? t(`capabilityBlocked.${blocked}`) : t(`nodes.${type}.blurb`)} onClick={() => onPick(type)} className={item}>
                  <NodeIconChip type={type} size={chip} iconSize={tiles ? 15 : 12} />
                  <span className="min-w-0 truncate">{t(`nodes.${type}.label`)}</span>
                </button>
              );
            })}
          </div>
        )))}
        {showNote && section('extras', 1, (
          <div className={grid}>
            <button type="button" className={item} onClick={onNote}>
              <span className="flex shrink-0 items-center justify-center rounded-lg" style={{ width: chip, height: chip, background: groupColors('extras').soft, color: groupColors('extras').solid }}>
                <StickyNote size={tiles ? 15 : 12} />
              </span>
              {tc('addNote')}
            </button>
          </div>
        ))}
        {!groups.length && !showTrigger && !showNote && <p className="px-2 py-4 text-center text-xs text-muted-foreground">{t('studioNoResults')}</p>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ "When…" start card

export const WHEN_NODE_ID = '__when__';
export const WHEN_HANDLE = 'then';

export interface WhenData extends Record<string, unknown> {
  triggers: StackTrigger[];
  scope: FlowChannelScope;
  selected: number | null;
  locked: boolean;
  onSelect: (index: number) => void;
  onRemove: (index: number) => void;
  onAdd: () => void;
}

export function WhenCard({ data, isConnectable }: NodeProps) {
  const thenClick = useOutputClick(WHEN_NODE_ID, WHEN_HANDLE, !!isConnectable);
  const tm = useTranslations('Flows.multiTrigger');
  const d = data as WhenData;
  const c = groupColors('start');
  return (
    <div className="flow-studio-card bg-card relative w-[260px] rounded-2xl border border-border text-left shadow-sm" data-testid="when-card">
      {/* No overflow-hidden: it clipped half of the Then handle, which sits on the right edge. */}
      <div className="flex items-center gap-2 rounded-t-2xl px-4 py-2.5" style={{ background: c.soft }}>
        <Zap className="size-4" style={{ color: c.solid }} />
        <span className="text-sm font-semibold" style={{ color: c.text }}>{tm('when')}</span>
      </div>
      <div className="px-3 py-3">
        <TriggerStackRows triggers={d.triggers} selected={d.selected} scope={d.scope} onSelect={d.onSelect}
          onRemove={d.locked ? undefined : d.onRemove} onAdd={d.onAdd} />
      </div>
      <div className="border-border relative flex items-center justify-end gap-2 border-t px-4 py-2 text-[11px] font-medium text-muted-foreground">
        {tm('then')}
        <Handle type="source" id={WHEN_HANDLE} position={Position.Right} isConnectable={isConnectable} {...thenClick}
          style={{ borderColor: c.solid }} className="!bg-card !h-2.5 !w-2.5 !border-2" />
      </div>
    </div>
  );
}

// ------------------------------------------------------------ canvas notes

export const NOTE_PREFIX = 'note:';
export const noteNodeId = (id: string) => `${NOTE_PREFIX}${id}`;
export const isNoteNodeId = (id: string) => id.startsWith(NOTE_PREFIX);

export function readNotes(value: unknown): CanvasNote[] {
  return (Array.isArray(value) ? value : []).filter((n): n is CanvasNote => {
    const v = n as CanvasNote | null;
    return !!v && typeof v === 'object' && typeof v.id === 'string' && typeof v.text === 'string' && Number.isFinite(v.x) && Number.isFinite(v.y);
  });
}

/** A note id unique among `notes`. */
export function newNoteId(notes: readonly CanvasNote[]): string {
  let id = '';
  do id = `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  while (notes.some((n) => n.id === id));
  return id;
}

export function addNote(notes: readonly CanvasNote[], x: number, y: number, text = ''): CanvasNote[] {
  if (notes.length >= CANVAS_NOTE_LIMITS.notes) return [...notes];
  return [...notes, { id: newNoteId(notes), text, x: Math.round(x), y: Math.round(y) }];
}

export const updateNote = (notes: readonly CanvasNote[], id: string, patch: Partial<Omit<CanvasNote, 'id'>>): CanvasNote[] =>
  notes.map((n) => (n.id === id ? { ...n, ...patch, ...(patch.text !== undefined ? { text: patch.text.slice(0, CANVAS_NOTE_LIMITS.chars) } : {}) } : n));

export const removeNote = (notes: readonly CanvasNote[], id: string): CanvasNote[] => notes.filter((n) => n.id !== id);

export interface NoteData extends Record<string, unknown> {
  note: CanvasNote;
  locked: boolean;
  onText: (text: string) => void;
  onRemove: () => void;
}

export function NoteCard({ data, selected }: NodeProps) {
  const tc = useTranslations('Flows.canvas');
  const d = data as NoteData;
  const c = groupColors('extras');
  return (
    <div className={cn('relative w-[220px] rounded-xl border text-left shadow-sm', selected ? 'border-[var(--note)]' : 'border-border')}
      style={{ '--note': c.solid, background: `color-mix(in oklch, var(--card), ${c.solid} 10%)` } as React.CSSProperties} data-testid="canvas-note">
      <div className="flex items-center gap-1.5 px-3 pt-2 text-[10px] font-semibold uppercase tracking-wider" style={{ color: c.text }}>
        <StickyNote className="size-3" />{tc('addNote')}
        {!d.locked && (
          <button type="button" aria-label={tc('deleteNote')} title={tc('deleteNote')} onClick={d.onRemove}
            className="nodrag ml-auto rounded p-0.5 text-muted-foreground hover:text-red-400 focus-visible:outline-2 focus-visible:outline-primary">
            <Trash2 className="size-3" />
          </button>
        )}
      </div>
      <textarea
        value={d.note.text}
        readOnly={d.locked}
        maxLength={CANVAS_NOTE_LIMITS.chars}
        placeholder={tc('noteNew')}
        aria-label={tc('addNote')}
        onChange={(e) => d.onText(e.target.value)}
        rows={Math.min(8, Math.max(2, d.note.text.split('\n').length))}
        className="nodrag nowheel block w-full resize-none bg-transparent px-3 pb-2.5 pt-1 text-xs leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}

// ------------------------------------------------------------ node stats

export interface NodeStat { waiting: number; passed: number }

/**
 * Reads GET /api/flows/[id]/node-stats: `{ nodes: { [node_key]: { waiting, passed } } }`
 * or `{ nodes: [{ node_key, waiting, passed }] }`. Anything else is no data.
 */
export function parseNodeStats(json: unknown): Record<string, NodeStat> {
  const body = json && typeof json === 'object' ? (json as Record<string, unknown>) : {};
  const raw = body.nodes ?? body.stats;
  const out: Record<string, NodeStat> = {};
  const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0);
  if (Array.isArray(raw)) {
    for (const row of raw) {
      const r = row as Record<string, unknown> | null;
      if (r && typeof r.node_key === 'string') out[r.node_key] = { waiting: count(r.waiting), passed: count(r.passed) };
    }
  } else if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const r = value as Record<string, unknown> | null;
      if (r && typeof r === 'object') out[key] = { waiting: count(r.waiting), passed: count(r.passed) };
    }
  }
  return out;
}

/** Per-step counts for the flow's smart delays (loaded once; null until loaded or when unavailable). */
export function useNodeStats(flowId: string, enabled: boolean): Record<string, NodeStat> | null {
  const [stats, setStats] = useState<Record<string, NodeStat> | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    authFetch(`/api/flows/${encodeURIComponent(flowId)}/node-stats`, { cache: 'no-store' })
      .then(async (res) => (res.ok ? parseNodeStats(await res.json()) : null))
      .catch(() => null)
      .then((result) => { if (!cancelled) setStats(result); });
    return () => { cancelled = true; };
  }, [flowId, enabled]);
  return stats;
}

/** Waiting · Passed under a step that holds contacts. */
export function NodeStatsLine({ stat }: { stat: NodeStat | undefined | null }) {
  const t = useTranslations('Flows.nodeStats');
  if (!stat) return null;
  return (
    <div className="mt-2 flex gap-3 text-[10.5px] text-muted-foreground" data-testid="node-stats">
      <span>{t('waiting')} <strong className="font-semibold text-foreground">{stat.waiting}</strong></span>
      <span>{t('passed')} <strong className="font-semibold text-foreground">{stat.passed}</strong></span>
    </div>
  );
}

/** Steps whose cards show Waiting / Passed. */
export const STATS_STEPS = new Set<NodeType>(['smart_delay']);

/** Whether any of the flow's steps shows counts (so the request is only made when useful). */
export function useHasStatsSteps(types: readonly NodeType[]): boolean {
  return useMemo(() => types.some((type) => STATS_STEPS.has(type)), [types]);
}
