'use client';

// The Contacts page header shared by its three tabs (People, Segments, Custom
// fields): title, the tab's actions and the tabs with their counts. Every tab
// is its own URL, so the browser's back button and links work.
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { authFetch } from '@/lib/auth/client';
import { cn } from '@/lib/utils';

export type ContactsTab = 'people' | 'segments' | 'fields';

interface Counts { people: number | null; segments: number | null; fields: number | null }

/** The three tab counts; a tab passes the count it already knows to skip a request. */
function useCounts(known: Partial<Counts>, refreshKey: number): Counts {
  const [counts, setCounts] = useState<Counts>({ people: null, segments: null, fields: null });
  useEffect(() => {
    let live = true;
    const read = async <T,>(url: string, pick: (body: T) => number) => {
      const res = await authFetch(url, { cache: 'no-store' }).catch(() => null);
      return res?.ok ? pick((await res.json()) as T) : null;
    };
    void Promise.all([
      read<{ total: number }>('/api/contacts/bulk/view?limit=1', (b) => b.total),
      read<{ segments: unknown[] }>('/api/segments', (b) => b.segments.length),
      read<{ fields: unknown[] }>('/api/custom-fields', (b) => b.fields.length),
    ]).then(([people, segments, fields]) => {
      if (live) setCounts({ people, segments, fields });
    });
    return () => {
      live = false;
    };
  }, [refreshKey]);
  return {
    people: known.people ?? counts.people,
    segments: known.segments ?? counts.segments,
    fields: known.fields ?? counts.fields,
  };
}

export function ContactsHeader({
  tab,
  actions,
  known = {},
  refreshKey = 0,
}: {
  tab: ContactsTab;
  actions?: ReactNode;
  known?: Partial<Counts>;
  /** Changes when a tab added or removed something, so the counts reload. */
  refreshKey?: number;
}) {
  const t = useTranslations('Contacts.redesign');
  const counts = useCounts(known, refreshKey);
  const tabs: { id: ContactsTab; href: string; label: string; count: number | null }[] = [
    { id: 'people', href: '/contacts', label: t('tabs.people'), count: counts.people },
    { id: 'segments', href: '/contacts/segments', label: t('tabs.segments'), count: counts.segments },
    { id: 'fields', href: '/contacts/fields', label: t('tabs.fields'), count: counts.fields },
  ];
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-[22px] font-bold tracking-tight text-foreground">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        {actions && <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <nav aria-label={t('tabs.label')} className="-mx-1 overflow-x-auto px-1 [scrollbar-width:none]">
        <ul className="inline-flex min-w-max gap-0.5 rounded-xl bg-muted p-[3px]">
          {tabs.map((item) => {
            const active = item.id === tab;
            return (
              <li key={item.id}>
                <Link
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex h-8 items-center gap-1.5 rounded-[9px] px-3.5 text-[13px] font-medium whitespace-nowrap transition-[background-color,color,box-shadow] duration-150 focus-visible:outline-2 focus-visible:outline-primary',
                    active
                      ? 'bg-card text-foreground shadow-[0_1px_3px_rgb(0_0_0/0.12)] dark:bg-[#3a3a3e]'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {item.label}
                  {item.count !== null && <span className="text-xs font-normal tabular-nums text-muted-foreground">{item.count}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
