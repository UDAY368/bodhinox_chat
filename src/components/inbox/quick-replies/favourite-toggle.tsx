'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Star } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { authFetch } from '@/lib/auth/client';
import { sortFavouritesFirst } from '@/lib/inbox/quick-reply-favourites';
import { cn } from '@/lib/utils';

export { sortFavouritesFirst } from '@/lib/inbox/quick-reply-favourites';

/**
 * The member's favourite quick replies. Loads once (or whenever `enabled`
 * turns true, e.g. when the picker opens) and stars/unstars optimistically,
 * reverting if the server refuses.
 */
export function useQuickReplyFavourites(enabled = true) {
  const t = useTranslations('Inbox.quickReplyFavourites');
  const [favourites, setFavourites] = useState<ReadonlySet<string>>(() => new Set());
  const [loading, setLoading] = useState(false);
  const pending = useRef(new Set<string>());

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const res = await authFetch('/api/quick-replies/favourites', { cache: 'no-store' });
        const data = (await res.json().catch(() => ({}))) as { quick_reply_ids?: string[] };
        if (!cancelled && res.ok) setFavourites(new Set(data.quick_reply_ids ?? []));
      } catch {
        // Without favourites the list keeps its normal order.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const setFavourite = useCallback(async (quickReplyId: string, favourite: boolean) => {
    if (pending.current.has(quickReplyId)) return;
    pending.current.add(quickReplyId);
    const apply = (value: boolean) =>
      setFavourites((prev) => {
        const next = new Set(prev);
        if (value) next.add(quickReplyId);
        else next.delete(quickReplyId);
        return next;
      });
    apply(favourite);
    try {
      const res = await authFetch('/api/quick-replies/favourites', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quick_reply_id: quickReplyId, favourite }),
      });
      if (!res.ok) {
        apply(!favourite);
        const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
        toast.error(typeof data?.error === 'string' ? data.error : t('failed'));
      }
    } catch {
      apply(!favourite);
      toast.error(t('failed'));
    } finally {
      pending.current.delete(quickReplyId);
    }
  }, [t]);

  return { favourites, loading, setFavourite };
}

/** Sorts `items` with the member's favourites first; a memoised convenience. */
export function useFavouritesFirst<T extends { id: string }>(
  items: readonly T[],
  favourites: ReadonlySet<string>
): T[] {
  return useMemo(() => sortFavouritesFirst(items, favourites), [items, favourites]);
}

interface FavouriteToggleProps {
  /** Whether this quick reply is currently one of the member's favourites. */
  favourite: boolean;
  /** The quick reply's title, for the accessible label. */
  title: string;
  /** Called with the new value; the caller (normally useQuickReplyFavourites().setFavourite) persists it. */
  onToggle: (favourite: boolean) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * Star button for one quick reply. Render it beside (not inside) the row's
 * pick button so the two controls stay separate for keyboard and screen
 * reader users.
 */
export function FavouriteToggle({ favourite, title, onToggle, disabled, className }: FavouriteToggleProps) {
  const t = useTranslations('Inbox.quickReplyFavourites');
  return (
    <button
      type="button"
      aria-pressed={favourite}
      aria-label={favourite ? t('remove', { title }) : t('add', { title })}
      title={favourite ? t('removeShort') : t('addShort')}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onToggle(!favourite);
      }}
      className={cn(
        'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-muted disabled:opacity-50',
        favourite ? 'text-amber-500' : 'text-muted-foreground hover:text-foreground',
        className
      )}
    >
      <Star className={cn('h-4 w-4', favourite && 'fill-current')} />
    </button>
  );
}
