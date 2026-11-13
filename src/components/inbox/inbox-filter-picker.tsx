'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { Check, Plus, Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export interface FilterOption {
  id: string;
  label: string;
  /** A small leading mark (a tag colour dot). */
  mark?: ReactNode;
  /** A sub-heading the option sits under inside its category. */
  section?: string;
  /** Muted text at the end of the row (a count). */
  hint?: string;
  /** The "any" choice that turns the category off; it does not count as a filter. */
  reset?: boolean;
  selected: boolean;
  onSelect: () => void;
}

export interface FilterCategory {
  id: string;
  label: string;
  icon: ReactNode;
  /** Several options can be on at once (tags); picking one keeps the picker open. */
  multi?: boolean;
  options: FilterOption[];
}

/**
 * "+ Filter": a two-pane picker (categories on the left, their options on the
 * right) with one search box across every option. Each option calls its own
 * handler, so the picker holds no filter state of its own.
 */
export function InboxFilterPicker({ categories, activeCount }: { categories: FilterCategory[]; activeCount: number }) {
  const t = useTranslations('Inbox.conversationList');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const category = categories.find((c) => c.id === picked) ?? categories[0];

  const q = query.trim().toLowerCase();
  const matches = useMemo(
    () =>
      q
        ? categories.flatMap((c) =>
            c.options.filter((o) => o.label.toLowerCase().includes(q)).map((o) => ({ ...o, section: c.label, multi: c.multi }))
          )
        : null,
    [categories, q]
  );

  const choose = (option: FilterOption, multi?: boolean) => {
    option.onSelect();
    if (!multi) setOpen(false);
  };

  const list = matches ?? category?.options.map((o) => ({ ...o, multi: category.multi })) ?? [];

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <PopoverTrigger
        data-filter-picker
        className={cn(
          'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium whitespace-nowrap transition-colors duration-150',
          activeCount > 0
            ? 'bg-primary/10 text-primary border-transparent'
            : 'border-border text-foreground hover:bg-muted'
        )}
      >
        <Plus className="size-3.5" aria-hidden />
        {t('addFilter')}
        {activeCount > 0 && (
          <span className="bg-primary text-primary-foreground flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold tabular-nums">
            {activeCount}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={8} className="w-[min(30rem,calc(100vw-2rem))] gap-0 overflow-hidden rounded-2xl p-0">
        <div className="border-border border-b p-2">
          <div className="relative">
            <Search className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" aria-hidden />
            <input
              type="search"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('filterSearch')}
              aria-label={t('filterSearch')}
              className="bg-muted text-foreground placeholder:text-muted-foreground focus-visible:ring-ring/40 h-9 w-full rounded-xl pr-3 pl-9 text-sm outline-none focus-visible:ring-2"
            />
          </div>
        </div>
        <div className="flex h-72">
          {!matches && (
            <ul className="border-border w-40 shrink-0 space-y-0.5 overflow-y-auto border-r p-1.5 sm:w-44">
              {categories.map((c) => {
                const on = c.id === category?.id;
                const count = c.options.filter((o) => o.selected && !o.reset).length;
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() => setPicked(c.id)}
                      className={cn(
                        'flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] transition-colors duration-150',
                        on ? 'bg-muted text-foreground font-semibold' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                      )}
                    >
                      <span className="shrink-0 [&_svg]:size-4" aria-hidden>{c.icon}</span>
                      <span className="min-w-0 flex-1 truncate">{c.label}</span>
                      {count > 0 && <span className="bg-primary size-1.5 shrink-0 rounded-full" aria-hidden />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <ul className="min-w-0 flex-1 overflow-y-auto p-1.5">
            {list.length === 0 && <li className="text-muted-foreground px-3 py-6 text-center text-sm">{t('noFilterMatches')}</li>}
            {list.map((option, index) => (
              <li key={`${option.section ?? ''}-${option.id}`}>
                {option.section && option.section !== list[index - 1]?.section && (
                  <p className="text-muted-foreground px-2.5 pt-2 pb-1 text-[11px] font-medium">{option.section}</p>
                )}
                <button
                  type="button"
                  aria-pressed={option.selected}
                  onClick={() => choose(option, option.multi)}
                  className={cn(
                    'flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] transition-colors duration-150',
                    option.selected ? 'text-primary font-medium' : 'text-foreground hover:bg-muted'
                  )}
                >
                  {option.mark}
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {option.hint && <span className="text-muted-foreground text-xs tabular-nums">{option.hint}</span>}
                  {option.selected && <Check className="size-4 shrink-0" aria-hidden />}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </PopoverContent>
    </Popover>
  );
}
