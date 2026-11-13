'use client';

// Knowledge sources for the AI agents (AI page, Knowledge tab; also the setup
// wizard's knowledge step): an optional "Ask the knowledge base" box, type
// chips (All, Websites, Documents, Q&A) with a search, and a table of sources
// with their status and sync progress, size, last update, an "In replies"
// switch and a row menu (view content, edit a Q&A or text source, copy the
// address, sync again, who may see it, delete). Sources are added in a dialog
// (website, sitemap, upload, Q&A or text). Admins change sources; the
// 'ai.knowledge' permission also decides who may change access (server-checked).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  BookOpen, Copy, Eye, FileText, Globe, HelpCircle, Loader2, Lock, MoreHorizontal, Pencil, Plus, RefreshCw, Search, Trash2, Users,
} from 'lucide-react';
import { authFetch } from '@/lib/auth/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { AskBox } from './ask-box';
import { SourceDetailDialog, SourceDialog, type SourceDialogState } from './source-dialogs';
import {
  filterSources, isCrawled, isRunning, kindKey, nextAccess, shouldPoll, sourceGroup, sourceReason, SOURCE_GROUPS, syncProgress,
  type AccessPatch, type KnowledgeSourceView, type SourceGroup,
} from './source-view';

export interface KnowledgePanelProps {
  /** Admins may add, re-crawl, edit and delete; everyone else sees the list. */
  canEdit: boolean;
  /** When false, a notice explains that sources cannot be indexed until an embeddings key is saved. */
  hasEmbeddingsKey?: boolean;
  /** Called after a source is added or removed, e.g. to refresh a setup checklist. */
  onChange?: () => void;
  /**
   * Admins may change who sees each source and whether it grounds customer
   * replies (the server also requires the 'ai.knowledge' permission). Defaults to canEdit.
   */
  canManageAccess?: boolean;
  /** Show the "Ask the knowledge base" box (agents and above). */
  canAsk?: boolean;
  /**
   * A page-level "Add source" request opens the add dialog (a new object each
   * time; `preset` starts a Q&A answer with that question).
   */
  addRequest?: { preset?: string } | null;
}

const POLL_MS = 5_000;
const GROUP_ICON = { website: Globe, document: FileText, qa: HelpCircle } as const;
// Wide: source | type | status | size | updated | in replies | actions. Medium: type and updated hidden. Phones: two rows.
const ROW = 'grid items-center gap-x-3.5 gap-y-2.5 px-4 py-3 grid-cols-[minmax(0,1fr)_auto] [grid-template-areas:"name_acts""status_use"] md:[grid-template-areas:none] md:grid-cols-[minmax(0,2fr)_minmax(130px,1fr)_88px_70px_76px] xl:grid-cols-[minmax(0,2.2fr)_96px_minmax(140px,1.1fr)_92px_116px_70px_76px]';

export function KnowledgePanel({ canEdit, hasEmbeddingsKey = true, onChange, canManageAccess = canEdit, canAsk = false, addRequest = null }: KnowledgePanelProps) {
  const t = useTranslations('AiStudio.knowledge');
  const tc = useTranslations('AiStudio.common');
  const tk = useTranslations('AiKnowledgeSources');
  const ta = useTranslations('AiKnowledgeAccess');
  const format = useFormatter();
  const [sources, setSources] = useState<KnowledgeSourceView[]>([]);
  const [loading, setLoading] = useState(true);
  const [group, setGroup] = useState<SourceGroup>('all');
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [dialog, setDialog] = useState<SourceDialogState | null>(null);
  const [viewing, setViewing] = useState<KnowledgeSourceView | null>(null);
  const [deleting, setDeleting] = useState<KnowledgeSourceView | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const res = await authFetch('/api/ai/knowledge/sources');
      const data = await res.json().catch(() => ({}));
      if (res.ok) setSources(data.sources ?? []);
      else if (!quiet) toast.error(data.error ?? tk('loadFailed'));
    } catch {
      if (!quiet) toast.error(tk('loadFailed'));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [tk]);
  useEffect(() => { void load(); }, [load]);

  const polling = shouldPoll(sources);
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => { void load(true); }, POLL_MS);
    return () => clearInterval(timer);
  }, [polling, load]);

  // A page-level "Add source" request opens the dialog once (also when it arrives with the first render).
  const [seenRequest, setSeenRequest] = useState<object | null>(null);
  if (addRequest && seenRequest !== addRequest) {
    setSeenRequest(addRequest);
    if (canEdit) setDialog({ kind: 'add', preset: addRequest.preset });
  }

  const list = useMemo(() => filterSources(sources, group, query), [sources, group, query]);
  const count = (g: SourceGroup) => (g === 'all' ? sources.length : sources.filter((s) => sourceGroup(s) === g).length);
  const replace = (source: KnowledgeSourceView) => setSources((all) => all.map((s) => (s.id === source.id ? source : s)));

  const recrawl = async (source: KnowledgeSourceView) => {
    setPending(source.id);
    try {
      const res = await authFetch(`/api/ai/knowledge/sources/${source.id}`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(data.error ?? t('toasts.failed')); return; }
      replace(data.source);
      toast.success(t('toasts.syncing', { title: source.title }));
    } catch {
      toast.error(t('toasts.failed'));
    } finally {
      setPending(null);
    }
  };

  const changeAccess = async (source: KnowledgeSourceView, patch: AccessPatch, message: string) => {
    if (!nextAccess(source, patch)) { toast.error(ta('adminOnlyNotCustomer')); return; }
    setPending(source.id);
    try {
      const res = await authFetch(`/api/ai/knowledge/sources/${source.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(res.status === 403 ? ta('forbidden') : data.error ?? t('toasts.failed')); return; }
      replace(data.source);
      toast.success(message);
    } catch {
      toast.error(t('toasts.failed'));
    } finally {
      setPending(null);
    }
  };

  const remove = async (source: KnowledgeSourceView) => {
    setPending(source.id);
    try {
      const res = await authFetch(`/api/ai/knowledge/sources/${source.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(data.error ?? t('toasts.failed')); return; }
      setSources((all) => all.filter((s) => s.id !== source.id));
      setDeleting(null);
      toast.success(t('toasts.deleted'));
      onChange?.();
    } catch {
      toast.error(t('toasts.failed'));
    } finally {
      setPending(null);
    }
  };

  // "Edit" reads the stored question and answer (or text) first, then opens the editor.
  const openEdit = async (source: KnowledgeSourceView) => {
    setPending(source.id);
    try {
      const res = await authFetch(`/api/ai/knowledge/sources/${source.id}`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      const content = data.content;
      if (!res.ok || !content || (content.kind === 'text' && content.truncated)) { setViewing(source); return; }
      setDialog(content.kind === 'qa'
        ? { kind: 'edit', source, question: content.question, answer: content.answer }
        : { kind: 'edit', source, title: source.title, content: content.text });
    } catch {
      toast.error(t('toasts.failed'));
    } finally {
      setPending(null);
    }
  };

  const copy = async (source: KnowledgeSourceView) => {
    try {
      await navigator.clipboard.writeText(source.url ?? '');
      toast.success(t('toasts.copied'));
    } catch {
      toast.error(t('toasts.failed'));
    }
  };

  const size = (s: KnowledgeSourceView) => {
    if (!s.pages_indexed) return '—';
    if (isCrawled(s.kind)) return t('size.pages', { count: s.pages_indexed });
    if (s.qa || s.kind === 'learning') return t('size.answers', { count: s.pages_indexed });
    return t('size.documents', { count: s.pages_indexed });
  };

  const status = (s: KnowledgeSourceView) => {
    const progress = syncProgress(s);
    const reason = sourceReason(s.error);
    if (isRunning(s)) {
      return (
        <div className="flex min-w-0 flex-col items-start gap-1.5">
          <Badge variant="secondary" className="rounded-full">
            <Loader2 className="animate-spin" aria-hidden />{t(`status.${s.status}`)}{progress !== null && <b className="font-semibold tabular-nums">{progress}%</b>}
          </Badge>
          {progress !== null && (
            <div className="h-1.5 w-full max-w-40 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}
              aria-label={t('progressLabel', { title: s.title })}>
              <i className="block h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${progress}%` }} />
            </div>
          )}
        </div>
      );
    }
    return (
      <div className="flex min-w-0 flex-col items-start gap-1">
        <Badge variant={s.status === 'failed' ? 'destructive' : s.status === 'ready' ? 'secondary' : 'outline'} className="rounded-full">{t(`status.${s.status}`)}</Badge>
        {reason && <small className={cn('text-xs', s.status === 'failed' ? 'text-muted-foreground' : 'text-amber-700 dark:text-amber-300')}>{tk(`reasons.${reason}`)}</small>}
      </div>
    );
  };

  return (
    <div className="min-w-0 space-y-4">
      {canAsk && <AskBox canWrite={canEdit} onWriteAnswer={(q) => setDialog({ kind: 'add', preset: q })} />}
      {!hasEmbeddingsKey && (
        <p role="status" className="rounded-lg bg-amber-500/10 px-3 py-2 text-[13px] text-amber-800 dark:text-amber-200">{tk('noEmbeddingsKey')}</p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap gap-1.5" role="group" aria-label={t('typeLabel')}>
          {SOURCE_GROUPS.map((g) => (
            <button key={g} type="button" aria-pressed={group === g} onClick={() => setGroup(g)}
              className={cn('inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                group === g ? 'border-primary bg-primary-soft text-primary' : 'border-border bg-card text-muted-foreground hover:text-foreground')}>
              {t(`types.${g}`)}<b className="font-semibold tabular-nums">{count(g)}</b>
            </button>
          ))}
        </div>
        <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
          <label className="relative flex h-9 min-w-0 flex-1 items-center sm:w-56 sm:flex-none">
            <Search className="pointer-events-none absolute left-3 size-4 text-muted-foreground" aria-hidden />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('search')} aria-label={t('search')}
              className="h-9 w-full rounded-full border border-border bg-card pr-3 pl-9 text-sm outline-none transition-colors duration-150 placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30" />
          </label>
          {canEdit && <Button type="button" variant="outline" className="h-9 shrink-0" onClick={() => setDialog({ kind: 'add' })}><Plus aria-hidden />{t('addShort')}</Button>}
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-8"><Loader2 className="size-5 animate-spin text-muted-foreground" aria-label={tc('loading')} /></div>
      ) : sources.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-4 py-12 text-center">
          <span className="flex size-11 items-center justify-center rounded-xl bg-primary-soft text-primary"><BookOpen className="size-5" aria-hidden /></span>
          <h2 className="text-base font-semibold">{t('emptyTitle')}</h2>
          <p className="max-w-sm text-sm text-muted-foreground">{t('emptyBody')}</p>
          {canEdit && <Button type="button" variant="outline" onClick={() => setDialog({ kind: 'add' })}><Plus aria-hidden />{t('addFirst')}</Button>}
        </div>
      ) : list.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-4 py-12 text-center">
          <h2 className="text-base font-semibold">{t('noMatchTitle')}</h2>
          <p className="text-sm text-muted-foreground">{t('noMatchBody')}</p>
          <Button type="button" variant="outline" onClick={() => { setGroup('all'); setQuery(''); }}>{t('clearFilters')}</Button>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card" role="table" aria-label={t('tableLabel')}>
          <div role="row" className={cn(ROW, 'hidden bg-muted py-2 text-xs font-semibold text-muted-foreground md:grid')}>
            <span role="columnheader">{t('cols.source')}</span>
            <span role="columnheader" className="hidden xl:block">{t('cols.type')}</span>
            <span role="columnheader">{t('cols.status')}</span>
            <span role="columnheader">{t('cols.size')}</span>
            <span role="columnheader" className="hidden xl:block">{t('cols.updated')}</span>
            <span role="columnheader" title={t('cols.inRepliesHint')}>{t('cols.inReplies')}</span>
            <span role="columnheader" className="sr-only">{t('cols.actions')}</span>
          </div>
          {list.map((s) => {
            const Icon = GROUP_ICON[sourceGroup(s)];
            const running = isRunning(s);
            const busy = pending === s.id;
            return (
              <div key={s.id} role="row" className={cn(ROW, 'border-t border-border transition-colors duration-150 hover:bg-muted/50 [&:nth-child(2)]:border-t-0')}>
                <div role="cell" className="flex min-w-0 items-center gap-3 [grid-area:name] md:[grid-area:auto]">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-[11px] bg-primary-soft text-primary"><Icon className="size-4" aria-hidden /></span>
                  <button type="button" className="min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 rounded-md" onClick={() => setViewing(s)}>
                    <strong className="block truncate text-sm font-semibold">{s.title}</strong>
                    <small className="block truncate text-xs text-muted-foreground">
                      {s.url ?? t(`kind.${kindKey(s)}`)}{s.min_role === 'admin' ? ` · ${ta('roles.admin')}` : ''}
                    </small>
                  </button>
                </div>
                <span role="cell" className="hidden xl:block"><Badge variant="outline" className="rounded-full">{t(`kind.${kindKey(s)}`)}</Badge></span>
                <div role="cell" className="min-w-0 [grid-area:status] md:[grid-area:auto]">{status(s)}</div>
                <span role="cell" className="hidden text-[13px] whitespace-nowrap text-muted-foreground tabular-nums md:block">{size(s)}</span>
                <span role="cell" className="hidden text-[13px] whitespace-nowrap text-muted-foreground xl:block">
                  {s.last_crawled_at ? format.relativeTime(new Date(s.last_crawled_at)) : t('never')}
                </span>
                <span role="cell" className="flex items-center gap-2 justify-self-end text-xs text-muted-foreground [grid-area:use] md:justify-self-start md:[grid-area:auto]">
                  <span className="md:sr-only">{t('cols.inReplies')}</span>
                  <Switch checked={s.customer_facing} disabled={!canManageAccess || busy || s.min_role === 'admin'}
                    aria-label={t('useInReplies', { title: s.title })}
                    onCheckedChange={(v: boolean) => void changeAccess(s, { customer_facing: v }, t(v ? 'toasts.inReplies' : 'toasts.teamOnly', { title: s.title }))} />
                </span>
                <span role="cell" className="flex items-center justify-end gap-0.5 [grid-area:acts] md:[grid-area:auto]">
                  {canEdit && (
                    <Button type="button" variant="ghost" size="icon-sm" disabled={running || busy} aria-label={t('syncAgainLabel', { title: s.title })}
                      title={s.status === 'failed' ? t('menu.tryAgain') : t('menu.syncAgain')} onClick={() => void recrawl(s)}>
                      <RefreshCw aria-hidden />
                    </Button>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger aria-label={t('more', { title: s.title })}
                      className="inline-flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 data-[popup-open]:bg-muted">
                      <MoreHorizontal className="size-4" aria-hidden />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => setViewing(s)}><Eye className="size-4" />{t('menu.view')}</DropdownMenuItem>
                      {canEdit && s.kind === 'text' && (
                        <DropdownMenuItem onClick={() => void openEdit(s)}><Pencil className="size-4" />{s.qa ? t('menu.editAnswer') : t('menu.editText')}</DropdownMenuItem>
                      )}
                      {s.url && <DropdownMenuItem onClick={() => void copy(s)}><Copy className="size-4" />{t('menu.copy')}</DropdownMenuItem>}
                      {canEdit && !running && (
                        <DropdownMenuItem onClick={() => void recrawl(s)}><RefreshCw className="size-4" />{s.status === 'failed' ? t('menu.tryAgain') : t('menu.syncAgain')}</DropdownMenuItem>
                      )}
                      {canManageAccess && (
                        s.min_role === 'admin'
                          ? <DropdownMenuItem onClick={() => void changeAccess(s, { min_role: 'agent' }, ta('saved'))}><Users className="size-4" />{t('menu.showAgents')}</DropdownMenuItem>
                          : <DropdownMenuItem onClick={() => void changeAccess(s, { min_role: 'admin' }, ta('saved'))}><Lock className="size-4" />{t('menu.adminsOnly')}</DropdownMenuItem>
                      )}
                      {canEdit && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive" onClick={() => setDeleting(s)}><Trash2 className="size-4" />{t('menu.delete')}</DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </span>
              </div>
            );
          })}
        </div>
      )}

      {dialog && (
        <SourceDialog state={dialog} onClose={() => setDialog(null)}
          onSaved={(source, message) => {
            toast.success(message);
            setGroup('all'); setQuery('');
            setSources((all) => (all.some((s) => s.id === source.id) ? all.map((s) => (s.id === source.id ? source : s)) : [source, ...all]));
            void load(true);
            onChange?.();
          }} />
      )}
      {viewing && (
        <SourceDetailDialog source={viewing} canEdit={canEdit} onClose={() => setViewing(null)}
          onEdit={(state) => { setViewing(null); setDialog(state); }} />
      )}
      <Dialog open={deleting !== null} onOpenChange={(open) => { if (!open) setDeleting(null); }}>
        <DialogContent className="border-border bg-popover sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="break-words">{t('deleteTitle', { title: deleting?.title ?? '' })}</DialogTitle>
            <DialogDescription>{t('deleteBody')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeleting(null)}>{tc('cancel')}</Button>
            <Button type="button" variant="destructive" disabled={!deleting || pending === deleting.id} onClick={() => deleting && void remove(deleting)}>{t('deleteConfirm')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
