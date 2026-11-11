'use client';

// The persistent menu of one Instagram account, edited at Instagram › Menu
// (Stage 3, 3D). Up to 20 items, each a flow the tap starts or an https link.
// Saving publishes the menu to Instagram (PUT
// /api/instagram/accounts/{id}/persistent-menu, admins); members see the list
// read-only.

import { useEffect, useState } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { instagramCall, jsonInit } from '@/components/instagram/comment-rules-editor';
import type { InstagramFlowSummary } from '@/components/instagram/use-instagram-flows';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { INSTAGRAM_LIMITS, charLength, validHttpsUrl } from '@/lib/instagram/graph-limits';
import type { PersistentMenuView } from '@/lib/instagram/persistent-menu';

const MAX = INSTAGRAM_LIMITS.persistentMenuItems;
const MAX_CHARS = INSTAGRAM_LIMITS.persistentMenuTitleChars;

export interface MenuRow { type: 'postback' | 'web_url'; title: string; flowId: string; url: string }

/** The title as the server stores it (normaliseMenu in persistent-menu.ts): NFC, trimmed, inner spaces collapsed. */
export const normaliseTitle = (title: string): string => title.normalize('NFC').trim().replace(/\s+/g, ' ');

/** The first problem with the rows (a message key), or null when they can be saved. */
export function menuProblem(rows: readonly MenuRow[], flowIds: ReadonlySet<string>):
  'max' | 'title' | 'tooLong' | 'duplicate' | 'flow' | 'url' | null {
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
  return null;
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

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const { ok, json } = await instagramCall(base);
        if (!live) return;
        if (!ok) throw new Error('load');
        accept(json.menu as PersistentMenuView);
      } catch {
        if (live) setFailed(true);
      }
    })();
    return () => { live = false; };
  }, [base]);

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

  if (failed) return <p className="text-destructive text-sm">{tc('loadFailed')}</p>;
  if (!view) return <Loader2 className="text-muted-foreground size-4 animate-spin" aria-label={tc('loading')} />;

  if (!canEdit) {
    return (
      <div className="space-y-2">
        {view.items.length === 0 && <p className="text-muted-foreground text-sm">{t('empty')}</p>}
        <ul className="space-y-1 text-sm">
          {view.items.map((item) => (
            <li key={item.title} className="bg-muted/40 rounded-md p-2">
              <p className="text-foreground">{item.title}</p>
              <p className={item.flowUsable ? 'text-muted-foreground text-xs' : 'text-destructive text-xs'}>
                {item.type === 'web_url' ? item.url : item.flowUsable ? item.flowName : ts('flowMissing')}
              </p>
            </li>
          ))}
        </ul>
        <p className="text-muted-foreground text-xs">{t('adminOnly')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {rows.length === 0 && <p className="text-muted-foreground text-sm">{t('empty')}</p>}
      {!view.managed && <p className="text-muted-foreground text-xs">{ts('replacesExisting')}</p>}
      {view.syncedAt && <p className="text-muted-foreground text-xs">{t('lastSynced', { time: new Date(view.syncedAt).toLocaleString() })}</p>}
      {rows.map((row, index) => (
        <div key={index} className="grid gap-2 rounded-md border p-3 sm:grid-cols-[1fr_1fr_1.5fr_auto] sm:items-end">
          <div className="space-y-1">
            <Label htmlFor={`ig-menu-t-${accountId}-${index}`}>{t('itemTitle')}</Label>
            <Input id={`ig-menu-t-${accountId}-${index}`} value={row.title} maxLength={MAX_CHARS * 2}
              placeholder={t('itemTitlePlaceholder')} onChange={(e) => update(index, { title: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`ig-menu-k-${accountId}-${index}`}>{t('type')}</Label>
            <select id={`ig-menu-k-${accountId}-${index}`} value={row.type}
              onChange={(e) => update(index, { type: e.target.value === 'web_url' ? 'web_url' : 'postback' })}
              className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm">
              <option value="postback">{t('typeFlow')}</option>
              <option value="web_url">{t('typeLink')}</option>
            </select>
          </div>
          {row.type === 'postback' ? (
            <div className="space-y-1">
              <Label htmlFor={`ig-menu-f-${accountId}-${index}`}>{t('flow')}</Label>
              <select id={`ig-menu-f-${accountId}-${index}`} value={flowIds.has(row.flowId) ? row.flowId : ''}
                onChange={(e) => update(index, { flowId: e.target.value })}
                className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm">
                <option value="">{t('chooseFlow')}</option>
                {flows.map((flow) => <option key={flow.id} value={flow.id}>{flow.name}</option>)}
              </select>
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
          <Button type="button" variant="ghost" size="sm" aria-label={t('remove', { n: index + 1 })}
            onClick={() => setRows((current) => current.filter((_, i) => i !== index))}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}
      {flows.length === 0 && rows.some((r) => r.type === 'postback') && <p className="text-muted-foreground text-sm">{t('noFlows')}</p>}
      {problem === 'title' && <p className="text-destructive text-xs">{t('needsTitle')}</p>}
      {problem === 'tooLong' && <p className="text-destructive text-xs">{t('titleTooLong', { max: MAX_CHARS })}</p>}
      {problem === 'duplicate' && <p className="text-destructive text-xs">{t('duplicate')}</p>}
      {problem === 'flow' && <p className="text-destructive text-xs">{t('needsFlow')}</p>}
      {problem === 'url' && <p className="text-destructive text-xs">{t('badUrl')}</p>}
      {rows.length >= MAX && <p className="text-muted-foreground text-xs">{t('max', { max: MAX })}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" disabled={rows.length >= MAX || saving}
          onClick={() => setRows((current) => [...current, { type: 'postback', title: '', flowId: '', url: '' }])}>
          <Plus className="size-3.5" />
          {t('add')}
        </Button>
        <Button type="button" size="sm" onClick={() => void send(rows, t('saved'))} disabled={problem !== null || saving}>
          {saving && <Loader2 className="size-3.5 animate-spin" />}
          {saving ? t('saving') : t('save')}
        </Button>
        {view.managed && view.items.length > 0 && (
          <Button type="button" variant="outline" size="sm" disabled={saving}
            onClick={() => { if (window.confirm(t('clearConfirm'))) void send([], t('cleared')); }}>
            {t('clear')}
          </Button>
        )}
      </div>
    </div>
  );
}
