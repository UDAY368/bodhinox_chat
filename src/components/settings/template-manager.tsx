'use client';
import { authFetch } from "@/lib/auth/client";

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  Plus,
  Trash2,
  Loader2,
  RefreshCw,
  AlertCircle,
  Pencil,
  RotateCcw,
  Copy,
  History,
  Search,
  BookOpen,
  Sparkles,
  Send,
} from 'lucide-react';
import Link from 'next/link';
import { createClient } from '@/lib/data/client';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useTranslations } from 'next-intl';
import { Card, CardContent } from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';
import { CampaignHeader } from '@/components/broadcasts/campaign-ui';
import { TemplatePreview } from '@/components/templates/template-preview';
import { extractVariableIndices } from '@/lib/whatsapp/template-validators';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import type { MessageTemplate, TemplateKind } from '@/types';
import { templateStatusConfig } from '@/lib/template-status';
import { templateLanguageForAppLocale } from '@/lib/whatsapp/template-languages';
import { cn } from '@/lib/utils';
import { TemplateEditorDialog } from '@/components/templates/template-editor-dialog';
import { TemplateTimeline } from '@/components/templates/template-timeline';
import { TemplateAnalyticsAction } from '@/components/analytics/templates/template-analytics-dialog';
import { TemplateLibraryDialog } from '@/components/templates/template-library-dialog';
import { TemplateAiDialog } from '@/components/templates/template-ai-dialog';
import type { TemplateDraftInput } from '@/components/templates/types';
import {
  TEMPLATE_TABS,
  countTemplateTabs,
  emptyTemplateForm,
  filterTemplates,
  formFromTemplate,
  isLocalDraft,
  templateHealth,
  templateTabOf,
  type TemplateFormData,
  type TemplateHealth,
  type TemplateTab,
} from '@/components/templates/template-manager-helpers';

const categoryColors: Record<string, string> = {
  Marketing: 'bg-purple-600/20 text-purple-400 border-purple-600/30',
  Utility: 'bg-blue-600/20 text-blue-400 border-blue-600/30',
  Authentication: 'bg-amber-600/20 text-amber-400 border-amber-600/30',
};

const healthClasses: Record<TemplateHealth, string> = {
  green: 'bg-emerald-600/15 text-emerald-500 border-emerald-600/30',
  yellow: 'bg-yellow-600/15 text-yellow-500 border-yellow-600/30',
  red: 'bg-red-600/15 text-red-500 border-red-600/30',
  unknown: 'bg-muted text-muted-foreground border-border',
};

const healthDot: Record<TemplateHealth, string> = {
  green: 'bg-emerald-500',
  yellow: 'bg-yellow-500',
  red: 'bg-red-500',
  unknown: 'bg-muted-foreground/50',
};

/** What the editor dialog opens with; `key` remounts it per open. */
interface EditorState {
  key: number;
  initial: TemplateFormData;
  editingId: string | null;
  draftId: string | null;
}

/** The Campaigns header on the Templates tab; the Settings panel header elsewhere. */
function HeaderFor({ variant, title, description, action }: {
  variant: 'settings' | 'campaigns'; title: string; description: string; action?: React.ReactNode;
}) {
  return variant === 'campaigns'
    ? <CampaignHeader title={title} description={description} actions={action} />
    : <SettingsPanelHead title={title} description={description} action={action} />;
}

/** Categories a template list can be narrowed to (Meta's ids, stored as-is). */
const CATEGORIES = ['all', 'Marketing', 'Utility', 'Authentication'] as const;
type CategoryFilter = (typeof CATEGORIES)[number];

/**
 * `variant="campaigns"` renders the manager as the Campaigns > Templates tab
 * (the Campaigns header); Settings keeps its panel header.
 */
export function TemplateManager({ variant = 'settings' }: { variant?: 'settings' | 'campaigns' } = {}) {
  const t = useTranslations('Settings.templates');
  const tc = useTranslations('Campaigns');
  const canSend = useCan('send-messages');
  // Meta's category ids (stored as-is) → display label in the UI language.
  const categoryLabel = (category: string) =>
    t.has(`categoryLabels.${category}`) ? t(`categoryLabels.${category}`) : category;
  const db = createClient();
  const { user, loading: authLoading } = useAuth();
  // Template writes (create, draft, duplicate, delete, sync) are admin-only
  // on the server; hide them for roles that would only get a 403.
  const canEdit = useCan('edit-settings');

  const [loading, setLoading] = useState(true);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [tab, setTab] = useState<TemplateTab>('all');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<CategoryFilter>('all');
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
  // Template selected for the confirm-delete dialog. The destructive
  // action goes through this two-step so a slip on the trash icon
  // doesn't take the template off Meta as well as locally.
  const [templateToDelete, setTemplateToDelete] =
    useState<MessageTemplate | null>(null);
  const [historyFor, setHistoryFor] = useState<MessageTemplate | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiKey, setAiKey] = useState(0);

  const defaultLanguage = templateLanguageForAppLocale();
  const counts = useMemo(() => countTemplateTabs(templates), [templates]);
  const visible = useMemo(
    () => filterTemplates(templates, tab, query).filter((tpl) => category === 'all' || tpl.category === category),
    [templates, tab, query, category],
  );

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setLoading(false);
      return;
    }
    void fetchTemplates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user?.id]);

  /**
   * Load every template of the active account. The tenant-scoped client
   * limits rows to the account; user_id is only who created a row, so it
   * is not a filter here (templates another admin made belong too).
   */
  async function fetchTemplates(): Promise<MessageTemplate[]> {
    try {
      const { data, error } = await db
        .from('message_templates')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      const rows: MessageTemplate[] = data || [];
      setTemplates(rows);
      return rows;
    } catch (err) {
      console.error('Failed to fetch templates:', err instanceof Error ? err.name : 'unknown');
      toast.error(t('toastLoadFailed'));
      return [];
    } finally {
      setLoading(false);
    }
  }

  function openEditor(next: Omit<EditorState, 'key'>) {
    setEditor((prev) => ({ ...next, key: (prev?.key ?? 0) + 1 }));
    setEditorOpen(true);
  }

  function openCreate() {
    openEditor({ initial: emptyTemplateForm(defaultLanguage), editingId: null, draftId: null });
  }

  /** Library / AI drafts prefill a new template; nothing is submitted. */
  function openPrefilled(draft: TemplateDraftInput) {
    openEditor({ initial: formFromTemplate(draft), editingId: null, draftId: null });
  }

  /** A local draft is saved/submitted by id; a submitted template is PATCHed. */
  function openRow(template: MessageTemplate) {
    const local = isLocalDraft(template);
    openEditor({
      initial: formFromTemplate(template),
      editingId: local ? null : template.id,
      draftId: local ? template.id : null,
    });
  }

  async function handleDuplicate(template: MessageTemplate) {
    if (duplicatingId) return;
    setDuplicatingId(template.id);
    try {
      const res = await authFetch(`/api/whatsapp/templates/${template.id}/duplicate`, {
        method: 'POST',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.template) {
        throw new Error(data?.error || t('duplicateFailedHttp', { status: res.status }));
      }
      toast.success(t('toastDuplicated', { name: data.template.name }));
      await fetchTemplates();
      openRow(data.template as MessageTemplate);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('duplicateFailedHttp', { status: 0 }));
    } finally {
      setDuplicatingId(null);
    }
  }

  async function handleSyncFromMeta() {
    if (!user) return;
    setSyncing(true);
    try {
      const res = await authFetch('/api/whatsapp/templates/sync', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || t('syncFailedHttp', { status: res.status }));
      }
      toast.success(
        t('toastSyncCount', { total: data.total }) +
          (data.inserted || data.updated
            ? t('toastSyncDetails', { inserted: data.inserted, updated: data.updated })
            : ''),
      );
      if (Array.isArray(data.errors) && data.errors.length > 0) {
        const preview = data.errors.slice(0, 3).map(
          (e: { name: string; language: string; message: string }) =>
            `${e.name} (${e.language})`,
        );
        const suffix =
          data.errors.length > 3 ? t('syncMoreSuffix', { count: data.errors.length - 3 }) : '';
        toast.error(t('toastSyncFailed', { preview: preview.join(', ') + suffix }));
      }
      if (data.truncated) {
        // Use error (not warning) so the message survives long
        // enough to read — sonner's `warning` auto-dismisses on
        // the same short timer as `success`.
        toast.error(
          t('toastSyncTruncated'),
          { duration: 10000 },
        );
      }
      await fetchTemplates();
    } catch (err) {
      console.error('Template sync error:', err instanceof Error ? err.name : 'unknown');
      toast.error(err instanceof Error ? err.message : t('toastSyncError'));
    } finally {
      setSyncing(false);
    }
  }

  async function confirmDelete() {
    const target = templateToDelete;
    if (!target || deletingId) return;
    setDeletingId(target.id);
    try {
      // Route handler scopes the Meta delete via hsm_id (so sibling
      // language variants survive) and falls through to remove the
      // local row. Local-only rows skip the Meta call.
      const res = await authFetch(`/api/whatsapp/templates/${target.id}`, {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || t('deleteFailedHttp', { status: res.status }));
      }
      toast.success(t('toastDeleteSuccess'));
      setTemplates((prev) => prev.filter((row) => row.id !== target.id));
      setTemplateToDelete(null);
    } catch (err) {
      console.error('Delete error:', err instanceof Error ? err.name : 'unknown');
      toast.error(err instanceof Error ? err.message : t('toastDeleteError'));
    } finally {
      setDeletingId(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  const tabLabel: Record<TemplateTab, string> = {
    all: t('tabs.all'),
    approved: t('tabs.approved'),
    pending: t('tabs.pending'),
    rejected: t('tabs.rejected'),
    drafts: t('tabs.drafts'),
    paused: t('tabs.paused'),
  };
  const healthLabel: Record<TemplateHealth, string> = {
    green: t('health.green'),
    yellow: t('health.yellow'),
    red: t('health.red'),
    unknown: t('health.unknown'),
  };
  const kindLabel: Record<TemplateKind, string> = {
    standard: t('kinds.standard'),
    carousel: t('kinds.carousel'),
    authentication: t('kinds.authentication'),
    limited_time_offer: t('kinds.limited_time_offer'),
  };
  const rowAction =
    'text-muted-foreground hover:text-primary hover:bg-primary/10 h-8 px-2';

  return (
    <section className="animate-in fade-in-50 space-y-4 duration-200">
      <HeaderFor
        variant={variant}
        title={variant === 'campaigns' ? tc('title') : t('title')}
        description={variant === 'campaigns' ? tc('blurbs.templates') : t('description')}
        action={
          canEdit ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                onClick={handleSyncFromMeta}
                disabled={syncing}
                title={t('syncTitle')}
              >
                <RefreshCw className={`size-4 ${syncing ? 'animate-spin' : ''}`} />
                {syncing ? t('syncing') : t('syncFromMeta')}
              </Button>
              <Button variant="outline" onClick={() => setLibraryOpen(true)}>
                <BookOpen className="size-4" />
                {t('fromLibrary')}
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setAiKey((k) => k + 1);
                  setAiOpen(true);
                }}
              >
                <Sparkles className="size-4" />
                {t('writeWithAi')}
              </Button>
              <Button onClick={openCreate}>
                <Plus className="size-4" />
                {t('newTemplate')}
              </Button>
            </div>
          ) : undefined
        }
      />

      {templates.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <p className="text-muted-foreground text-sm">{t('noTemplates')}</p>
            <p className="text-muted-foreground text-xs mt-1">
              {t('createFirst')}
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap gap-1.5" role="tablist" aria-label={t('tabsLabel')}>
              {TEMPLATE_TABS.map((key) => (
                <Button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={tab === key}
                  size="sm"
                  variant={tab === key ? 'default' : 'outline'}
                  onClick={() => setTab(key)}
                  className="h-8 text-xs"
                >
                  {tabLabel[key]}
                  <span
                    className={cn(
                      'ml-1 rounded-full px-1.5 text-[10px] tabular-nums',
                      tab === key ? 'bg-primary-foreground/20' : 'bg-muted',
                    )}
                  >
                    {counts[key]}
                  </span>
                </Button>
              ))}
            </div>
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
            <select
              aria-label={tc('templates.category')}
              value={category}
              onChange={(e) => setCategory(e.target.value as CategoryFilter)}
              className="h-9 rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>{c === 'all' ? tc('templates.allCategories') : categoryLabel(c)}</option>
              ))}
            </select>
            <div className="relative sm:w-64">
              <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                aria-label={t('searchPlaceholder')}
                placeholder={t('searchPlaceholder')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-8 bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>
            </div>
          </div>

          {visible.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-3 py-10 text-center text-sm text-muted-foreground">
                {t('noMatches')}
                <Button variant="outline" size="sm" onClick={() => { setTab('all'); setCategory('all'); setQuery(''); }}>
                  {tc('clearFilters')}
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] gap-3">
              {visible.map((template) => {
                const statusKey = template.status || 'DRAFT';
                const status = templateStatusConfig[statusKey] ?? {
                  label: statusKey,
                  classes: '',
                };
                const health = templateHealth(template.quality_score);
                const issue = template.rejection_reason || template.submission_error;
                const local = isLocalDraft(template);
                const rowTab = templateTabOf(template.status);
                const rowActions = (
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-0.5">
                        {canEdit && !local && statusKey === 'APPROVED' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openRow(template)}
                            title={t('editTitle')}
                            aria-label={t('editLabel')}
                            className={rowAction}
                          >
                            <Pencil className="size-3.5" />
                            {t('edit')}
                          </Button>
                        )}
                        {canEdit && !local && (rowTab === 'rejected' || statusKey === 'PAUSED') && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openRow(template)}
                            title={t('resubmitTitle')}
                            aria-label={t('resubmitLabel')}
                            className={rowAction}
                          >
                            <RotateCcw className="size-3.5" />
                            {t('resubmit')}
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setHistoryFor(template)}
                          title={t('history')}
                          aria-label={t('historyAria', { name: template.name })}
                          className="text-muted-foreground hover:text-primary hover:bg-primary/10 h-8 w-8"
                        >
                          <History className="size-4" />
                        </Button>
                        <TemplateAnalyticsAction template={template} />
                        {canEdit && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => void handleDuplicate(template)}
                            disabled={duplicatingId !== null}
                            title={t('duplicate')}
                            aria-label={t('duplicateAria', { name: template.name })}
                            className="text-muted-foreground hover:text-primary hover:bg-primary/10 h-8 w-8"
                          >
                            {duplicatingId === template.id ? (
                              <Loader2 className="size-4 animate-spin" />
                            ) : (
                              <Copy className="size-4" />
                            )}
                          </Button>
                        )}
                        {canEdit && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setTemplateToDelete(template)}
                            disabled={deletingId === template.id}
                            aria-label={
                              template.meta_template_id
                                ? t('deleteMetaLocallyAria')
                                : t('deleteLocallyAria')
                            }
                            title={
                              template.meta_template_id
                                ? t('deleteMetaLocallyTitle')
                                : t('deleteLocallyTitle')
                            }
                            className="text-muted-foreground hover:text-red-400 hover:bg-red-950/30 h-8 w-8"
                          >
                            {deletingId === template.id ? (
                              <Loader2 className="size-4 animate-spin" />
                            ) : (
                              <Trash2 className="size-4" />
                            )}
                          </Button>
                        )}
                      </div>
                );
                return (
                  <Card key={template.id} className="transition-shadow duration-150 hover:shadow-md">
                    <CardContent className="flex h-full flex-col gap-3 pt-4">
                      <h3 className="break-all font-mono text-sm font-medium text-foreground">{template.name}</h3>
                      <div className="space-y-2 min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge
                            className={`text-xs border ${categoryColors[template.category] || ''}`}
                          >
                            {categoryLabel(template.category)}
                          </Badge>
                          <Badge className={`text-xs border ${status.classes}`}>
                            {status.label}
                          </Badge>
                          {template.template_kind && template.template_kind !== 'standard' && (
                            <Badge variant="outline" className="text-xs">
                              {kindLabel[template.template_kind]}
                            </Badge>
                          )}
                          {template.language && (
                            <span className="text-xs text-muted-foreground uppercase">
                              {template.language}
                            </span>
                          )}
                          {!local && (
                            <Badge
                              className={`text-[10px] border gap-1 ${healthClasses[health]}`}
                              title={t('qualityScoreTitle')}
                            >
                              <span
                                aria-hidden
                                className={`size-1.5 rounded-full ${healthDot[health]}`}
                              />
                              {t('health.label', { level: healthLabel[health] })}
                            </Badge>
                          )}
                        </div>
                        {/* The template as the customer sees it: header, body, footer and buttons in a chat bubble. */}
                        <div className="max-h-72 overflow-hidden [&_p.whitespace-pre-wrap]:line-clamp-6">
                          <TemplatePreview
                            template={{ ...(template as unknown as TemplateDraftInput), language: template.language ?? 'en_US' }}
                          />
                        </div>
                        {issue && (
                          // Clamped to two lines; the full text is on hover.
                          <div
                            className="flex items-start gap-1.5 text-xs text-red-400 bg-red-950/20 border border-red-900/40 rounded px-2 py-1.5"
                            title={issue}
                          >
                            <AlertCircle className="size-3.5 mt-0.5 shrink-0" />
                            <span className="line-clamp-2">
                              <span className="sr-only">{t('issueLabel')}: </span>
                              {issue}
                            </span>
                          </div>
                        )}
                      </div>
                      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
                        <small className="text-xs text-muted-foreground">
                          {tc('templates.counts', { variables: extractVariableIndices(template.body_text ?? '').length, buttons: (template.buttons ?? []).length })}
                        </small>
                        <div className="flex flex-wrap items-center justify-end gap-1">
                        {rowActions}
                        {statusKey === 'APPROVED' && canSend ? (
                          <Button size="sm" variant="outline" render={<Link href={`/broadcasts/new?templateId=${template.id}`} />} nativeButton={false}>
                            <Send />
                            {tc('templates.use')}
                          </Button>
                        ) : canEdit && local ? (
                          <Button size="sm" variant="outline" onClick={() => openRow(template)}>
                            <Pencil />
                            {t('editDraft')}
                          </Button>
                        ) : null}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </>
      )}

      {editor && (
        <TemplateEditorDialog
          key={editor.key}
          open={editorOpen}
          onOpenChange={setEditorOpen}
          initial={editor.initial}
          editingId={editor.editingId}
          draftId={editor.draftId}
          onRefresh={fetchTemplates}
        />
      )}

      <TemplateLibraryDialog
        open={libraryOpen}
        onOpenChange={setLibraryOpen}
        onUse={openPrefilled}
      />

      <TemplateAiDialog
        key={aiKey}
        open={aiOpen}
        onOpenChange={setAiOpen}
        defaultLanguage={defaultLanguage}
        onUse={openPrefilled}
      />

      <Dialog
        open={historyFor !== null}
        onOpenChange={(open) => {
          if (!open) setHistoryFor(null);
        }}
      >
        <DialogContent className="bg-popover border-border sm:max-w-md max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">{t('historyTitle')}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('historyDesc', { name: historyFor?.name ?? '' })}
            </DialogDescription>
          </DialogHeader>
          {historyFor && <TemplateTimeline templateId={historyFor.id} />}
        </DialogContent>
      </Dialog>

      {/* Confirm-delete dialog. Surfacing the meta_template_id case
          separately so users understand a real Meta delete is happening,
          not just a local cleanup. */}
      <Dialog
        open={templateToDelete !== null}
        onOpenChange={(open) => {
          if (!open) setTemplateToDelete(null);
        }}
      >
        <DialogContent className="bg-popover border-border sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">{t('deleteDialogTitle')}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {templateToDelete?.meta_template_id
                ? t('deleteMetaDesc', { name: templateToDelete.name })
                : t('deleteLocalDesc', { name: templateToDelete?.name || '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setTemplateToDelete(null)}
              disabled={deletingId !== null}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              onClick={confirmDelete}
              disabled={deletingId !== null}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {deletingId !== null ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('deleting')}
                </>
              ) : (
                t('delete')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
