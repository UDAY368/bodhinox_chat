'use client';

// The persistent menu of one Instagram account, edited at Instagram › Menu
// (Stage 3, 3D). Up to 20 items, each a flow the tap starts or an https link.
// Saving publishes the menu to Instagram (PUT
// /api/instagram/accounts/{id}/persistent-menu, admins); members see the list
// read-only.
// Apple's way (b7): a grouped list, a segmented control for "When tapped",
// the shared flow menu (Select), 44px row buttons, the shared loading and
// failed states, and "Remove menu" confirmed in the in-app dialog.

import { useCallback, useEffect, useState } from 'react';
import { ListTree, Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { instagramCall, jsonInit } from '@/components/instagram/comment-rules-editor';
import type { InstagramFlowSummary } from '@/components/instagram/use-instagram-flows';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { GroupedList, GroupedListRow } from '@/components/ui/grouped-list';
import { InlineError } from '@/components/ui/inline-error';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageLoading } from '@/components/ui/page-loading';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { INSTAGRAM_LIMITS, charLength, validHttpsUrl } from '@/lib/instagram/graph-limits';
import type { PersistentMenuView } from '@/lib/instagram/persistent-menu';

const MAX = INSTAGRAM_LIMITS.persistentMenuItems;
const MAX_CHARS = INSTAGRAM_LIMITS.persistentMenuTitleChars;

export interface MenuRow { type: 'postback' | 'web_url'; title: string; flowId: string; url: string }

/** The title as the server stores it (normaliseMenu in persistent-menu.ts): NFC, trimmed, inner spaces collapsed. */
export const normaliseTitle = (title: string): string => title.normalize('NFC').trim().replace(/\s+/g, ' ');

/** The first problem with the rows (a message key), or null when they can be saved. */
export function menuProblem(rows: readonly MenuRow[], flowIds: ReadonlySet<string>):
  'max' | 'title' | 'tooLong' | 'duplicate' | 'flow' | 'url' | 'size' | null {
  if (rows.length > MAX) return 'max';
  const seen = new Set<string>();
  for (const row of rows) {
    const title = normaliseTitle(row.title);
    if (!title) return 'title';
    if (charLength(title) > MAX_CHARS) return 'tooLong';
    if (seen.has(title.toLowerCase())) return 'duplicate';
    seen.add(title.toLowerCase());
    if (row.type === 'postback' && !flowIds.has(row.flowId)) return 'flow';
    if (row.type === 'web_url' && !validHttpsUrl(row.url.trim())) return 'url';
  }
  // The server refuses a list whose JSON is over MAX_MENU_BYTES (persistent-menu.ts); 4 bytes per character covers any title.
  const bytes = rows.reduce((sum, row) => sum + 60 + normaliseTitle(row.title).length * 4 + (row.type === 'web_url' ? new TextEncoder().encode(row.url.trim()).length : 36), 0);
  return bytes > 12000 ? 'size' : null;
}

export function PersistentMenuEditor({ accountId, flows, canEdit }: {
  accountId: string;
  /** The Instagram flows a menu item may start (not archived). */
  flows: InstagramFlowSummary[];
  canEdit: boolean;
}) {
  const t = useTranslations('Instagram.menu');
  const ts = useTranslations('Instagram.starters');
  const tc = useTranslations('Settings.instagram');
  const confirm = useConfirm();
  const [view, setView] = useState<PersistentMenuView | null>(null);
  const [rows, setRows] = useState<MenuRow[]>([]);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const base = `/api/instagram/accounts/${accountId}/persistent-menu`;

  const accept = (next: PersistentMenuView) => {
    setView(next);
    setRows(next.items.map((item) => item.type === 'postback'
      ? { type: 'postback', title: item.title, flowId: item.flowId, url: '' }
      : { type: 'web_url', title: item.title, flowId: '', url: item.url }));
  };

  const load = useCallback(async (isLive: () => boolean = () => true) => {
    try {
      const { ok, json } = await instagramCall(base);
      if (!isLive()) return;
      if (!ok) throw new Error('load');
      accept(json.menu as PersistentMenuView);
      setFailed(false);
    } catch {
      if (isLive()) setFailed(true);
    }
  }, [base]);

  useEffect(() => {
    let live = true;
    void load(() => live);
    return () => { live = false; };
  }, [load]);

  const flowIds = new Set(flows.map((f) => f.id));
  const problem = menuProblem(rows, flowIds);
  const unusable = new Set(view?.items.filter((i) => i.type === 'postback' && !i.flowUsable).map((i) => (i.type === 'postback' ? i.flowId : '')) ?? []);
  const update = (index: number, patch: Partial<MenuRow>) =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const send = async (next: MenuRow[], done: string) => {
    if (saving) return;
    setSaving(true);
    try {
      const { ok, json } = await instagramCall(base, jsonInit('PUT', {
        items: next.map((row) => row.type === 'postback'
          ? { type: 'postback', title: normaliseTitle(row.title), flow_id: row.flowId }
          : { type: 'web_url', title: normaliseTitle(row.title), url: row.url.trim() }),
      }));
      if (!ok) {
        toast.error(typeof json.message === 'string' ? json.message : t('saveFailed'));
        return;
      }
      accept(json.menu as PersistentMenuView);
      toast.success(done);
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  if (failed) return <InlineError message={tc('loadFailed')} onRetry={() => void load()} className="py-6" />;
  if (!view) return <PageLoading rows={2} />;

  if (!canEdit) {
    return view.items.length === 0 ? (
      <EmptyState icon={ListTree} title={t('empty')} body={t('adminOnly')} className="py-6" />
    ) : (
      <GroupedList footer={t('adminOnly')}>
        {view.items.map((item) => (
          <GroupedListRow key={item.title} title={item.title}
            subtitle={<span className={item.flowUsable ? undefined : 'text-destructive'}>
              {item.type === 'web_url' ? item.url : item.flowUsable ? item.flowName : ts('flowMissing')}
            </span>} />
        ))}
      </GroupedList>
    );
  }

  const addRow = () => setRows((current) => [...current, { type: 'postback', title: '', flowId: '', url: '' }]);
  const clear = async () => {
    if (await confirm({ title: t('clearConfirm'), confirmLabel: t('clear'), destructive: true })) void send([], t('cleared'));
  };

  return (
    <div className="space-y-3">
      {rows.length === 0 && (
        <EmptyState icon={ListTree} title={t('empty')} className="py-6"
          action={(
            <Button type="button" variant="outline" className="min-h-11 sm:min-h-8" disabled={saving} onClick={addRow}>
              <Plus className="size-4" />
              {t('add')}
            </Button>
          )} />
      )}
      {!view.managed && <p className="text-muted-foreground text-xs">{ts('replacesExisting')}</p>}
      {view.syncedAt && <p className="text-muted-foreground text-xs">{t('lastSynced', { time: new Date(view.syncedAt).toLocaleString() })}</p>}
      {rows.length > 0 && <GroupedList>{rows.map((row, index) => (
        <div key={index} className="not-first:border-separator grid grid-cols-1 gap-2 px-4 py-3 not-first:border-t sm:grid-cols-[1fr_auto_1.5fr_auto] sm:items-end">
          <div className="space-y-1">
            <Label htmlFor={`ig-menu-t-${accountId}-${index}`}>{t('itemTitle')}</Label>
            <Input id={`ig-menu-t-${accountId}-${index}`} value={row.title} maxLength={MAX_CHARS * 2}
              placeholder={t('itemTitlePlaceholder')} onChange={(e) => update(index, { title: e.target.value })} />
          </div>
          <div className="space-y-1">
            <p className="text-sm leading-none font-medium">{t('type')}</p>
            <SegmentedControl aria-label={t('type')} value={row.type}
              onValueChange={(type) => update(index, { type })}
              options={[{ value: 'postback', label: t('typeFlow') }, { value: 'web_url', label: t('typeLink') }]} />
          </div>
          {row.type === 'postback' ? (
            <div className="space-y-1">
              <Label htmlFor={`ig-menu-f-${accountId}-${index}`}>{t('flow')}</Label>
              <Select value={flowIds.has(row.flowId) ? row.flowId : ''}
                onValueChange={(v) => update(index, { flowId: typeof v === 'string' ? v : '' })}>
                <SelectTrigger id={`ig-menu-f-${accountId}-${index}`} className="min-h-11 w-full sm:min-h-8">
                  <SelectValue>{flows.find((flow) => flow.id === row.flowId)?.name ?? t('chooseFlow')}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {flows.map((flow) => <SelectItem key={flow.id} value={flow.id}>{flow.name}</SelectItem>)}
                </SelectContent>
              </Select>
              {row.flowId && (unusable.has(row.flowId) || !flowIds.has(row.flowId)) && (
                <p className="text-destructive text-xs">{ts('flowMissing')}</p>
              )}
            </div>
          ) : (
            <div className="space-y-1">
              <Label htmlFor={`ig-menu-u-${accountId}-${index}`}>{t('url')}</Label>
              <Input id={`ig-menu-u-${accountId}-${index}`} type="url" value={row.url} placeholder={t('urlPlaceholder')}
                onChange={(e) => update(index, { url: e.target.value })} />
            </div>
          )}
          <Button type="button" variant="ghost" size="icon" className="text-destructive size-11 justify-self-end" aria-label={t('remove', { n: index + 1 })}
            onClick={() => setRows((current) => current.filter((_, i) => i !== index))}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}</GroupedList>}
      {flows.length === 0 && rows.some((r) => r.type === 'postback') && <p className="text-muted-foreground text-sm">{t('noFlows')}</p>}
      {problem === 'title' && <p className="text-destructive text-xs">{t('needsTitle')}</p>}
      {problem === 'tooLong' && <p className="text-destructive text-xs">{t('titleTooLong', { max: MAX_CHARS })}</p>}
      {problem === 'duplicate' && <p className="text-destructive text-xs">{t('duplicate')}</p>}
      {problem === 'flow' && <p className="text-destructive text-xs">{t('needsFlow')}</p>}
      {problem === 'size' && <p className="text-destructive text-xs">{t('tooLarge')}</p>}
      {problem === 'url' && <p className="text-destructive text-xs">{t('badUrl')}</p>}
      {rows.length >= MAX && <p className="text-muted-foreground text-xs">{t('max', { max: MAX })}</p>}
      <div className="flex flex-wrap gap-2">
        {rows.length > 0 && (
          <Button type="button" variant="outline" className="min-h-11 sm:min-h-8" disabled={rows.length >= MAX || saving} onClick={addRow}>
            <Plus className="size-3.5" />
            {t('add')}
          </Button>
        )}
        <Button type="button" className="min-h-11 sm:min-h-8" onClick={() => void send(rows, t('saved'))} disabled={problem !== null || saving}>
          {saving && <Loader2 className="size-3.5 animate-spin" />}
          {saving ? t('saving') : t('save')}
        </Button>
        {view.managed && view.items.length > 0 && (
          <Button type="button" variant="ghost" className="text-destructive min-h-11 sm:min-h-8" disabled={saving} onClick={() => void clear()}>
            {t('clear')}
          </Button>
        )}
      </div>
    </div>
  );
}
