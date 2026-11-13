'use client';

import { useCallback, useEffect, useState } from 'react';
import { Bookmark, BookmarkCheck, ChevronDown, Loader2, Trash2, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { authFetch } from '@/lib/auth/client';
import type { InboxScope } from '@/lib/inbox/inbox-scope';
import {
  filtersInScope,
  isDefaultInboxFilters,
  MAX_SAVED_FILTER_NAME,
  sameInboxFilters,
  viewsForScope,
  type InboxFilters,
  type SavedFilter,
} from '@/lib/inbox/saved-filters';
import { cn } from '@/lib/utils';

export type { InboxFilters } from '@/lib/inbox/saved-filters';

interface SavedFiltersMenuProps {
  /** The inbox's current filter state (with its channel), saved as-is by "Save current view". */
  current: InboxFilters;
  /** Called with a saved view's filters when the member picks it. */
  onApply: (filters: InboxFilters) => void;
  /**
   * The inbox the menu is in. A channel inbox offers its channel's views and
   * any-channel views; the All view offers every view.
   */
  scope?: InboxScope;
  /** Shared with SavedFilterChips so both show the same views; the menu loads its own without it. */
  store?: SavedFiltersStore;
  /** A square icon button (the list header); the name stays its accessible label. */
  iconOnly?: boolean;
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return typeof data?.error === 'string' ? data.error : fallback;
}

/**
 * The member's private saved inbox views: pick one to apply its filters,
 * save the current filters under a name, or delete views. Views live in
 * /api/inbox/saved-filters and are never shared with other members.
 */
export function SavedFiltersMenu({ current, onApply, scope = 'all', store, iconOnly = false }: SavedFiltersMenuProps) {
  const t = useTranslations('Inbox.savedFilters');
  const ownStore = useSavedFilters(!store);
  const { allViews, loaded, saving, deletingId, save: saveView, remove } = store ?? ownStore;
  const views = viewsForScope(allViews, scope);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState('');

  const active = views.find((view) => sameInboxFilters(filtersInScope(view.filters, scope), current)) ?? null;
  // A channel inbox's own channel is not a filter the member chose.
  const canSave = !isDefaultInboxFilters(scope === 'all' ? current : { ...current, channel: null }) && !active;
  const trimmed = name.trim();

  const openDialog = () => {
    setName('');
    setDialogOpen(true);
  };

  const save = async () => {
    if (!trimmed || saving) return;
    if (await saveView(trimmed, current)) setName('');
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={active ? `${t('views')}: ${active.name}` : t('views')}
          title={iconOnly ? (active ? `${t('views')}: ${active.name}` : t('views')) : undefined}
          className={cn(
            iconOnly
              ? 'inline-flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors duration-150'
              : 'inline-flex h-8 max-w-48 shrink-0 items-center justify-center gap-1.5 rounded-full border px-3 text-[13px] font-medium whitespace-nowrap transition-colors duration-150',
            iconOnly
              ? active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              : active ? 'bg-primary/10 text-primary border-transparent' : 'border-border text-foreground hover:bg-muted'
          )}
        >
          {active ? <BookmarkCheck className={iconOnly ? 'size-4' : 'size-3.5 shrink-0'} /> : <Bookmark className={iconOnly ? 'size-4' : 'size-3.5 shrink-0'} />}
          {!iconOnly && <span className="truncate">{active ? active.name : t('views')}</span>}
          {!iconOnly && <ChevronDown className="size-3.5 shrink-0 opacity-60" />}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="border-border bg-popover min-w-52">
          {!loaded ? (
            <div className="flex justify-center py-2">
              <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
            </div>
          ) : views.length === 0 ? (
            <p className="text-muted-foreground px-2 py-1.5 text-xs">{t('empty')}</p>
          ) : (
            views.map((view) => (
              <DropdownMenuItem
                key={view.id}
                onClick={() => onApply(filtersInScope(view.filters, scope))}
                className={cn('text-sm', active?.id === view.id ? 'text-primary' : 'text-popover-foreground')}
              >
                <span className="truncate">{view.name}</span>
              </DropdownMenuItem>
            ))
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!canSave} onClick={openDialog} className="text-sm">
            {t('saveCurrent')}
          </DropdownMenuItem>
          {views.length > 0 && (
            <DropdownMenuItem onClick={openDialog} className="text-sm">
              {t('manage')}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('dialogTitle')}</DialogTitle>
            <DialogDescription>{t('dialogDescription')}</DialogDescription>
          </DialogHeader>

          {canSave && (
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={MAX_SAVED_FILTER_NAME}
                placeholder={t('namePlaceholder')}
                aria-label={t('nameLabel')}
                autoFocus
              />
              <Button type="submit" disabled={!trimmed || saving}>
                {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                {t('save')}
              </Button>
            </form>
          )}

          {views.length > 0 && (
            <ul className="flex max-h-[40vh] flex-col gap-1 overflow-y-auto">
              {views.map((view) => (
                <li
                  key={view.id}
                  className="border-border bg-muted/40 flex items-center gap-2 rounded-md border px-2.5 py-1.5"
                >
                  <span className="min-w-0 flex-1 truncate text-sm">{view.name}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    disabled={deletingId === view.id}
                    aria-label={t('delete', { name: view.name })}
                    onClick={() => void remove(view)}
                  >
                    {deletingId === view.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
              {t('close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export interface SavedFiltersStore {
  allViews: SavedFilter[];
  loaded: boolean;
  saving: boolean;
  deletingId: string | null;
  /** Saves the filters under a name; resolves false when the server refused it. */
  save: (name: string, filters: InboxFilters) => Promise<boolean>;
  remove: (view: SavedFilter) => Promise<void>;
}

/** The member's saved views (/api/inbox/saved-filters), loaded once when `enabled`. */
export function useSavedFilters(enabled = true): SavedFiltersStore {
  const t = useTranslations('Inbox.savedFilters');
  const [allViews, setViews] = useState<SavedFilter[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await authFetch('/api/inbox/saved-filters', { cache: 'no-store' });
        const data = (await res.json().catch(() => ({}))) as { saved_filters?: SavedFilter[] };
        if (!cancelled && res.ok) setViews(data.saved_filters ?? []);
      } catch {
        // The menu still offers saving; the list simply stays empty.
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const save = useCallback(async (name: string, filters: InboxFilters) => {
    setSaving(true);
    try {
      const res = await authFetch('/api/inbox/saved-filters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, filters }),
      });
      if (!res.ok) {
        toast.error(await errorMessage(res, t('saveFailed')));
        return false;
      }
      const { saved_filter } = (await res.json()) as { saved_filter: SavedFilter };
      setViews((prev) => [...prev, saved_filter]);
      toast.success(t('saved', { name: saved_filter.name }));
      return true;
    } catch {
      toast.error(t('saveFailed'));
      return false;
    } finally {
      setSaving(false);
    }
  }, [t]);

  const remove = useCallback(async (view: SavedFilter) => {
    setDeletingId(view.id);
    try {
      const res = await authFetch(`/api/inbox/saved-filters/${encodeURIComponent(view.id)}`, { method: 'DELETE' });
      // 404 means it is already gone; drop it from the list either way.
      if (!res.ok && res.status !== 404) {
        toast.error(await errorMessage(res, t('deleteFailed')));
        return;
      }
      setViews((prev) => prev.filter((v) => v.id !== view.id));
    } catch {
      toast.error(t('deleteFailed'));
    } finally {
      setDeletingId(null);
    }
  }, [t]);

  return { allViews, loaded, saving, deletingId, save, remove };
}

/**
 * The saved views as one-tap chips under the list search: tap to apply,
 * x to delete (after a confirm). Renders nothing while there are none.
 */
export function SavedFilterChips({
  store,
  current,
  onApply,
  scope = 'all',
}: {
  store: SavedFiltersStore;
  current: InboxFilters;
  onApply: (filters: InboxFilters) => void;
  scope?: InboxScope;
}) {
  const t = useTranslations('Inbox.savedFilters');
  const [confirming, setConfirming] = useState<SavedFilter | null>(null);
  const views = viewsForScope(store.allViews, scope);
  if (views.length === 0) return null;
  return (
    <>
      <div data-saved-filter-chips aria-label={t('views')} role="group"
        className="-mx-1 flex min-w-0 gap-1.5 overflow-x-auto px-1 py-0.5 [scrollbar-width:none]">
        {views.map((view) => {
          const on = sameInboxFilters(filtersInScope(view.filters, scope), current);
          return (
            <span
              key={view.id}
              className={cn(
                'inline-flex h-7 shrink-0 items-center gap-1 rounded-full border pr-1 pl-2.5 text-xs transition-colors duration-150',
                on ? 'bg-primary/10 text-primary border-transparent' : 'border-border text-muted-foreground'
              )}
            >
              <Bookmark className="size-3 shrink-0" aria-hidden />
              <button
                type="button"
                aria-pressed={on}
                title={t('apply', { name: view.name })}
                onClick={() => onApply(filtersInScope(view.filters, scope))}
                className="hover:text-foreground max-w-36 truncate rounded focus-visible:outline-2"
              >
                {view.name}
              </button>
              <button
                type="button"
                aria-label={t('delete', { name: view.name })}
                disabled={store.deletingId === view.id}
                onClick={() => setConfirming(view)}
                className="hover:bg-muted hover:text-foreground inline-flex size-5 items-center justify-center rounded-full"
              >
                <X className="size-3" aria-hidden />
              </button>
            </span>
          );
        })}
      </div>
      <Dialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('deleteTitle')}</DialogTitle>
            <DialogDescription>{confirming ? t('deleteBody', { name: confirming.name }) : ''}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirming(null)}>{t('close')}</Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                const view = confirming;
                setConfirming(null);
                if (view) void store.remove(view);
              }}
            >
              {t('deleteConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
