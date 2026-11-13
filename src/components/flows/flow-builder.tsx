'use client';

/**
 * The Simple builder: the flow as three columns.
 *
 *   - Left: "When…" (the triggers), the steps a customer can reach in the
 *     order they are reached, then the steps nothing leads to, and
 *     "+ Add step". Each step row deletes from its hover tool.
 *   - Middle: the selected trigger's or step's settings (the same forms
 *     as the canvas side panel).
 *   - Right (wide screens): the selected step in a phone, run through the
 *     local preview engine from that step. Nothing is sent.
 *
 * Narrow screens stack the list above the editor. Header and validation
 * panel live once in FlowEditorShell so they show in both views.
 *
 * State lives in the shared `useFlowEditor()` context — toggling
 * Canvas ⇄ Simple never loses edits. Only the selection is local; a
 * validator jump (flashKey) selects its step.
 */

import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { paletteBlock, useWorkspaceCapabilities } from './palette';
import {
  ArrowDown,
  ArrowUp,
  CircleAlert,
  Copy,
  Plus,
  Trash2,
  ChevronDown,
  ChevronUp,
  CornerDownRight,
  Zap,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { authFetch } from '@/lib/auth/client';
import { channelPath } from '@/lib/channels/routes';
import type { ValidationIssue } from '@/lib/flows/validate';
import { CREATABLE_CHANNEL_SCOPES, type FlowChannelScope } from '@/lib/flows/types';
import type { Channel } from '@/types';
import {
  NODE_META,
  NodeIconChip,
  groupNodeTypesByCategory,
  nodeColors,
  slugify,
  summarizeNode,
  type BuilderNode,
  type NodeType,
} from './shared';
import { NodeConfigForm } from './forms/node-config-form';
import { TRIGGER_TITLE_KEYS, TriggerForm } from './triggers/trigger-form';
import { addExtraTrigger, addTriggerBlock, MAX_TRIGGERS, removeTrigger, setTriggerConfig, stackTriggers, TriggerPickerDialog } from './triggers/trigger-stack';
import { useShareToStoryEnabled } from './triggers/ig-post-picker';
import { applyTriggerType } from './triggers/ig-trigger-config';
import { entryLocked } from './nodes/ig-node-config';
import { NodeKeySelect } from './forms/fields';
import { IssueLine } from './validation-panel';
import { commentTriggerOf, uniqueNodeKey, useFlowEditor, type BuilderState } from './flow-editor-state';
import { VersionBar } from './version-bar';
import { splitFlow } from './split-flow';
import { DryRunPanel } from './dry-run-panel';
import { duplicateStep, groupSteps, moveStepDown, moveStepUp, stepMoves } from './basic-steps';
import { PhoneBubble } from './flow-preview';
import { PhoneFrame } from './phone-frame';
import { useAuth } from '@/hooks/use-auth';
import { startPreview } from '@/lib/flows/preview';

// ============================================================
// Local state shape — mirrors the DB but the configs are typed
// loosely (Record<string, unknown>) since each node_type carries a
// different shape. The sub-form components narrow as needed.
// ============================================================

// ============================================================
// Root component
// ============================================================

export function FlowBuilder() {
  const t = useTranslations('Flows.builder');
  const {
    flow,
    state,
    setState,
    issues,
    channelScope,
    setChannelScope,
    dirty,
    section,
    nodeTypes,
    triggerTypes,
    flashKey,
    flashSeq,
    addNode: addNodeCtx,
    updateNode,
    updateNodeConfig,
    removeNode: removeNodeCtx,
  } = useFlowEditor();

  const tb = useTranslations('Flows.builder.basic');

  // What the middle column edits: the trigger ("When…") or one step.
  // A validator jump (flashKey) selects its step; a deleted step falls
  // back to the trigger.
  const [picked, setPicked] = useState<string | null>(null);
  const [seenFlash, setSeenFlash] = useState(flashSeq);
  if (flashSeq !== seenFlash) {
    setSeenFlash(flashSeq);
    if (flashKey) setPicked(flashKey);
  }
  const selected = picked ? state.nodes.find((n) => n.node_key === picked) ?? null : null;

  // The first step added to a flow with no first step becomes it, so it lists under "Steps".
  const addNode = useCallback((type: NodeType) => setPicked(addNodeCtx(type, { asEntry: true })), [addNodeCtx]);
  const removeNode = useCallback((key: string) => {
    removeNodeCtx(key);
    setPicked((current) => (current === key ? null : current));
  }, [removeNodeCtx]);

  // A new selection starts at the top of its settings: the editor column
  // scrolls by itself when the columns sit side by side; stacked (narrow),
  // the page scrolls down to it instead. Not on first render.
  const editorRef = useRef<HTMLDivElement>(null);
  const firstRender = useRef(true);
  useEffect(() => {
    const el = editorRef.current;
    if (firstRender.current || !el) { firstRender.current = false; return; }
    if (getComputedStyle(el).overflowY === 'auto') el.scrollTo?.({ top: 0 });
    else el.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }, [picked, flashSeq]);

  const { connected, unconnected } = useMemo(() => groupSteps(state.nodes, state.entry_node_id), [state.nodes, state.entry_node_id]);
  const entryIsLocked = entryLocked(commentTriggerOf(state), state.nodes, state.entry_node_id);
  const nodeIssues = (key: string) => issues.filter((i) => i.scope === 'node' && i.node_key === key);
  const triggerIssues = issues.filter((i) => i.scope === 'trigger');
  const row = (node: BuilderNode, index?: number) => (
    <StepRow key={node.node_key} node={node} index={index} active={picked === node.node_key} isEntry={state.entry_node_id === node.node_key}
      hasError={nodeIssues(node.node_key).some((i) => i.severity === 'error')}
      onSelect={() => setPicked(node.node_key)} onRemove={() => removeNode(node.node_key)} t={t} />
  );
  // Move up / down swap a step with its neighbour in a straight line; Duplicate copies it right after itself.
  const moves = selected ? stepMoves(state, selected.node_key) : { up: false, down: false };
  const move = (key: string, direction: 'up' | 'down') => setState((s) => {
    const moved = direction === 'up' ? moveStepUp(s, key) : moveStepDown(s, key);
    return moved ? { ...s, ...moved } : s;
  }, { key: null });
  const duplicate = (key: string) => {
    const copyKey = uniqueNodeKey(key, state.nodes);
    if (!duplicateStep(state, key, copyKey)) return;
    setState((s) => {
      const copied = duplicateStep(s, key, copyKey);
      return copied ? { ...s, ...copied } : s;
    }, { key: null });
    setPicked(copyKey);
    toast.success(tb('stepDuplicated'));
  };
  const position = selected ? connected.indexOf(selected) : -1;

  return (
    // Sized by its own width (the shell's Preview panel can sit beside it), not the window's.
    <div className="@container h-full">
    <div className="flex min-h-full flex-col @3xl:h-full @3xl:flex-row" data-testid="basic-builder">
      {/* Left: the steps, as the customer meets them. */}
      <nav aria-label={tb('stepsNav')} className="border-border bg-card flex shrink-0 flex-col gap-4 border-b p-4 @3xl:w-80 @3xl:overflow-y-auto @3xl:border-r @3xl:border-b-0">
        <StepGroup title={tb('whenCaption')}>
          <button type="button" onClick={() => setPicked(null)} aria-current={selected ? undefined : 'true'}
            className={cn(STEP_ROW, 'w-full text-left', !selected && STEP_ROW_ACTIVE)}>
            <span className="bg-primary-soft text-primary flex h-7 w-7 shrink-0 items-center justify-center rounded-md"><Zap className="h-3.5 w-3.5" /></span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{tb('when')}</span>
              <span className="text-muted-foreground block truncate text-xs">{t(TRIGGER_TITLE_KEYS[state.trigger_type])}</span>
            </span>
            {triggerIssues.some((i) => i.severity === 'error') && <CircleAlert className="h-3.5 w-3.5 shrink-0 text-red-400" aria-label={tb('hasErrors')} />}
          </button>
        </StepGroup>
        <StepGroup title={tb('thenCaption', { count: connected.length })}>
          {connected.length ? connected.map((node, i) => row(node, i + 1)) : <p className="text-muted-foreground px-1 text-xs">{tb('connectedEmpty')}</p>}
        </StepGroup>
        {unconnected.length > 0 && (
          <StepGroup title={tb('unconnected', { count: unconnected.length })} hint={tb('unconnectedHint')}>
            {unconnected.map((node) => row(node))}
          </StepGroup>
        )}
        <AddNodeButton types={nodeTypes} onAdd={addNode} t={t} />
      </nav>

      {/* Middle: the selected trigger's or step's settings. */}
      <div ref={editorRef} className="min-w-0 flex-1 scroll-mt-2 @3xl:overflow-y-auto">
        <div className="mx-auto flex max-w-2xl flex-col gap-5 px-5 py-6">
          {selected ? (
            <StepEditor
              // By position, not key: renaming the key keeps the form (and its open sections).
              key={state.nodes.indexOf(selected)}
              node={selected}
              allNodes={state.nodes}
              isEntry={state.entry_node_id === selected.node_key}
              isFlashed={flashKey === selected.node_key}
              issues={nodeIssues(selected.node_key)}
              onUpdate={(patch) => {
                // A key another step already has would make two steps one; keep the old key.
                if (patch.node_key && patch.node_key !== selected.node_key && state.nodes.some((n) => n.node_key === patch.node_key)) return;
                updateNode(selected.node_key, patch);
                // Renaming the key keeps the step selected.
                if (patch.node_key) setPicked(patch.node_key);
              }}
              onUpdateConfig={(patch) => updateNodeConfig(selected.node_key, patch)}
              onRemove={() => removeNode(selected.node_key)}
              onSetEntry={entryIsLocked ? undefined : () => setState((s) => ({ ...s, entry_node_id: selected.node_key }))}
              position={position >= 0 ? { index: position + 1, total: connected.length } : null}
              canMoveUp={moves.up}
              canMoveDown={moves.down}
              onMoveUp={() => move(selected.node_key, 'up')}
              onMoveDown={() => move(selected.node_key, 'down')}
              onDuplicate={selected.node_type === 'start' || selected.node_type === 'ig_private_reply' ? undefined : () => duplicate(selected.node_key)}
              t={t}
            />
          ) : (
            <>
              <ChannelScopePanel flowId={flow.id} scope={channelScope} published={!!flow.published_version_id}
                dirty={dirty} section={section} onSaved={setChannelScope} />
              <TriggerPanel state={state} setState={setState} triggerTypes={triggerTypes} triggerIssues={triggerIssues}
                instagramOnly={channelScope === 'instagram'} t={t} />
              <EntryPicker state={state} setState={setState} t={t} />
              {state.nodes.length === 0 && (
                <div className="border-border bg-card/50 text-muted-foreground rounded-lg border border-dashed p-8 text-center text-sm">
                  {t.rich('nodesEmpty', { strong: (chunks) => <strong>{chunks}</strong> })}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Right: the selected step as the customer sees it (wide screens). */}
      <StepPhone node={selected} nodes={state.nodes} instagram={channelScope === 'instagram'} />
    </div>
    </div>
  );
}

const STEP_ROW = 'flex items-center gap-2.5 rounded-lg border border-transparent px-2 py-2 transition-colors duration-150 hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary';
const STEP_ROW_ACTIVE = 'border-primary/40 bg-primary/10 hover:bg-primary/10';

function StepGroup({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-muted-foreground px-1 text-[11px] font-semibold tracking-wider uppercase">{title}</h3>
      {hint && <p className="text-muted-foreground px-1 pb-1 text-[11px] leading-snug">{hint}</p>}
      {children}
    </section>
  );
}

/** One step in the list: select it, or delete it from its hover tool. */
function StepRow({ node, index, active, isEntry, hasError, onSelect, onRemove, t }: {
  node: BuilderNode;
  /** Its number in the "Then…" list (absent for a step nothing leads to). */
  index?: number;
  active: boolean;
  isEntry: boolean;
  hasError: boolean;
  onSelect: () => void;
  onRemove: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const tSummary = useTranslations('Flows.summary');
  const tb = useTranslations('Flows.builder.basic');
  const label = t(`nodes.${node.node_type}.label`);
  const summary = summarizeNode(node, tSummary);
  return (
    <div className={cn('group relative', STEP_ROW, 'p-0', active && STEP_ROW_ACTIVE)} data-step={node.node_key}>
      <button type="button" onClick={onSelect} aria-current={active ? 'true' : undefined}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-2 text-left focus-visible:outline-2 focus-visible:outline-primary">
        <NodeIconChip type={node.node_type} size={28} iconSize={14} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{label}</span>
            {isEntry && <Badge variant="outline" className="border-primary/40 bg-primary/10 text-primary h-4 px-1 text-[9px]">{t('badgeEntry')}</Badge>}
          </span>
          {summary && <span className="text-muted-foreground block truncate text-xs">{summary}</span>}
        </span>
        {hasError ? <CircleAlert className="h-3.5 w-3.5 shrink-0 text-red-400" aria-label={tb('hasErrors')} />
          : index !== undefined && <span className="text-muted-foreground shrink-0 text-xs font-semibold tabular-nums" aria-hidden>{index}</span>}
      </button>
      {/* Floats over the row's end on hover or focus, so names keep their full width. Touch
          screens have no hover, so they delete from the editor's footer instead. */}
      <button type="button" onClick={onRemove} aria-label={`${t('removeNode')}: ${label}`} title={t('removeNode')}
        className="bg-card text-muted-foreground pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2 rounded-md border border-border p-1.5 opacity-0 shadow-sm transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 hover:text-red-400 focus-visible:opacity-100 [@media(hover:none)]:hidden">
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/**
 * What the selected step sends, in a phone: the preview engine run from
 * that step until it waits for the customer. Local only, never sends.
 */
function StepPhone({ node, nodes, instagram }: { node: BuilderNode | null; nodes: BuilderNode[]; instagram: boolean }) {
  const t = useTranslations('Flows.builder.preview');
  const tb = useTranslations('Flows.builder.basic');
  const { account } = useAuth();
  const messages = useMemo(() => (node ? startPreview(nodes, node.node_key).messages : []), [node, nodes]);
  const channel = instagram ? 'instagram' : 'whatsapp';
  const hint = 'm-auto px-4 text-center text-xs ' + (instagram ? 'text-black/50' : 'text-white/60');
  return (
    <aside aria-label={tb('phoneTitle')} className="border-border bg-card-2 hidden shrink-0 flex-col items-center gap-3 border-l px-5 py-6 @6xl:flex @6xl:w-[340px] @6xl:overflow-y-auto">
      <p className="text-muted-foreground self-start text-[11px] font-semibold tracking-wider uppercase">{tb('phoneTitle')}</p>
      {/* The same handset as Preview: fixed colours, so it reads the same in light and dark mode. */}
      <div data-testid="step-phone" className="contents">
        <PhoneFrame channel={channel} title={account?.name || t('phoneBusiness')}
          subtitle={instagram ? t('phoneSubtitleInstagram') : t('phoneSubtitleWhatsapp')} className="h-[560px]">
          {!node ? (
            <p className={hint}>{tb('phonePick')}</p>
          ) : messages.length === 0 ? (
            <p className={hint}>{tb('phoneNothing')}</p>
          ) : (
            messages.map((m) => <PhoneBubble key={m.id} message={m} channel={channel} active={false} t={t} />)
          )}
        </PhoneFrame>
      </div>
    </aside>
  );
}

// ============================================================
// Version bar (Phase 12)
// ============================================================

/**
 * What is live, unpublished changes, and Publish / Pause / Resume / Archive
 * with the versions drawer. `toolbarExtra` is the slot for tools that sit
 * beside those actions (the dry-run panel mounts there).
 */
export function FlowVersionBar() {
  return <VersionBar toolbarExtra={<DryRunPanel />} />;
}

// ============================================================
// Channel ("WhatsApp flow" / "Instagram flow")
// ============================================================

/**
 * Saves `next` through PUT /api/flows/[id]. Resolves null when the server
 * took it, else the server's message ('' when it gave none). A published
 * flow's channel is fixed (409 channel_locked).
 */
export async function persistChannelScope(flowId: string, next: FlowChannelScope): Promise<string | null> {
  try {
    const res = await authFetch(`/api/flows/${encodeURIComponent(flowId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel_scope: next }),
    });
    if (res.ok) return null;
    const json = (await res.json().catch(() => null)) as { error?: unknown } | null;
    return typeof json?.error === 'string' ? json.error : '';
  } catch {
    return '';
  }
}

/**
 * The flow's channel as a read-only chip: a flow belongs to its section. A
 * legacy 'any' flow shows "Both channels" with a split action, and while it
 * was never published it can still be moved to one channel.
 */
function ChannelScopePanel({
  flowId,
  scope,
  published,
  dirty,
  section,
  onSaved,
}: {
  flowId: string;
  scope: FlowChannelScope;
  published: boolean;
  /** Unsaved edits: a split copies the saved draft, so it waits for Save. */
  dirty: boolean;
  section: Channel;
  onSaved: (scope: FlowChannelScope) => void;
}) {
  const t = useTranslations('Flows.channelSection');
  const tChannel = useTranslations('Flows.channel');
  const tHeader = useTranslations('Flows.header');
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  if (scope !== 'any') {
    return (
      <div className="flex items-center gap-2" data-flow-channel={scope}>
        <Badge variant="outline" className="border-primary/40 bg-primary/10 text-primary">
          {t(scope === 'instagram' ? 'chipInstagram' : 'chipWhatsapp')}
        </Badge>
      </div>
    );
  }
  const move = async (next: FlowChannelScope) => {
    if (next === scope) return;
    setSaving(true);
    const error = await persistChannelScope(flowId, next);
    setSaving(false);
    if (error !== null) {
      toast.error(error || tChannel('scopeSaveFailed'));
      return;
    }
    // The editor stays open (unsaved edits are kept); the flow lists under its new section from now on.
    onSaved(next);
  };
  const split = async () => {
    setSaving(true);
    const ids = await splitFlow(flowId);
    setSaving(false);
    if (!ids) {
      toast.error(t('splitFailed'));
      return;
    }
    toast.success(t('splitDone'));
    router.push(channelPath(section, 'flows', ids[section]));
  };
  return (
    <section className="border-border bg-card flex flex-col gap-2 rounded-lg border p-4" data-flow-channel="any">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300">
          {t('bothChannels')}
        </Badge>
        <p className="text-muted-foreground text-xs">{t('bothChannelsHelp')}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" disabled={saving || dirty}
          title={dirty ? tHeader('unsavedHint') : undefined} onClick={() => void split()}>
          {t('split')}
        </Button>
        {!published && (
          <>
            <label htmlFor="flow-channel-scope" className="text-muted-foreground text-xs">
              {t('moveTo')}
            </label>
            <Select value={scope} disabled={saving} onValueChange={(v) => void move(v as FlowChannelScope)}>
              <SelectTrigger id="flow-channel-scope" className="bg-muted md:w-48">
                <SelectValue>{tChannel(scope)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {(['any', ...CREATABLE_CHANNEL_SCOPES] as FlowChannelScope[]).map((value) => (
                  <SelectItem key={value} value={value}>
                    {tChannel(value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        )}
      </div>
    </section>
  );
}

// ============================================================
// Keyword trigger input
// ============================================================

// ============================================================
// Trigger panel
// ============================================================

function TriggerPanel({
  state,
  setState,
  triggerTypes,
  triggerIssues,
  instagramOnly,
  t,
}: {
  state: BuilderState;
  setState: React.Dispatch<React.SetStateAction<BuilderState>>;
  /** The triggers the flow's channel offers; the current one is kept so the picker can show it. */
  triggerTypes: BuilderState['trigger_type'][];
  triggerIssues: ValidationIssue[];
  /** The flow runs on Instagram only: the ad trigger describes click-to-Direct ads. */
  instagramOnly: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  const shareToStoryOn = useShareToStoryEnabled();
  // Share-to-Story is offered only while its flag is on; a flow that already has it keeps showing it.
  const offered = (triggerTypes.includes(state.trigger_type) ? triggerTypes : [...triggerTypes, state.trigger_type])
    .filter((trigger) => trigger !== 'ig_share_to_story' || shareToStoryOn || trigger === state.trigger_type);
  const setConfig = (trigger_config: Record<string, unknown>) => setState((s) => ({ ...s, trigger_config }));
  return (
    <section className="border-border bg-card rounded-lg border p-4">
      <h2 className="text-foreground mb-3 text-sm font-semibold">{t('triggerTitle')}</h2>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <label className="text-muted-foreground mb-1 block text-xs">
            {t('whenLabel')}
          </label>
          <Select
            value={state.trigger_type}
            // A comment trigger also makes a private reply the first step (applyTriggerType).
            onValueChange={(v) => setState((s) => applyTriggerType(s, v as BuilderState['trigger_type']))}
          >
            <SelectTrigger className="bg-muted">
              <SelectValue>{t(TRIGGER_TITLE_KEYS[state.trigger_type])}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {offered.map((trigger) => (
                <SelectItem key={trigger} value={trigger}>
                  {t(TRIGGER_TITLE_KEYS[trigger])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <TriggerForm type={state.trigger_type} config={state.trigger_config} onChange={setConfig}
          instagramOnly={instagramOnly} shareToStoryOn={shareToStoryOn} />
      </div>
      <ExtraTriggersList state={state} setState={setState} triggerTypes={offered} scope={instagramOnly ? 'instagram' : 'whatsapp'}
        instagramOnly={instagramOnly} shareToStoryOn={shareToStoryOn} />
      {triggerIssues.length > 0 && (
        <div className="mt-3 flex flex-col gap-1">
          {triggerIssues.map((i, ix) => (
            <IssueLine key={ix} issue={i} />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * Stage 5: the flow's further triggers under the primary one (Instagram
 * flows). One is open at a time, so the trigger forms' field ids stay unique.
 */
function ExtraTriggersList({ state, setState, triggerTypes, scope, instagramOnly, shareToStoryOn }: {
  state: BuilderState;
  setState: (updater: (prev: BuilderState) => BuilderState) => void;
  triggerTypes: BuilderState['trigger_type'][];
  scope: FlowChannelScope;
  instagramOnly: boolean;
  shareToStoryOn: boolean;
}) {
  const t = useTranslations('Flows.builder');
  const tm = useTranslations('Flows.multiTrigger');
  const [open, setOpen] = useState<number | null>(null);
  const [picking, setPicking] = useState(false);
  const triggers = stackTriggers(state);
  const extras = triggers.slice(1);
  const block = addTriggerBlock(scope, state.trigger_type, extras.length);
  if (block === 'onlyInstagram' && !extras.length) return null;
  return (
    <div className="mt-4 flex flex-col gap-2 border-t border-border pt-3">
      {extras.map((trigger, i) => {
        const index = i + 1;
        return (
          <div key={index} className="rounded-md border border-border">
            <div className="flex items-center gap-2 px-3 py-2">
              <button type="button" className="flex-1 text-left text-xs font-medium" aria-expanded={open === index}
                onClick={() => setOpen(open === index ? null : index)}>
                {t(TRIGGER_TITLE_KEYS[trigger.trigger_type])}
              </button>
              <Button type="button" variant="ghost" size="sm" aria-label={tm('removeTrigger')}
                onClick={() => { setOpen(null); setState((s) => removeTrigger(s, index)); }}
                className="text-red-400 hover:bg-red-500/10 hover:text-red-300">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
            {open === index && (
              <div className="grid grid-cols-1 gap-3 border-t border-border p-3 md:grid-cols-2">
                <TriggerForm type={trigger.trigger_type} config={trigger.config} instagramOnly={instagramOnly} shareToStoryOn={shareToStoryOn}
                  onChange={(config) => setState((s) => setTriggerConfig(s, index, config))} />
              </div>
            )}
          </div>
        );
      })}
      {block !== 'onlyInstagram' && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" disabled={block !== null} onClick={() => setPicking(true)}>
            <Plus className="h-3.5 w-3.5" />{tm('addTrigger')}
          </Button>
          {block && <span className="text-[11px] text-muted-foreground">{tm(block === 'limitReached' ? 'limitReached' : 'notCombinable', { max: MAX_TRIGGERS })}</span>}
        </div>
      )}
      <TriggerPickerDialog open={picking} onOpenChange={setPicking} offered={triggerTypes}
        onPick={(type) => { setState((s) => addExtraTrigger(s, type)); setOpen(extras.length + 1); }} />
    </div>
  );
}

// ============================================================
// Entry-node picker
// ============================================================

function EntryPicker({
  state,
  setState,
  t,
}: {
  state: BuilderState;
  setState: React.Dispatch<React.SetStateAction<BuilderState>>;
  t: ReturnType<typeof useTranslations>;
}) {
  const tNodes = useTranslations('Flows.nodes.igPrivateReply');
  if (state.nodes.length === 0) return null;
  const entry = state.nodes.find((n) => n.node_key === state.entry_node_id);
  // A comment flow starts with its private reply (Instagram's one reply to the comment); the entry stays locked to it.
  if (entry && entryLocked(commentTriggerOf(state), state.nodes, state.entry_node_id)) {
    return (
      <section className="border-border bg-card flex items-center gap-3 rounded-lg border p-3" data-entry-locked="">
        <CornerDownRight className="text-primary h-4 w-4 shrink-0" />
        <span className="text-muted-foreground text-xs">{t('entryNodeTitle')}</span>
        <span className="font-mono text-xs">{entry.node_key}</span>
        <span className="text-muted-foreground text-[10px]">{tNodes('firstOnly')}</span>
      </section>
    );
  }
  return (
    <section className="border-border bg-card flex items-center gap-3 rounded-lg border p-3">
      <CornerDownRight className="text-primary h-4 w-4 shrink-0" />
      <span className="text-muted-foreground text-xs">{t('entryNodeTitle')}</span>
      <NodeKeySelect
        entry
        value={state.entry_node_id}
        nodes={state.nodes}
        onChange={(key) => setState((s) => ({ ...s, entry_node_id: key }))}
        placeholder={t('entryNodePlaceholder')}
        className="max-w-xs flex-1"
      />
    </section>
  );
}

// ============================================================
// Step editor — the middle column of the Simple builder
// ============================================================

function StepEditor({
  node,
  allNodes,
  isEntry,
  isFlashed,
  issues,
  onUpdate,
  onUpdateConfig,
  onRemove,
  onSetEntry,
  position,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onDuplicate,
  t,
}: {
  node: BuilderNode;
  allNodes: BuilderNode[];
  isEntry: boolean;
  isFlashed: boolean;
  issues: ValidationIssue[];
  onUpdate: (patch: Partial<BuilderNode>) => void;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
  onRemove: () => void;
  /** Absent while the entry is locked (a comment flow starts with its private reply). */
  onSetEntry?: () => void;
  /** "Step 2 of 5" in the Then… list; null for a step nothing leads to. */
  position: { index: number; total: number } | null;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  /** Absent for a step a flow has only one of (start, private reply). */
  onDuplicate?: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const tb = useTranslations('Flows.builder.basic');
  const c = nodeColors(node.node_type);
  const tool = 'text-muted-foreground hover:bg-muted hover:text-foreground inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-primary disabled:pointer-events-none disabled:opacity-40';
  const label = t(`nodes.${node.node_type}.label`);
  return (
    <section
      aria-label={t(`nodes.${node.node_type}.label`)}
      data-testid="step-editor"
      className={cn(
        'bg-card relative overflow-hidden rounded-xl border transition-shadow duration-500',
        issues.some((i) => i.severity === 'error') ? 'border-red-500/40' : isEntry ? 'border-primary/50' : 'border-border',
        isFlashed && 'ring-primary ring-offset-background ring-2 ring-offset-2'
      )}
    >
      <div className="border-border flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-3" style={{ background: c.soft }}>
        <NodeIconChip type={node.node_type} size={32} iconSize={16} />
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <span className="truncate" style={{ color: c.text }}>{label}</span>
            {isEntry && (
              <Badge variant="outline" className="border-primary/40 bg-primary/10 text-primary text-[10px]">{t('badgeEntry')}</Badge>
            )}
          </h2>
          <p className="text-muted-foreground truncate text-xs">
            {position ? tb('stepOf', { index: position.index, total: position.total }) : t(`nodes.${node.node_type}.blurb`)}
          </p>
        </div>
        <code className="bg-muted text-muted-foreground hidden max-w-[10rem] truncate rounded px-1.5 py-0.5 text-[10px] @lg:inline">{node.node_key}</code>
        {/* Move up / Move down / Duplicate / Delete, as in the prototype's step header. */}
        <div role="toolbar" aria-label={tb('stepTools', { step: label })} className="flex items-center gap-0.5">
          <button type="button" className={tool} onClick={onMoveUp} disabled={!canMoveUp}
            aria-label={tb('moveUp')} title={canMoveUp ? tb('moveUp') : tb('cantMove')}>
            <ArrowUp className="h-4 w-4" />
          </button>
          <button type="button" className={tool} onClick={onMoveDown} disabled={!canMoveDown}
            aria-label={tb('moveDown')} title={canMoveDown ? tb('moveDown') : tb('cantMove')}>
            <ArrowDown className="h-4 w-4" />
          </button>
          <button type="button" className={tool} onClick={onDuplicate} disabled={!onDuplicate}
            aria-label={tb('duplicateStep')} title={tb('duplicateStep')}>
            <Copy className="h-4 w-4" />
          </button>
          <button type="button" className={cn(tool, 'hover:bg-red-500/10 hover:text-red-400')} onClick={onRemove}
            aria-label={t('removeNode')} title={t('removeNode')}>
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="px-4 py-4">
        <NodeConfigWithAdvanced node={node} allNodes={allNodes} onUpdate={onUpdate} onUpdateConfig={onUpdateConfig} t={t} />
        {issues.length > 0 && (
          <div className="mt-3 flex flex-col gap-1 rounded-md bg-red-500/5 p-2">
            {issues.map((i, ix) => (
              <IssueLine key={ix} issue={i} />
            ))}
          </div>
        )}
      </div>
      {/* Delete sits in the header's tools (every screen, touch included). */}
      {!isEntry && onSetEntry && (
        <div className="border-border flex items-center border-t px-3 py-3">
          <Button variant="ghost" size="sm" onClick={onSetEntry}>{t('setAsEntry')}</Button>
        </div>
      )}
    </section>
  );
}

// ============================================================
// Per-node-type config form — wraps the extracted dispatcher with
// the list-view's "Show advanced" disclosure (which exposes the
// internal node_key for stable analytics, hidden by default).
// ============================================================

function NodeConfigWithAdvanced({
  node,
  allNodes,
  onUpdate,
  onUpdateConfig,
  t,
}: {
  node: BuilderNode;
  allNodes: BuilderNode[];
  onUpdate: (patch: Partial<BuilderNode>) => void;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const keyFieldId = useId();
  const hasReplyIds =
    node.node_type === 'send_buttons' || node.node_type === 'send_list';
  return (
    <div className="flex flex-col gap-3">
      <NodeConfigForm
        node={node}
        allNodes={allNodes}
        showAdvanced={showAdvanced}
        onUpdateConfig={onUpdateConfig}
      />
      <div className="border-border border-t pt-3">
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
        >
          {showAdvanced ? (
            <ChevronUp className="h-3 w-3" />
          ) : (
            <ChevronDown className="h-3 w-3" />
          )}
          {showAdvanced ? t('hideAdvanced') : t('showAdvanced')}
        </button>
        {showAdvanced && (
          <div className="mt-3 flex flex-col gap-3">
            <div>
              <label htmlFor={keyFieldId} className="text-muted-foreground mb-1 block text-xs">
                {t('nodeKeyLabel')}
              </label>
              <Input
                id={keyFieldId}
                value={node.node_key}
                onChange={(e) =>
                  onUpdate({ node_key: slugify(e.target.value, node.node_key) })
                }
                className="bg-muted font-mono text-xs"
              />
            </div>
            {hasReplyIds && (
              <p className="text-muted-foreground text-[10px]">
                {t('replyIdsHint')}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Add-node menu
// ============================================================

function AddNodeButton({ types, onAdd, t }: { types: NodeType[]; onAdd: (type: NodeType) => void; t: ReturnType<typeof useTranslations> }) {
  // Steps whose provider is not set up are shown disabled with the reason,
  // as in the canvas palette; publish validation enforces the same rule.
  const caps = useWorkspaceCapabilities();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="border-border bg-card text-foreground hover:bg-muted inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors"
        aria-label={t('addNode')}
      >
        <Plus className="h-3.5 w-3.5" />
        {t('addNode')}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="border-border bg-popover">
        {groupNodeTypesByCategory(types).map((group, i) => (
          // A DropdownMenuGroup (base-ui Menu.Group) is REQUIRED here:
          // DropdownMenuLabel is base-ui's Menu.GroupLabel, which throws
          // at render if it can't find a Menu.Group ancestor context. A
          // plain <div> wrapper made opening this menu crash the page.
          <Fragment key={group.id}>
            {i > 0 && <DropdownMenuSeparator />}
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-muted-foreground text-[11px] font-semibold tracking-wider uppercase">
                {t(`categories.${group.id}`)}
              </DropdownMenuLabel>
              {group.types.map((t_type) => {
                const meta = NODE_META[t_type];
                const blocked = paletteBlock(t_type, caps);
                return (
                  <DropdownMenuItem
                    key={t_type}
                    disabled={!!blocked}
                    title={blocked ? t(`capabilityBlocked.${blocked}`) : undefined}
                    data-blocked={blocked ?? undefined}
                    onClick={() => onAdd(t_type)}
                  >
                    <meta.icon className={cn('h-3.5 w-3.5', meta.color)} />
                    {t(`nodes.${t_type}.label`)}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuGroup>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
