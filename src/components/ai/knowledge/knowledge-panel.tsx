'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { BookOpen, FileUp, Globe, Loader2, Map as MapIcon, RefreshCw, Trash2, Type } from 'lucide-react';
import { authFetch } from '@/lib/auth/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
  ACCEPTED_UPLOADS, isCrawled, isRunning, nextAccess, shouldPoll, sourceReason, statusVariant, UPLOAD_MAX_BYTES,
  type AccessPatch, type KnowledgeSourceView,
} from './source-view';

export interface KnowledgePanelProps {
  /** Admins may add, re-crawl and delete; everyone else sees the list. */
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
}

type AddMode = 'website' | 'sitemap' | 'text' | 'file';
const POLL_MS = 5_000;

/** Knowledge sources for the AI agent: websites, sitemaps, files and text, with crawl status. */
export function KnowledgePanel({ canEdit, hasEmbeddingsKey = true, onChange, canManageAccess = canEdit }: KnowledgePanelProps) {
  const t = useTranslations('AiKnowledgeSources');
  const ta = useTranslations('AiKnowledgeAccess');
  const format = useFormatter();
  const [sources, setSources] = useState<KnowledgeSourceView[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<AddMode>('website');
  const [url, setUrl] = useState('');
  const [pageLimit, setPageLimit] = useState('50');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const res = await authFetch('/api/ai/knowledge/sources');
      const data = await res.json().catch(() => ({}));
      if (res.ok) setSources(data.sources ?? []);
      else if (!quiet) toast.error(data.error ?? t('loadFailed'));
    } catch {
      if (!quiet) toast.error(t('loadFailed'));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  const polling = shouldPoll(sources);
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => { void load(true); }, POLL_MS);
    return () => clearInterval(timer);
  }, [polling, load]);

  const resetForm = () => {
    setUrl(''); setTitle(''); setContent(''); setFile(null); setPageLimit('50');
    if (fileInput.current) fileInput.current.value = '';
  };

  const add = async () => {
    setBusy(true);
    try {
      let res: Response;
      if (mode === 'file') {
        if (!file) { toast.error(t('chooseFile')); return; }
        if (file.size > UPLOAD_MAX_BYTES) { toast.error(t('errors.file_too_large')); return; }
        const form = new FormData();
        form.set('file', file);
        if (title.trim()) form.set('title', title.trim());
        res = await authFetch('/api/ai/knowledge/upload', { method: 'POST', body: form });
      } else {
        const body = mode === 'text'
          ? { kind: 'text', title: title.trim(), content: content.trim() }
          : { kind: mode, url: url.trim(), ...(title.trim() ? { title: title.trim() } : {}), page_limit: Number(pageLimit) || 50 };
        res = await authFetch('/api/ai/knowledge/sources', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(data.error ?? t('actionFailed')); return; }
      toast.success(data.truncated ? t('uploadedTruncated') : t('added'));
      resetForm();
      await load(true);
      onChange?.();
    } catch {
      toast.error(t('actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  const recrawl = async (source: KnowledgeSourceView) => {
    setPending(source.id);
    try {
      const res = await authFetch(`/api/ai/knowledge/sources/${source.id}`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(data.error ?? t('actionFailed')); return; }
      toast.success(t('recrawlQueued'));
      setSources((list) => list.map((s) => (s.id === source.id ? data.source : s)));
    } catch {
      toast.error(t('actionFailed'));
    } finally {
      setPending(null);
    }
  };

  const changeAccess = async (source: KnowledgeSourceView, patch: AccessPatch) => {
    if (!nextAccess(source, patch)) { toast.error(ta('adminOnlyNotCustomer')); return; }
    setPending(source.id);
    try {
      const res = await authFetch(`/api/ai/knowledge/sources/${source.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(res.status === 403 ? ta('forbidden') : data.error ?? t('actionFailed')); return; }
      toast.success(ta('saved'));
      setSources((list) => list.map((s) => (s.id === source.id ? data.source : s)));
    } catch {
      toast.error(t('actionFailed'));
    } finally {
      setPending(null);
    }
  };

  const remove = async (source: KnowledgeSourceView) => {
    if (!window.confirm(t('deleteConfirm', { title: source.title }))) return;
    setPending(source.id);
    try {
      const res = await authFetch(`/api/ai/knowledge/sources/${source.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(data.error ?? t('actionFailed')); return; }
      toast.success(t('deleted'));
      setSources((list) => list.filter((s) => s.id !== source.id));
      onChange?.();
    } catch {
      toast.error(t('actionFailed'));
    } finally {
      setPending(null);
    }
  };

  const canSubmit = !busy && (mode === 'file' ? !!file
    : mode === 'text' ? !!title.trim() && !!content.trim()
    : !!url.trim());

  const modes: { key: AddMode; icon: typeof Globe }[] = [
    { key: 'website', icon: Globe }, { key: 'sitemap', icon: MapIcon }, { key: 'file', icon: FileUp }, { key: 'text', icon: Type },
  ];
  const kindIcon = (kind: string) => modes.find((m) => m.key === kind)?.icon ?? BookOpen;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {!hasEmbeddingsKey && (
          <p role="status" className="rounded-lg bg-amber-500/10 px-3 py-2 text-[13px] text-amber-800 dark:text-amber-200">{t('noEmbeddingsKey')}</p>
        )}

        {canEdit && (
          <div className="space-y-4 rounded-xl bg-muted/60 p-4">
            <div className="flex w-fit max-w-full gap-1 overflow-x-auto rounded-xl bg-muted p-[3px] [scrollbar-width:none]" role="tablist" aria-label={t('addLabel')}>
              {modes.map(({ key, icon: Icon }) => (
                <button key={key} type="button" role="tab" aria-selected={mode === key} onClick={() => setMode(key)}
                  className={cn('inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-[9px] px-3 text-[13px] font-medium whitespace-nowrap transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    mode === key ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                  <Icon className="h-4 w-4" aria-hidden />{t(`modes.${key}`)}
                </button>
              ))}
            </div>

            {(mode === 'website' || mode === 'sitemap') && (
              <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
                <div className="space-y-1">
                  <Label htmlFor="ks-url">{t(mode === 'website' ? 'fields.websiteUrl' : 'fields.sitemapUrl')}</Label>
                  <Input id="ks-url" type="url" inputMode="url" autoComplete="off" value={url} maxLength={2048}
                    placeholder={mode === 'website' ? 'https://example.com' : 'https://example.com/sitemap.xml'}
                    onChange={(e) => setUrl(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="ks-limit">{t('fields.pageLimit')}</Label>
                  <Input id="ks-limit" type="number" min={1} max={500} value={pageLimit} onChange={(e) => setPageLimit(e.target.value)} />
                </div>
                <p className="text-xs text-muted-foreground sm:col-span-2">{t(mode === 'website' ? 'hints.website' : 'hints.sitemap')}</p>
              </div>
            )}

            {(mode === 'text' || mode === 'file') && (
              <div className="space-y-1">
                <Label htmlFor="ks-title">{t(mode === 'file' ? 'fields.titleOptional' : 'fields.title')}</Label>
                <Input id="ks-title" value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} />
              </div>
            )}

            {mode === 'text' && (
              <div className="space-y-1">
                <Label htmlFor="ks-content">{t('fields.content')}</Label>
                <Textarea id="ks-content" rows={8} value={content} maxLength={100_000} onChange={(e) => setContent(e.target.value)} />
              </div>
            )}

            {mode === 'file' && (
              <div className="space-y-1">
                <Label htmlFor="ks-file">{t('fields.file')}</Label>
                <Input id="ks-file" ref={fileInput} type="file" accept={ACCEPTED_UPLOADS}
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                <p className="text-xs text-muted-foreground">{t('hints.file')}</p>
              </div>
            )}

            <Button type="button" onClick={add} disabled={!canSubmit}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
              {mode === 'file' ? t('upload') : t('add')}
            </Button>
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin" aria-label={t('loading')} /></div>
        ) : sources.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary"><BookOpen className="h-5 w-5" aria-hidden /></span>
            <p className="max-w-sm text-sm text-muted-foreground">{t('empty')}</p>
          </div>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
            {sources.map((source) => {
              const reason = sourceReason(source.error);
              const running = isRunning(source);
              const KindIcon = kindIcon(source.kind);
              return (
                <li key={source.id} className="flex flex-col gap-3 px-4 py-3 transition-colors duration-150 hover:bg-muted/40 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 gap-3">
                  <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] bg-primary/10 text-primary"><KindIcon className="h-4 w-4" aria-hidden /></span>
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-semibold">{source.title}</span>
                      <Badge variant="secondary" className="rounded-full">{t(`kinds.${source.kind}`)}</Badge>
                      <Badge variant={statusVariant(source.status)} className="rounded-full">
                        {running && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
                        {t(`statuses.${source.status}`)}
                      </Badge>
                    </div>
                    {source.url && <p className="truncate text-xs text-muted-foreground" title={source.url}>{source.url}</p>}
                    <p className="text-xs text-muted-foreground">
                      {t('pages', { count: source.pages_indexed })}
                      {' · '}
                      {source.last_crawled_at
                        ? t('lastCrawled', { when: format.relativeTime(new Date(source.last_crawled_at)) })
                        : t('neverCrawled')}
                    </p>
                    {reason && (
                      <p className={`text-xs ${source.status === 'failed' ? 'text-destructive' : 'text-amber-700 dark:text-amber-300'}`}>{t(`reasons.${reason}`)}</p>
                    )}
                    {canManageAccess ? (
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1 text-xs">
                        <label className="flex items-center gap-2">
                          <span className="text-muted-foreground">{ta('visibleTo')}</span>
                          <select className="h-8 rounded-lg border border-border bg-card px-2 text-xs text-foreground transition-colors duration-150 focus:border-ring focus:outline-none"
                            value={source.min_role} disabled={pending === source.id}
                            onChange={(e) => changeAccess(source, { min_role: e.target.value === 'admin' ? 'admin' : 'agent' })}>
                            <option value="agent">{ta('roles.agent')}</option>
                            <option value="admin">{ta('roles.admin')}</option>
                          </select>
                        </label>
                        <label className="flex items-center gap-2">
                          <Switch checked={source.customer_facing} disabled={pending === source.id || source.min_role === 'admin'}
                            onCheckedChange={(checked) => changeAccess(source, { customer_facing: checked === true })} />
                          <span className="text-muted-foreground">{ta('customerFacing')}</span>
                        </label>
                        {source.min_role === 'admin' && <span className="text-muted-foreground">{ta('adminOnlyHint')}</span>}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        {ta(source.customer_facing ? 'summaryCustomer' : 'summaryStaff')}
                      </p>
                    )}
                  </div>
                  </div>
                  {canEdit && (
                    <div className="flex shrink-0 gap-1 sm:justify-end">
                      <Button type="button" size="sm" variant="outline" disabled={running || pending === source.id}
                        onClick={() => recrawl(source)}>
                        <RefreshCw className="mr-1 h-4 w-4" aria-hidden />
                        {isCrawled(source.kind) ? t('recrawl') : t('reindex')}
                      </Button>
                      <Button type="button" size="sm" variant="ghost" disabled={pending === source.id}
                        aria-label={t('deleteLabel', { title: source.title })} onClick={() => remove(source)}>
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
