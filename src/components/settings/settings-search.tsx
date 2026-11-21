'use client';

import { useId, useMemo, useState, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronRight, Search } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  relatedSettings,
  searchSettings,
  type SettingsIndexEntry,
  type SettingsIndexSection,
} from '@/lib/settings/settings-index';

/** The on-screen title of an index entry, in the interface language. */
function useEntryLabel() {
  const t = useTranslations('SettingsSearch.entries');
  return (entry: SettingsIndexEntry) => (t.has(entry.id) ? t(entry.id) : entry.title);
}

/**
 * The search box at the top of Settings: filters sections and individual
 * settings by name and keywords (client-side, over SETTINGS_INDEX). Arrow keys
 * move through the results, Enter opens one, Escape clears.
 */
export function SettingsSearch({ entries, onOpen }: {
  /** The entries this viewer may open. */
  entries: readonly SettingsIndexEntry[];
  onOpen: (entry: SettingsIndexEntry) => void;
}) {
  const t = useTranslations('SettingsSearch');
  const label = useEntryLabel();
  const listId = useId();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const results = useMemo(() => searchSettings(query, { entries, label }), [query, entries, label]);
  const open = query.trim().length > 0;
  const sectionOf = (entry: SettingsIndexEntry) => {
    const parent = entries.find((e) => e.kind === 'section' && e.id === entry.section);
    return parent && parent.id !== entry.id ? label(parent) : null;
  };

  const choose = (entry: SettingsIndexEntry | undefined) => {
    if (!entry) return;
    setQuery('');
    setActive(0);
    onOpen(entry);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && results.length) {
      event.preventDefault();
      setActive((i) => (i + 1) % results.length);
    } else if (event.key === 'ArrowUp' && results.length) {
      event.preventDefault();
      setActive((i) => (i - 1 + results.length) % results.length);
    } else if (event.key === 'Enter' && open) {
      event.preventDefault();
      choose(results[active]);
    } else if (event.key === 'Escape') {
      setQuery('');
      setActive(0);
    }
  };

  return (
    <div className="relative w-full sm:max-w-sm">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <Input
        type="search"
        role="combobox"
        aria-label={t('label')}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && results[active] ? `${listId}-${results[active].id}` : undefined}
        placeholder={t('placeholder')}
        value={query}
        onChange={(e) => { setQuery(e.target.value); setActive(0); }}
        onKeyDown={onKeyDown}
        className="h-11 pl-9 sm:h-9"
      />
      {open && (
        <div className="absolute inset-x-0 top-full z-30 mt-1 overflow-hidden rounded-xl border border-border bg-popover shadow-lg">
          {results.length ? (
            <ul id={listId} role="listbox" aria-label={t('label')} className="max-h-80 overflow-y-auto py-1">
              {results.map((entry, i) => {
                const parent = sectionOf(entry);
                return (
                  <li
                    key={entry.id}
                    id={`${listId}-${entry.id}`}
                    role="option"
                    aria-selected={i === active}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => choose(entry)}
                    className={cn('flex min-h-11 cursor-pointer items-center gap-2 px-3 py-2 text-sm', i === active ? 'bg-muted text-foreground' : 'text-foreground')}
                  >
                    <span className="min-w-0 flex-1 truncate">{label(entry)}</span>
                    {parent ? <span className="shrink-0 text-xs text-muted-foreground">{parent}</span> : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p id={listId} role="status" className="px-3 py-3 text-sm text-muted-foreground">{t('noResults')}</p>
          )}
        </div>
      )}
    </div>
  );
}

/** The short "Related" row a settings section shows, linking to related sections and settings. */
export function RelatedSettings({ section, canOpen, onOpen }: {
  section: SettingsIndexSection;
  canOpen: (entry: SettingsIndexEntry) => boolean;
  onOpen: (entry: SettingsIndexEntry) => void;
}) {
  const t = useTranslations('SettingsSearch');
  const label = useEntryLabel();
  const related = relatedSettings(section, canOpen);
  if (!related.length) return null;
  return (
    <nav aria-label={t('related')} className="mb-6 flex flex-wrap items-center gap-x-1 gap-y-1 text-sm">
      <span className="mr-1 text-muted-foreground">{t('related')}</span>
      {related.map((entry) => (
        <button
          key={entry.id}
          type="button"
          onClick={() => onOpen(entry)}
          className="inline-flex min-h-11 items-center gap-0.5 rounded-full px-2 text-primary hover:bg-muted sm:min-h-8"
        >
          {label(entry)}
          <ChevronRight className="size-3.5" aria-hidden />
        </button>
      ))}
    </nav>
  );
}
