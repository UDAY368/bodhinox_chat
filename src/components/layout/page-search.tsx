'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowUpRight, Search } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useWorkspaceChannels } from '@/hooks/use-workspace-channels';
import { filterPages, type NavPage } from './page-search-navigation';

export function PageSearch() {
  const t = useTranslations('PageSearch');
  const nav = useTranslations('Sidebar');
  const pathname = usePathname();
  const { data: channels } = useWorkspaceChannels();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLUListElement>(null);
  // Channel pages carry their channel's name ("Instagram · Inbox"), so two inboxes stay distinguishable.
  const groupLabel = (group: NavPage['group']) => (group === 'workspace' ? '' : nav(`groups.${group}`));
  const pages = filterPages(query, (key) => nav(key), channels?.enabled, groupLabel);

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

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger
        className="border-border bg-muted/70 text-muted-foreground hover:bg-muted flex h-9 items-center gap-2 rounded-[10px] border px-3 text-xs transition-colors"
        aria-label={t('trigger')}
      >
        <Search className="size-3.5" />
        <span className="hidden md:inline">{t('trigger')}</span>
        <kbd className="border-border ml-5 hidden rounded border px-1.5 py-0.5 text-[9px] font-medium sm:inline">
          ⌘ / Ctrl K
        </kbd>
      </DialogTrigger>
      <DialogContent
        className="gap-4 rounded-2xl p-5 sm:max-w-lg"
        initialFocus={input}
      >
        <div className="pr-7">
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription className="mt-2 text-xs">
            {t('description')}
          </DialogDescription>
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
              const first =
                results.current?.querySelector<HTMLAnchorElement>('a');
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
          className="max-h-[min(50dvh,360px)] space-y-1 overflow-y-auto"
          onKeyDown={(event) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            const links = Array.from(
              results.current?.querySelectorAll<HTMLAnchorElement>('a') ?? []
            );
            const current = links.indexOf(event.target as HTMLAnchorElement);
            if (current < 0) return;
            event.preventDefault();
            if (event.key === 'ArrowUp' && current === 0)
              input.current?.focus();
            else
              links[
                (current + (event.key === 'ArrowDown' ? 1 : -1)) % links.length
              ]?.focus();
          }}
        >
          {pages.map((page) => (
            <li key={page.href}>
              <Link
                href={page.href}
                aria-current={pathname === page.href ? 'page' : undefined}
                onClick={() => setOpen(false)}
                className="hover:bg-accent focus-visible:bg-accent flex min-h-11 items-center justify-between rounded-lg px-3 text-sm transition-colors focus-visible:outline-none"
              >
                <span>
                  {page.group !== 'workspace' && (
                    <span className="text-muted-foreground">{groupLabel(page.group)} · </span>
                  )}
                  {nav(page.labelKey)}
                </span>
                <ArrowUpRight className="text-muted-foreground size-3.5" />
              </Link>
            </li>
          ))}
          {pages.length === 0 && (
            <li
              role="status"
              className="text-muted-foreground px-3 py-6 text-center text-sm"
            >
              {t('empty')}
            </li>
          )}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
