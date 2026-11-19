'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';

export const SEARCH_DEBOUNCE_MS = 250;
export const SEARCH_MIN_CHARS = 2;

export interface SearchLabels { label: string; placeholder: string; submit: string; suggestions: string; noMatches: string }
interface Suggestion { id: string; name: string; category: string | null }

/**
 * The shop's search box: a plain GET form to /s/<handle>/search (works without JavaScript) with a debounced suggestion list
 * (a combobox: arrow keys move, Enter opens, Escape closes). `preview` shows the box without calling the server (the theme editor).
 */
export function ShopSearch({ handle, labels, preview = false }: { handle: string; labels: SearchLabels; preview?: boolean }) {
  const router = useRouter();
  const uid = useId();
  const listId = `${uid}-list`;
  const [value, setValue] = useState('');
  const [items, setItems] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [asked, setAsked] = useState('');
  const latest = useRef(0);

  useEffect(() => {
    const query = value.trim();
    if (preview || query.length < SEARCH_MIN_CHARS) return;
    const id = ++latest.current;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/public/store/${handle}/search?q=${encodeURIComponent(query)}`, { signal: controller.signal, credentials: 'same-origin' });
        if (!res.ok || id !== latest.current) return;
        const data = await res.json() as { suggestions?: Suggestion[] };
        setItems(Array.isArray(data.suggestions) ? data.suggestions.slice(0, 8) : []);
        setAsked(query);
        setActive(-1);
        setOpen(true);
      } catch { /* aborted or offline: the form still works */ }
    }, SEARCH_DEBOUNCE_MS);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [value, handle, preview]);

  // The list is shown only for a query long enough to have been asked (the effect leaves stale answers alone).
  const showList = open && !preview && value.trim().length >= SEARCH_MIN_CHARS;
  const go = (path: string) => { setOpen(false); router.push(path); };
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') { setOpen(false); setActive(-1); return; }
    if (!showList || !items.length) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((i) => (i + 1) % items.length); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((i) => (i <= 0 ? items.length - 1 : i - 1)); }
    else if (event.key === 'Enter' && active >= 0) { event.preventDefault(); go(`/s/${handle}/p/${items[active].id}`); }
  };

  return (
    <form role="search" action={`/s/${handle}/search`} method="get" className="relative" onSubmit={(e) => { if (preview) e.preventDefault(); }}>
      <label htmlFor={`${uid}-q`} className="sr-only">{labels.label}</label>
      <div className="flex items-center gap-2 rounded-[var(--shop-radius)] border border-black/20 bg-[var(--shop-surface)] px-3">
        <Search className="size-4 shrink-0 opacity-70" aria-hidden />
        <input id={`${uid}-q`} name="q" type="search" value={value} maxLength={60} autoComplete="off" enterKeyHint="search"
          placeholder={labels.placeholder} role="combobox" aria-expanded={showList} aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${uid}-o${active}` : undefined}
          onChange={(e) => { setValue(e.target.value); setOpen(false); }} onKeyDown={onKeyDown} onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          className="h-11 min-w-0 flex-1 bg-transparent text-base placeholder:opacity-60" />
        <button type="submit" className="h-9 shrink-0 rounded-[var(--shop-radius)] px-3 text-sm font-medium hover:bg-black/5">{labels.submit}</button>
      </div>
      <ul id={listId} role="listbox" aria-label={labels.suggestions} hidden={!showList}
        className="absolute inset-x-0 top-full z-30 mt-1 max-h-80 overflow-auto rounded-[var(--shop-radius)] bg-[var(--shop-surface)] p-1 shadow-lg ring-1 ring-black/15">
        {items.map((item, i) => (
          <li key={item.id} id={`${uid}-o${i}`} role="option" aria-selected={i === active}>
            <a href={`/s/${handle}/p/${item.id}`} tabIndex={-1} onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => { e.preventDefault(); go(`/s/${handle}/p/${item.id}`); }}
              className={`flex min-h-11 flex-col justify-center rounded-[var(--shop-radius)] px-3 py-1.5 text-sm ${i === active ? 'bg-black/10' : 'hover:bg-black/5'}`}>
              <span className="font-medium">{item.name}</span>
              {item.category && <span className="text-xs opacity-70">{item.category}</span>}
            </a>
          </li>
        ))}
      </ul>
      {showList && items.length === 0 && asked && (
        <p role="status" className="absolute inset-x-0 top-full z-30 mt-1 rounded-[var(--shop-radius)] bg-[var(--shop-surface)] px-3 py-3 text-sm shadow-lg ring-1 ring-black/15">{labels.noMatches}</p>
      )}
    </form>
  );
}
