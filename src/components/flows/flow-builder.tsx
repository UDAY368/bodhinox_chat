'use client';

/**
 * Linear-list flow editor.
 *
 * Renders the trigger panel, entry-node picker, and the per-node card
 * list. Header and validation panel are NOT owned here — they live
 * once in FlowEditorShell so they show in both views (lifted in PR 3
 * so canvas users can also save + see validator issues).
 *
 * State lives in the shared `useFlowEditor()` context — toggling
 * Canvas ⇄ List never loses edits, and a drag on the canvas updates
 * the same nodes the list view reads.
 *
 * What's still local: the `expanded` set (which cards are open) and
 * the scroll refs used when the validator's flashKey changes — those
 * are list-only and have no canvas analogue.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { paletteBlock, useWorkspaceCapabilities } from './palette';
import {
  CircleAlert,
  Plus,
  Trash2,
  ChevronDown,
  ChevronUp,
  CornerDownRight,
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
import { commentTriggerOf, useFlowEditor, type BuilderState } from './flow-editor-state';
import { VersionBar } from './version-bar';
import { splitFlow } from './split-flow';
import { DryRunPanel } from './dry-run-panel';

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
    addNode: addNodeCtx,
    updateNode,
    updateNodeConfig,
    removeNode: removeNodeCtx,
  } = useFlowEditor();

  // List-only UI state: which cards are expanded + scroll refs for
  // jump-to-node. The flash itself is read from context (flashKey)
  // so canvas + list share the same source of truth.
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(state.nodes.map((n) => n.node_key))
  );
  const nodeRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Wrap addNode so the new node opens expanded in the list view
  // (matches the previous behaviour where adding always revealed the
  // new card so the user could start editing immediately).
  const addNode = useCallback(
    (type: NodeType) => {
      const key = addNodeCtx(type);
      setExpanded((prev) => new Set([...prev, key]));
    },
    [addNodeCtx]
  );

  const removeNode = useCallback(
    (key: string) => {
      removeNodeCtx(key);
      setExpanded((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    },
    [removeNodeCtx]
  );

  const toggleExpanded = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const setNodeRef = useCallback(
    (key: string) => (el: HTMLDivElement | null) => {
      if (el) nodeRefs.current.set(key, el);
      else nodeRefs.current.delete(key);
    },
    []
  );

  // React to validator jumps via the shared flashKey. We DERIVE the
  // expanded-with-flash set (avoids the "setState inside effect"
  // smell of mutating `expanded` from a useEffect on flashKey), then
  // run a side-effect-only effect to scroll the row into view. The
  // flash class is rendered by NodeCard when its key matches
  // flashKey; the flash auto-clears in the context so no timer here.
  const expandedWithFlash = useMemo(() => {
    if (!flashKey || expanded.has(flashKey)) return expanded;
    return new Set([...expanded, flashKey]);
  }, [expanded, flashKey]);
  useEffect(() => {
    if (!flashKey) return;
    // requestAnimationFrame defers the scroll until after React has
    // committed any expand-induced layout shift.
    requestAnimationFrame(() => {
      const el = nodeRefs.current.get(flashKey);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }, [flashKey]);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-7">
      <ChannelScopePanel flowId={flow.id} scope={channelScope} published={!!flow.published_version_id}
        dirty={dirty} section={section} onSaved={setChannelScope} />

      <TriggerPanel
        state={state}
        setState={setState}
        triggerTypes={triggerTypes}
        triggerIssues={issues.filter((i) => i.scope === 'trigger')}
        instagramOnly={channelScope === 'instagram'}
        t={t}
      />

      <EntryPicker state={state} setState={setState} t={t} />

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-foreground text-sm font-semibold">
            {t('nodesTitle', { count: state.nodes.length })}
          </h2>
          <AddNodeButton types={nodeTypes} onAdd={addNode} t={t} />
        </div>

        {state.nodes.length === 0 ? (
          <div className="border-border bg-card/50 text-muted-foreground rounded-lg border border-dashed p-8 text-center text-sm">
            {t.rich('nodesEmpty', { strong: (chunks) => <strong>{chunks}</strong> })}
          </div>
        ) : (
          state.nodes.map((node) => (
            <NodeCard
              key={node.node_key}
              node={node}
              allNodes={state.nodes}
              expanded={expandedWithFlash.has(node.node_key)}
              isEntry={state.entry_node_id === node.node_key}
              isFlashed={flashKey === node.node_key}
              cardRef={setNodeRef(node.node_key)}
              issues={issues.filter(
                (i) => i.scope === 'node' && i.node_key === node.node_key
              )}
              onToggle={() => toggleExpanded(node.node_key)}
              onUpdate={(patch) => updateNode(node.node_key, patch)}
              onUpdateConfig={(patch) => updateNodeConfig(node.node_key, patch)}
              onRemove={() => removeNode(node.node_key)}
              onSetEntry={entryLocked(commentTriggerOf(state), state.nodes, state.entry_node_id) ? undefined : () =>
                setState((s) => ({ ...s, entry_node_id: node.node_key }))
              }
              t={t}
            />
          ))
        )}
      </section>
    </div>
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
// Node card — collapsed summary + expanded config form
// ============================================================

function NodeCard({
  node,
  allNodes,
  expanded,
  isEntry,
  isFlashed,
  cardRef,
  issues,
  onToggle,
  onUpdate,
  onUpdateConfig,
  onRemove,
  onSetEntry,
  t,
}: {
  node: BuilderNode;
  allNodes: BuilderNode[];
  expanded: boolean;
  isEntry: boolean;
  isFlashed: boolean;
  cardRef: (el: HTMLDivElement | null) => void;
  issues: ValidationIssue[];
  onToggle: () => void;
  onUpdate: (patch: Partial<BuilderNode>) => void;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
  onRemove: () => void;
  /** Absent while the entry is locked (a comment flow starts with its private reply). */
  onSetEntry?: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const meta = NODE_META[node.node_type];
  const c = nodeColors(node.node_type);
  const hasError = issues.some((i) => i.severity === 'error');
  const tSummary = useTranslations('Flows.summary');
  const preview = summarizeNode(node, tSummary);
  return (
    <div
      ref={cardRef}
      className={cn(
        'bg-card relative overflow-hidden rounded-xl border transition-shadow duration-500',
        hasError
          ? 'border-red-500/40'
          : isEntry
            ? 'border-primary/50'
            : 'border-border',
        isFlashed && 'ring-primary ring-offset-background ring-2 ring-offset-2'
      )}
    >
      {/* type-colored left rail, ties the list row to the canvas hue */}
      <span
        className="absolute inset-y-0 left-0 w-[3px]"
        style={{ background: c.solid }}
      />
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 pl-5 text-left"
      >
        <NodeIconChip type={node.node_type} size={32} iconSize={16} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className="truncate text-[11px] font-semibold tracking-wider uppercase"
              style={{ color: c.text }}
            >
              {t(`nodes.${node.node_type}.label`)}
            </span>
            <code className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[10px]">
              {node.node_key}
            </code>
            {isEntry && (
              <Badge
                variant="outline"
                className="border-primary/40 bg-primary/10 text-primary text-[10px]"
              >
                {t('badgeEntry')}
              </Badge>
            )}
          </div>
          {!expanded && preview && (
            <p className="text-muted-foreground mt-0.5 truncate text-xs">
              {preview}
            </p>
          )}
        </div>
        {hasError && (
          <CircleAlert className="h-3.5 w-3.5 shrink-0 text-red-400" />
        )}
        {expanded ? (
          <ChevronUp className="text-muted-foreground h-4 w-4" />
        ) : (
          <ChevronDown className="text-muted-foreground h-4 w-4" />
        )}
      </button>
      {expanded && (
        <div className="border-border border-t px-4 py-4">
          <NodeConfigWithAdvanced
            node={node}
            allNodes={allNodes}
            onUpdate={onUpdate}
            onUpdateConfig={onUpdateConfig}
            t={t}
          />
          <div className="border-border mt-4 flex items-center justify-between border-t pt-3">
            <div className="flex items-center gap-2">
              {!isEntry && onSetEntry && (
                <Button variant="ghost" size="sm" onClick={onSetEntry}>
                  {t('setAsEntry')}
                </Button>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={onRemove}
              className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t('removeNode')}
            </Button>
          </div>
          {issues.length > 0 && (
            <div className="mt-3 flex flex-col gap-1 rounded-md bg-red-500/5 p-2">
              {issues.map((i, ix) => (
                <IssueLine key={ix} issue={i} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
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
              <label className="text-muted-foreground mb-1 block text-xs">
                {t('nodeKeyLabel')}
              </label>
              <Input
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
