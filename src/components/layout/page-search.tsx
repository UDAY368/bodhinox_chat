'use client';
// The one global search (Ctrl/Cmd+K): pages (client side, from the nav
// model), then contacts, orders, products and bookings from GET /api/search
// (debounced, stale requests cancelled), then "Create new" shortcuts. Arrow
// keys move across every group; Enter in the box opens the first result.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { ArrowUpRight, Plus, Search } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/hooks/use-auth';
import { useWorkspaceChannels } from '@/hooks/use-workspace-channels';
import { hasMinRole } from '@/lib/auth/roles';
import type { GlobalSearchItem, GlobalSearchResult } from '@/lib/search/global';
import { useRemoteSearch } from '@/lib/search/use-remote-search';
import { filterPages, type NavPage } from './page-search-navigation';

/** Shortest term the server is asked about (GET /api/search returns nothing below it). */
export const SERVER_SEARCH_MIN_LENGTH = 2;
export const RECORD_GROUPS = ['contacts', 'orders', 'products', 'bookings'] as const;

/**
 * "Create new" entries. None of these pages opens its create form from the
 * URL yet, so each links to the page whose "New" button creates the record
 * (broadcasts have their own /broadcasts/new page).
 */
export const CREATE_ENTRIES = [
  { key: 'contact', href: '/contacts' },
  { key: 'order', href: '/commerce/orders' },
  { key: 'product', href: '/commerce/catalogue' },
  { key: 'booking', href: '/appointments' },
  { key: 'broadcast', href: '/broadcasts/new' },
] as const;

/** The create entries whose label matches the query; all of them for an empty query. */
export function filterCreateEntries(query: string, label: (key: string) => string) {
  const search = query.trim().toLocaleLowerCase();
  return CREATE_ENTRIES.filter((entry) => label(entry.key).toLocaleLowerCase().includes(search));
}

/** The /api/search URL for a query, or null when it is too short to ask. */
export function globalSearchUrl(query: string): string | null {
  const q = query.trim();
  return q.length >= SERVER_SEARCH_MIN_LENGTH ? `/api/search?q=${encodeURIComponent(q)}` : null;
}

const rowClass =
  'hover:bg-accent focus-visible:bg-accent flex min-h-11 items-center justify-between gap-3 rounded-lg px-3 text-sm transition-colors focus-visible:outline-none';

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <li>
      <p className="text-muted-foreground px-3 pt-3 pb-1 text-xs font-medium">{label}</p>
      <ul className="space-y-0.5">{children}</ul>
    </li>
  );
}

export function PageSearch() {
  const t = useTranslations('PageSearch');
  const nav = useTranslations('Sidebar');
  const format = useFormatter();
  const pathname = usePathname();
  const { accountRole } = useAuth();
  const { data: channels } = useWorkspaceChannels();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLUListElement>(null);
  // Channel pages carry their channel's name ("Instagram · Inbox"), so two inboxes stay distinguishable.
  const groupLabel = (group: NavPage['group']) => (group === 'workspace' ? '' : nav(`groups.${group}`));
  const pages = filterPages(query, (key) => nav(key), channels?.enabled, groupLabel);
  const server = useRemoteSearch<GlobalSearchResult>(open ? globalSearchUrl(query) : null, 250);
  const records = RECORD_GROUPS.filter((group) => server.data?.[group].length);
  const canCreate = !!accountRole && hasMinRole(accountRole, 'agent');
  const creates = canCreate ? filterCreateEntries(query, (key) => t(`create.${key}`)) : [];
  const nothing = pages.length === 0 && records.length === 0 && creates.length === 0 && !server.loading && !server.error;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setQuery('');
        setOpen((current) => !current);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  function changeOpen(nextOpen: boolean) {
    setOpen(nextOpen);
    if (nextOpen) setQuery('');
  }

  const close = () => setOpen(false);
  const itemMeta = (group: (typeof RECORD_GROUPS)[number], item: GlobalSearchItem) => {
    if (!item.at) return item.subtitle;
    const when = format.dateTime(new Date(item.at), group === 'bookings' ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' });
    return item.subtitle ? `${item.subtitle} · ${when}` : when;
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger
        className="border-border bg-muted/70 text-muted-foreground hover:bg-muted flex h-9 pointer-coarse:h-11 items-center gap-2 rounded-[10px] border px-3 text-xs transition-colors"
        aria-label={t('trigger')}
      >
        <Search className="size-3.5" />
        <span className="hidden 2xl:inline">{t('trigger')}</span>
        <kbd className="border-border ml-5 hidden rounded border px-1.5 py-0.5 text-[9px] font-medium 2xl:inline">
          ⌘ / Ctrl K
        </kbd>
      </DialogTrigger>
      <DialogContent className="gap-4 rounded-2xl p-5 sm:max-w-lg" initialFocus={input}>
        <div className="pr-7">
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription className="mt-2 text-xs">{t('description')}</DialogDescription>
        </div>
        <Input
          ref={input}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('placeholder')}
          aria-label={t('trigger')}
          className="h-11"
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'Enter') {
              const first = results.current?.querySelector<HTMLAnchorElement>('a');
              if (first) {
                event.preventDefault();
                if (event.key === 'Enter') first.click();
                else first.focus();
              }
            }
          }}
        />
        <ul
          ref={results}
          aria-label={t('results')}
          aria-busy={server.loading}
          className="-mx-1 max-h-[min(60dvh,440px)] overflow-y-auto px-1"
          onKeyDown={(event) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            const links = Array.from(results.current?.querySelectorAll<HTMLAnchorElement>('a') ?? []);
            const current = links.indexOf(event.target as HTMLAnchorElement);
            if (current < 0) return;
            event.preventDefault();
            if (event.key === 'ArrowUp' && current === 0) input.current?.focus();
            else links[(current + (event.key === 'ArrowDown' ? 1 : -1)) % links.length]?.focus();
          }}
        >
          {pages.length > 0 && (
            <Group label={t('groups.pages')}>
              {pages.map((page) => (
                <li key={page.href}>
                  <Link href={page.href} aria-current={pathname === page.href ? 'page' : undefined} onClick={close} className={rowClass}>
                    <span>
                      {page.group !== 'workspace' && <span className="text-muted-foreground">{groupLabel(page.group)} · </span>}
                      {nav(page.labelKey)}
                    </span>
                    <ArrowUpRight className="text-muted-foreground size-3.5 shrink-0" />
                  </Link>
                </li>
              ))}
            </Group>
          )}
          {records.map((group) => (
            <Group key={group} label={t(`groups.${group}`)}>
              {server.data![group].map((item) => (
                <li key={item.id}>
                  <Link href={item.href} onClick={close} className={rowClass}>
                    <span className="min-w-0 flex-1 py-1.5">
                      <span className="block truncate">{item.title || t('noName')}</span>
                      {itemMeta(group, item) && (
                        <span className="text-muted-foreground block truncate text-xs">{itemMeta(group, item)}</span>
                      )}
                    </span>
                    <ArrowUpRight className="text-muted-foreground size-3.5 shrink-0" />
                  </Link>
                </li>
              ))}
            </Group>
          ))}
          {server.loading && (
            <li role="status" aria-label={t('searching')} className="space-y-1 pt-3">
              {[0, 1, 2].map((n) => (
                <div key={n} className="flex min-h-11 items-center gap-3 px-3 motion-safe:animate-pulse">
                  <div className="bg-muted h-3 flex-1 rounded" />
                  <div className="bg-muted h-3 w-12 rounded" />
                </div>
              ))}
            </li>
          )}
          {server.error && (
            <li role="alert" className="text-muted-foreground flex min-h-11 items-center justify-between gap-3 px-3 pt-3 text-sm">
              <span>{t('error')}</span>
              <button type="button" onClick={server.retry} className="text-primary hover:bg-accent min-h-11 rounded-lg px-3 font-medium">
                {t('retry')}
              </button>
            </li>
          )}
          {creates.length > 0 && (
            <Group label={t('groups.create')}>
              {creates.map((entry) => (
                <li key={entry.key}>
                  <Link href={entry.href} onClick={close} className={rowClass}>
                    <span>{t(`create.${entry.key}`)}</span>
                    <Plus className="text-muted-foreground size-3.5 shrink-0" />
                  </Link>
                </li>
              ))}
            </Group>
          )}
          {nothing && (
            <li role="status" className="text-muted-foreground px-3 py-6 text-center text-sm">
              {t('empty')}
            </li>
          )}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
