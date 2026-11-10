'use client';

import { useCallback, useEffect, useState } from 'react';
import { Bookmark, BookmarkCheck, ChevronDown, Loader2, Trash2 } from 'lucide-react';
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
export function SavedFiltersMenu({ current, onApply, scope = 'all' }: SavedFiltersMenuProps) {
  const t = useTranslations('Inbox.savedFilters');
  const [allViews, setViews] = useState<SavedFilter[]>([]);
  const views = viewsForScope(allViews, scope);
  const [loaded, setLoaded] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
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
  }, []);

  const active = views.find((view) => sameInboxFilters(filtersInScope(view.filters, scope), current)) ?? null;
  // A channel inbox's own channel is not a filter the member chose.
  const canSave = !isDefaultInboxFilters(scope === 'all' ? current : { ...current, channel: null }) && !active;
  const trimmed = name.trim();

  const openDialog = useCallback(() => {
    setName('');
    setDialogOpen(true);
  }, []);

  const save = async () => {
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      const res = await authFetch('/api/inbox/saved-filters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed, filters: current }),
      });
      if (!res.ok) {
        toast.error(await errorMessage(res, t('saveFailed')));
        return;
      }
      const { saved_filter } = (await res.json()) as { saved_filter: SavedFilter };
      setViews((prev) => [...prev, saved_filter]);
      setName('');
      toast.success(t('saved', { name: saved_filter.name }));
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (view: SavedFilter) => {
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
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={active ? `${t('views')}: ${active.name}` : t('views')}
          className={cn(
            'hover:bg-muted inline-flex h-7 max-w-40 items-center justify-center gap-1 rounded-md px-2 text-xs',
            active ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {active ? <BookmarkCheck className="h-3 w-3 shrink-0" /> : <Bookmark className="h-3 w-3 shrink-0" />}
          <span className="truncate">{active ? active.name : t('views')}</span>
          <ChevronDown className="h-3 w-3 shrink-0" />
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
