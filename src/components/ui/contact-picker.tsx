'use client';
// Pick one contact by name, number or Instagram username: a combobox over
// GET /api/contacts/search (300 ms debounce, stale requests cancelled), with
// "Load more" paging, arrow-key navigation, a clear button, and empty and
// error (Retry) states. Focusing the box lists the newest contacts.
import { useId, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, X } from 'lucide-react';

import { authFetch } from '@/lib/auth/client';
import { useRemoteSearch } from '@/lib/search/use-remote-search';
import { cn } from '@/lib/utils';

export interface PickedContact {
  id: string;
  name: string | null;
  phone: string | null;
  avatarUrl?: string | null;
}

export interface ContactPickerProps {
  value: PickedContact | null;
  onChange: (contact: PickedContact | null) => void;
  channel?: 'whatsapp' | 'instagram';
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
}

interface SearchPage {
  contacts: PickedContact[];
  nextCursor: string | null;
}

/** The search URL for a typed term (and a page cursor). */
export function contactSearchUrl(query: string, channel?: 'whatsapp' | 'instagram', cursor?: string | null): string {
  const params = new URLSearchParams();
  if (query.trim()) params.set('q', query.trim());
  if (channel) params.set('channel', channel);
  if (cursor) params.set('cursor', cursor);
  const qs = params.toString();
  return `/api/contacts/search${qs ? `?${qs}` : ''}`;
}

/** What the closed box shows for a picked contact. */
export function contactLabel(contact: PickedContact, noName: string): string {
  return contact.name || contact.phone || noName;
}

export function ContactPicker({ value, onChange, channel, placeholder, disabled, id, 'aria-label': ariaLabel }: ContactPickerProps) {
  const t = useTranslations('ContactPicker');
  const uid = useId();
  const listId = `${uid}-list`;
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  // Pages after the first, kept with the URL they extend.
  const [more, setMore] = useState<{ url: string; contacts: PickedContact[]; nextCursor: string | null } | null>(null);
  const [moreState, setMoreState] = useState<'idle' | 'loading' | 'error'>('idle');

  const url = open ? contactSearchUrl(query, channel) : null;
  const first = useRemoteSearch<SearchPage>(url);
  const extra = more && more.url === url ? more : null;
  const contacts = [...(first.data?.contacts ?? []), ...(extra?.contacts ?? [])];
  const nextCursor = extra ? extra.nextCursor : first.data?.nextCursor ?? null;

  function close() {
    setOpen(false);
    setQuery('');
    setActive(-1);
    setMoreState('idle');
  }

  function pick(contact: PickedContact) {
    onChange(contact);
    close();
  }

  async function loadMore() {
    if (!url || !nextCursor) return;
    setMoreState('loading');
    try {
      const res = await authFetch(contactSearchUrl(query, channel, nextCursor), { cache: 'no-store' });
      if (!res.ok) throw new Error(`search ${res.status}`);
      const page = (await res.json()) as SearchPage;
      setMore({ url, contacts: [...(extra?.contacts ?? []), ...page.contacts], nextCursor: page.nextCursor });
      setMoreState('idle');
    } catch {
      setMoreState('error');
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) return setOpen(true);
      if (!contacts.length) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((current) => (current + step + contacts.length) % contacts.length);
    } else if (event.key === 'Enter' && open) {
      const contact = contacts[active] ?? (contacts.length === 1 ? contacts[0] : undefined);
      if (contact) {
        event.preventDefault();
        pick(contact);
      }
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      close();
    }
  }

  // Rows and buttons in the list keep focus in the box (mouse down would blur it).
  const keepFocus = (event: MouseEvent) => event.preventDefault();
  const row = 'flex w-full min-h-9 items-center gap-3 rounded-md px-2 text-left text-sm pointer-coarse:min-h-11';

  return (
    <div className="relative">
      <input
        ref={input}
        id={id}
        type="text"
        role="combobox"
        aria-label={ariaLabel ?? t('label')}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && active >= 0 ? `${uid}-o${active}` : undefined}
        autoComplete="off"
        disabled={disabled}
        placeholder={placeholder ?? t('placeholder')}
        value={open ? query : value ? contactLabel(value, t('noName')) : ''}
        onFocus={() => setOpen(true)}
        onBlur={close}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(-1);
          setMoreState('idle');
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
        className={cn(
          'h-9 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-base outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30 pointer-coarse:h-11',
          value && 'pr-10',
        )}
      />
      {value && !disabled && (
        <button
          type="button"
          aria-label={t('clear')}
          onMouseDown={keepFocus}
          onClick={() => {
            onChange(null);
            close();
          }}
          className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted-foreground hover:text-foreground pointer-coarse:w-11"
        >
          <X className="size-4" />
        </button>
      )}
      {open && (
        <div
          className="absolute inset-x-0 top-full z-50 mt-1 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
          onMouseDown={keepFocus}
        >
          <ul id={listId} role="listbox" aria-label={t('results')} className="max-h-72 overflow-y-auto">
            {contacts.map((contact, i) => (
              <li
                key={contact.id}
                id={`${uid}-o${i}`}
                role="option"
                aria-selected={i === active}
                onClick={() => pick(contact)}
                onMouseEnter={() => setActive(i)}
                className={cn(row, 'cursor-pointer', i === active && 'bg-accent')}
              >
                <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                  {(contact.name || contact.phone || '?').charAt(0).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{contact.name || t('noName')}</span>
                  {contact.phone && <span className="block truncate text-xs text-muted-foreground tabular-nums">{contact.phone}</span>}
                </span>
              </li>
            ))}
          </ul>
          {first.loading && (
            <p role="status" className={cn(row, 'text-muted-foreground')}>
              <Loader2 className="size-4 animate-spin" aria-hidden />
              {t('loading')}
            </p>
          )}
          {!first.loading && !first.error && contacts.length === 0 && (
            <p role="status" className={cn(row, 'text-muted-foreground')}>{t('empty')}</p>
          )}
          {(first.error || moreState === 'error') && (
            <div role="alert" className={cn(row, 'justify-between text-destructive')}>
              <span>{t('error')}</span>
              <button type="button" className="min-h-9 rounded-md px-2 font-medium hover:bg-accent pointer-coarse:min-h-11"
                onClick={() => (first.error ? first.retry() : void loadMore())}>
                {t('retry')}
              </button>
            </div>
          )}
          {nextCursor && !first.loading && moreState !== 'error' && (
            <button type="button" disabled={moreState === 'loading'} onClick={() => void loadMore()}
              className={cn(row, 'justify-center font-medium text-primary hover:bg-accent')}>
              {moreState === 'loading' ? <Loader2 className="size-4 animate-spin" aria-hidden /> : t('loadMore')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
