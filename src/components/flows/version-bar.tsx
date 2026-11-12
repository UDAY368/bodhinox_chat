'use client';

/**
 * Version bar (Phase 12): what is live, whether the draft differs from it,
 * and the lifecycle actions.
 *
 * - Status pill: Draft · Live vN · Paused vN · Archived ("Live (republish to
 *   pin)" for an active flow that has no version yet).
 * - "Unpublished changes" when the saved draft differs from the live version.
 * - Publish / Pause / Resume / Archive. Publish sends the hash of the draft
 *   this editor loaded or last saved, so what goes live is exactly the draft
 *   shown (a draft another member saved since is refused and the page
 *   reloads). All of them are disabled while there are unsaved edits, since
 *   they reload the editor. Pause and Archive ask whether to also cancel the
 *   runs in progress (every run of the flow, pinned or not).
 * - A versions drawer: view a version's steps read-only, move waiting runs of
 *   an old version onto the live one, or cancel an old version's runs.
 * - `toolbarExtra`: a slot for tools that sit beside these actions (the dry
 *   run panel).
 *
 * Every action reloads the editor afterwards, so the header and the canvas
 * show the flow as the server now has it.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Archive, Eye, GitBranch, History, Loader2, PauseCircle, PlayCircle, Rocket, XCircle } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { authFetch } from '@/lib/auth/client';
import { cn } from '@/lib/utils';
import { summarizeNode, type BuilderNode } from './shared';
import { useFlowEditor } from './flow-editor-state';

interface VersionSummary {
  id: string;
  version: number;
  published_at: string;
  published_by_name: string | null;
  node_count: number;
  active_runs: number;
}

interface VersionsResponse {
  versions: VersionSummary[];
  published_version: { id: string; version: number } | null;
  draft_hash: string;
  has_unpublished_changes: boolean;
  /** Every run in progress on the flow, including runs on no version. */
  active_runs?: number;
}

interface VersionSnapshot {
  id: string;
  version: number;
  entry_node_id: string | null;
  nodes: Array<{ node_key: string; node_type: string; config: Record<string, unknown> }>;
}

type Status = 'draft' | 'active' | 'paused' | 'archived';

/** The header's "Version history" menu item opens this bar's drawer. */
export const OPEN_VERSIONS_EVENT = 'bodhinox:flow-versions-open';

/**
 * Runs in progress on the flow. Archive refuses while any run is in
 * progress, pinned or not (draft test-number runs have no version), so the
 * flow-wide count wins over the per-version sum.
 */
export function totalActiveRuns(info: Pick<VersionsResponse, 'versions' | 'active_runs'> | null): number {
  return info?.active_runs ?? (info?.versions ?? []).reduce((sum, v) => sum + v.active_runs, 0);
}
type Confirm = { kind: 'pause' | 'archive'; cancel: boolean } | null;

async function errorOf(res: Response, fallback: string): Promise<string> {
  const json = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return typeof json?.error === 'string' ? json.error : fallback;
}

export function VersionBar({ toolbarExtra }: { toolbarExtra?: ReactNode }) {
  const t = useTranslations('Flows.versions');
  const { flow, state, dirty, canActivate, publish: publishDraft } = useFlowEditor();
  const [info, setInfo] = useState<VersionsResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [viewing, setViewing] = useState<VersionSnapshot | null>(null);
  const status = state.status as Status;

  const refresh = useCallback(async () => {
    const res = await authFetch(`/api/flows/${flow.id}/versions`);
    if (res.ok) setInfo((await res.json()) as VersionsResponse);
  }, [flow.id]);

  useEffect(() => {
    const open = () => setDrawerOpen(true);
    window.addEventListener(OPEN_VERSIONS_EVENT, open);
    return () => window.removeEventListener(OPEN_VERSIONS_EVENT, open);
  }, []);

  // Refetch whenever the shared status changes too (the header's Activate
  // publishes a new version without reloading the page).
  useEffect(() => {
    void refresh();
  }, [refresh, state.status]);

  const activeRuns = totalActiveRuns(info);
  const live = info?.published_version ?? null;

  const changeStatus = async (next: Status, extra: Record<string, unknown> = {}) => {
    setBusy(true);
    try {
      const res = await authFetch(`/api/flows/${flow.id}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next, ...extra }),
      });
      if (!res.ok) {
        toast.error(await errorOf(res, t('actionFailed')));
        await refresh();
        return;
      }
      toast.success(t(`done.${next}`));
      // The header and canvas read the flow from the page load.
      window.location.reload();
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    // Publish exactly the draft this editor loaded or last saved (its hash),
    // never one re-read just now: another member's save is refused (409).
    setBusy(true);
    try {
      if (await publishDraft()) window.location.reload();
    } finally {
      setBusy(false);
    }
  };

  const runAction = async (path: 'migrate' | 'cancel', body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await authFetch(`/api/flows/${flow.id}/runs/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        toast.error(await errorOf(res, t('actionFailed')));
        return;
      }
      const json = (await res.json()) as { migrated?: number; cancelled?: number; left?: Array<{ count: number }> };
      if (path === 'migrate') {
        const left = (json.left ?? []).reduce((sum, l) => sum + l.count, 0);
        toast.success(t('migrated', { migrated: json.migrated ?? 0, left }));
      } else {
        toast.success(t('cancelled', { count: json.cancelled ?? 0 }));
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const view = async (versionId: string) => {
    const res = await authFetch(`/api/flows/${flow.id}/versions/${versionId}`);
    if (!res.ok) {
      toast.error(t('actionFailed'));
      return;
    }
    setViewing(((await res.json()) as { version: VersionSnapshot }).version);
  };

  const pill = (() => {
    if (status === 'archived') return { label: t('pill.archived'), cls: 'border-border bg-muted/50 text-muted-foreground' };
    if (status === 'paused') return { label: live ? t('pill.paused', { version: live.version }) : t('pill.pausedPlain'), cls: 'border-sky-600/40 bg-sky-500/10 text-sky-300' };
    if (status === 'active') return { label: live ? t('pill.live', { version: live.version }) : t('pill.liveUnpinned'), cls: 'border-emerald-600/40 bg-emerald-500/10 text-emerald-300' };
    return { label: t('pill.draft'), cls: 'border-border bg-muted text-muted-foreground' };
  })();

  // publish() saves pending edits first and publishes exactly what was saved, so unsaved edits do not block it.
  const publishBlocked = !canActivate;
  const publishTitle = !canActivate ? t('fixIssues') : undefined;
  // Pause and Archive reload the editor afterwards, which would drop unsaved edits.
  const lifecycleTitle = dirty ? t('saveFirst') : undefined;

  return (
    <div className="flex items-center gap-1" data-testid="flow-version-bar">
      <span className={cn('inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium', pill.cls)}>
        <GitBranch className="h-3 w-3" />
        {pill.label}
      </span>
      {live && info?.has_unpublished_changes && (
        <span title={t('unpublishedChanges')} className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-amber-600/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden />
          <span className="sr-only @6xl:not-sr-only">{t('unpublishedChanges')}</span>
        </span>
      )}

      <div className="flex items-center gap-1">
        {toolbarExtra}
        <Button variant="ghost" size="sm" onClick={() => setDrawerOpen(true)} disabled={!info?.versions.length}
          aria-label={t('versionsButton', { count: info?.versions.length ?? 0 })} title={t('versionsButton', { count: info?.versions.length ?? 0 })}>
          <History className="h-3.5 w-3.5" />
          <span className="hidden @[96rem]:inline">{t('versionsButton', { count: info?.versions.length ?? 0 })}</span>
        </Button>
        {status === 'active' && (
          <Button variant="outline" size="sm" disabled={busy || dirty} title={lifecycleTitle ?? t('pause')} aria-label={t('pause')} onClick={() => setConfirm({ kind: 'pause', cancel: false })}>
            <PauseCircle className="h-3.5 w-3.5" />
            <span className="hidden @6xl:inline">{t('pause')}</span>
          </Button>
        )}
        {status !== 'archived' && (
          <Button variant="ghost" size="sm" disabled={busy || dirty} title={lifecycleTitle ?? t('archive')} aria-label={t('archive')} onClick={() => setConfirm({ kind: 'archive', cancel: false })}>
            <Archive className="h-3.5 w-3.5" />
            <span className="hidden @[96rem]:inline">{t('archive')}</span>
          </Button>
        )}
        <Button size="sm" disabled={busy || publishBlocked} title={publishTitle} onClick={() => void publish()}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : status === 'paused' ? <PlayCircle className="h-3.5 w-3.5" /> : <Rocket className="h-3.5 w-3.5" />}
          {status === 'paused' ? t('resume') : live ? t('publishNew') : t('publish')}
        </Button>
      </div>

      <Dialog open={confirm !== null} onOpenChange={(open) => { if (!open) setConfirm(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{confirm?.kind === 'archive' ? t('archiveTitle') : t('pauseTitle')}</DialogTitle>
            <DialogDescription>{confirm?.kind === 'archive' ? t('archiveBody') : t('pauseBody')}</DialogDescription>
          </DialogHeader>
          {activeRuns > 0 && (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={confirm?.cancel ?? false}
                onCheckedChange={(checked) => setConfirm((c) => (c ? { ...c, cancel: checked === true } : c))}
              />
              {t('cancelActive', { count: activeRuns })}
            </label>
          )}
          {confirm?.kind === 'archive' && activeRuns > 0 && !confirm.cancel && (
            <p className="text-xs text-muted-foreground">{t('archiveNeedsCancel', { count: activeRuns })}</p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(null)}>{t('back')}</Button>
            <Button
              disabled={busy || dirty || (confirm?.kind === 'archive' && activeRuns > 0 && !confirm.cancel)}
              title={lifecycleTitle}
              onClick={() => {
                if (!confirm) return;
                const next = confirm.kind === 'archive' ? 'archived' : 'paused';
                const cancel = confirm.cancel;
                setConfirm(null);
                void changeStatus(next, cancel ? { cancel_active: true } : {});
              }}
            >
              {confirm?.kind === 'archive' ? t('archive') : t('pause')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Sheet open={drawerOpen} onOpenChange={(open) => { setDrawerOpen(open); if (!open) setViewing(null); }}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
          <SheetHeader>
            <SheetTitle>{viewing ? t('viewingTitle', { version: viewing.version }) : t('drawerTitle')}</SheetTitle>
            <SheetDescription>{viewing ? t('viewingHint') : t('drawerHint')}</SheetDescription>
          </SheetHeader>
          {viewing ? (
            <div className="flex flex-col gap-2 px-4 pb-4">
              <Button variant="ghost" size="sm" className="self-start" onClick={() => setViewing(null)}>{t('back')}</Button>
              {viewing.nodes.map((node) => {
                const summary = summarizeNode(node as BuilderNode);
                return (
                  <div key={node.node_key} className="rounded-lg border border-border bg-card p-2.5 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-muted-foreground">{node.node_key}</span>
                      <span className="text-xs font-medium">{node.node_type}</span>
                      {node.node_key === viewing.entry_node_id && (
                        <span className="rounded bg-primary-soft px-1.5 text-[10px] text-primary">{t('entry')}</span>
                      )}
                    </div>
                    {summary && <p className="mt-1 text-xs text-muted-foreground">{summary}</p>}
                  </div>
                );
              })}
            </div>
          ) : (
            <ul className="flex flex-col gap-2 px-4 pb-4">
              {(info?.versions ?? []).map((v) => {
                const isLive = v.id === live?.id;
                return (
                  <li key={v.id} className="rounded-lg border border-border bg-card p-3 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">v{v.version}</span>
                      {isLive && (
                        <span className="rounded-full border border-emerald-600/40 px-1.5 text-[10px] text-emerald-300">
                          {status === 'paused' ? t('pausedTag') : t('liveTag')}
                        </span>
                      )}
                      <span className="ml-auto text-xs text-muted-foreground">{new Date(v.published_at).toLocaleString()}</span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t('versionMeta', { by: v.published_by_name ?? '—', steps: v.node_count, runs: v.active_runs })}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <Button variant="ghost" size="sm" onClick={() => void view(v.id)}>
                        <Eye className="h-3.5 w-3.5" />
                        {t('view')}
                      </Button>
                      {!isLive && live && v.active_runs > 0 && (
                        <Button variant="outline" size="sm" disabled={busy}
                          onClick={() => void runAction('migrate', { from_version_id: v.id })}>
                          {t('migrate', { version: live.version })}
                        </Button>
                      )}
                      {!isLive && v.active_runs > 0 && (
                        <Button variant="ghost" size="sm" disabled={busy} className="text-red-400 hover:text-red-300"
                          onClick={() => { if (window.confirm(t('cancelConfirm', { count: v.active_runs, version: v.version }))) void runAction('cancel', { version_id: v.id }); }}>
                          <XCircle className="h-3.5 w-3.5" />
                          {t('cancelRuns')}
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
