'use client';

import type { KeyboardEvent } from 'react';

import { cn } from '@/lib/utils';

/**
 * A segmented tab switch for a settings section's sub-pages (Channels:
 * Overview | WhatsApp | Instagram). Each tab is a URL (?tab=), so the caller
 * navigates; arrow keys move between tabs.
 */
export function SectionTabsBar<T extends string>({ label, tabs, active, onSelect, idPrefix }: {
  label: string;
  tabs: { id: T; label: string }[];
  active: T;
  onSelect: (id: T) => void;
  idPrefix: string;
}) {
  const onKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    onSelect(next.id);
    document.getElementById(`${idPrefix}-${next.id}`)?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className="mb-6 inline-flex max-w-full gap-1 overflow-x-auto rounded-lg border border-border bg-muted/60 p-1">
      {tabs.map((tab, index) => {
        const on = tab.id === active;
        return (
          <button
            key={tab.id}
            id={`${idPrefix}-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onSelect(tab.id)}
            onKeyDown={(event) => onKey(event, index)}
            className={cn(
              'inline-flex min-h-8 shrink-0 items-center rounded-md px-3 text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              on ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
