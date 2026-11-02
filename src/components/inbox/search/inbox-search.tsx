'use client';

// Inbox message search: a query box with number / status / assignee / date
// filters over GET /api/inbox/search. Snippets are rendered as text runs
// (search-snippet.ts markers), never as HTML. Picking a result calls
// onOpen(conversationId, messageId); the page opens the conversation and the
// thread jumps to the message with useJumpToMessage.

import { useEffect, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Loader2, Search, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { NumberSelect } from '@/components/settings/numbers/number-select';
import { useWhatsAppNumbers } from '@/components/settings/numbers/use-whatsapp-numbers';
import { splitSnippet } from '@/lib/inbox/search-snippet';
import { fetchSearchPage, type SearchFailure } from './search-request';

export interface InboxSearchProps {
  onOpen: (conversationId: string, messageId: string) => void;
}

export interface InboxSearchFilterState {
  whatsappConfigId: string | null;
  status: '' | 'open' | 'pending' | 'closed';
  assignee: '' | 'me' | 'unassigned';
  /** Local calendar dates, YYYY-MM-DD, inclusive. */
  from: string;
  to: string;
}

export interface InboxSearchHitDto {
  message_id: string;
  conversation_id: string;
  snippet: string;
  created_at: string;
  contact_name: string | null;
}

const EMPTY_FILTERS: InboxSearchFilterState = { whatsappConfigId: null, status: '', assignee: '', from: '', to: '' };
const DEBOUNCE_MS = 300;
const SELECT_CLASS = 'border-border bg-card text-foreground h-8 rounded-md border px-2 text-sm';

/** Start of a local calendar day as an ISO instant, or null for a bad date. */
export function localDayStart(date: string, addDays = 0): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + addDays);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** The API URL for a search; `to` becomes the exclusive start of the next local day. */
export function buildInboxSearchUrl(query: string, filters: InboxSearchFilterState, cursor?: string | null): string {
  const params = new URLSearchParams({ q: query });
  if (filters.whatsappConfigId) params.set('whatsapp_config_id', filters.whatsappConfigId);
  if (filters.status) params.set('status', filters.status);
  if (filters.assignee) params.set('assignee', filters.assignee);
  const from = filters.from ? localDayStart(filters.from) : null;
  const to = filters.to ? localDayStart(filters.to, 1) : null;
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (cursor) params.set('cursor', cursor);
  return `/api/inbox/search?${params.toString()}`;
}

type Status = 'idle' | 'loading' | 'ready' | 'error' | 'rate_limited';

export function InboxSearch({ onOpen }: InboxSearchProps) {
  const t = useTranslations('InboxSearch');
  const format = useFormatter();
  const { numbers } = useWhatsAppNumbers();
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<InboxSearchFilterState>(EMPTY_FILTERS);
  const [results, setResults] = useState<InboxSearchHitDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<SearchFailure | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  const trimmed = query.trim();

  async function run(nextCursor: string | null) {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoadingMore(Boolean(nextCursor));
    if (!nextCursor) setStatus('loading');
    setLoadMoreError(null);
    // A failed "Load more" keeps the results on screen and reports inline;
    // only a failed first page replaces the list with the error.
    const fail = (failure: SearchFailure) => (nextCursor ? setLoadMoreError(failure) : setStatus(failure));
    try {
      const page = await fetchSearchPage(buildInboxSearchUrl(trimmed, filters, nextCursor), controller.signal);
      if (controller.signal.aborted) return;
      if (!page.ok) {
        fail(page.failure);
        return;
      }
      setResults((prev) => (nextCursor ? [...prev, ...page.results] : page.results));
      setCursor(page.nextCursor);
      setStatus('ready');
    } catch {
      if (!controller.signal.aborted) fail('error');
    } finally {
      if (requestRef.current === controller) setLoadingMore(false);
    }
  }

  // Debounced search whenever the query or a filter changes.
  useEffect(() => {
    if (!trimmed) {
      requestRef.current?.abort();
      return;
    }
    const timer = setTimeout(() => void run(null), DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // run reads the latest query and filters from this render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trimmed, filters]);

  useEffect(() => () => requestRef.current?.abort(), []);

  const setFilter = <K extends keyof InboxSearchFilterState>(key: K, value: InboxSearchFilterState[K]) =>
    setFilters((prev) => ({ ...prev, [key]: value }));
  const filtersActive = JSON.stringify(filters) !== JSON.stringify(EMPTY_FILTERS);
  const view: Status = trimmed ? status : 'idle';

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="relative">
        <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" aria-hidden />
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('placeholder')}
          aria-label={t('placeholder')}
          maxLength={200}
          className="pl-8"
          autoFocus
        />
      </div>

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('filters')}>
        {numbers.length > 1 && (
          <NumberSelect
            numbers={numbers}
            value={filters.whatsappConfigId}
            onChange={(v) => setFilter('whatsappConfigId', v)}
            emptyLabel={t('allNumbers')}
            className={SELECT_CLASS}
          />
        )}
        <select
          aria-label={t('status')}
          value={filters.status}
          onChange={(e) => setFilter('status', e.target.value as InboxSearchFilterState['status'])}
          className={SELECT_CLASS}
        >
          <option value="">{t('anyStatus')}</option>
          <option value="open">{t('statusOpen')}</option>
          <option value="pending">{t('statusPending')}</option>
          <option value="closed">{t('statusClosed')}</option>
        </select>
        <select
          aria-label={t('assignee')}
          value={filters.assignee}
          onChange={(e) => setFilter('assignee', e.target.value as InboxSearchFilterState['assignee'])}
          className={SELECT_CLASS}
        >
          <option value="">{t('anyAssignee')}</option>
          <option value="me">{t('assignedToMe')}</option>
          <option value="unassigned">{t('unassigned')}</option>
        </select>
        <label className="text-muted-foreground flex items-center gap-1 text-xs">
          {t('from')}
          <input
            type="date"
            value={filters.from}
            max={filters.to || undefined}
            onChange={(e) => setFilter('from', e.target.value)}
            className={SELECT_CLASS}
          />
        </label>
        <label className="text-muted-foreground flex items-center gap-1 text-xs">
          {t('to')}
          <input
            type="date"
            value={filters.to}
            min={filters.from || undefined}
            onChange={(e) => setFilter('to', e.target.value)}
            className={SELECT_CLASS}
          />
        </label>
        {filtersActive && (
          <Button type="button" variant="ghost" size="sm" onClick={() => setFilters(EMPTY_FILTERS)}>
            <X className="size-3.5" aria-hidden />
            {t('clearFilters')}
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto" aria-live="polite" aria-busy={view === 'loading'}>
        {view === 'idle' && <p className="text-muted-foreground px-1 py-6 text-center text-sm">{t('hint')}</p>}
        {view === 'loading' && (
          <p className="text-muted-foreground flex items-center justify-center gap-2 py-6 text-sm">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {t('searching')}
          </p>
        )}
        {view === 'error' && <p className="text-destructive py-6 text-center text-sm">{t('failed')}</p>}
        {view === 'rate_limited' && <p className="text-destructive py-6 text-center text-sm">{t('rateLimited')}</p>}
        {view === 'ready' && results.length === 0 && (
          <p className="text-muted-foreground py-6 text-center text-sm">{t('noResults')}</p>
        )}
        {view === 'ready' && results.length > 0 && (
          <ul className="divide-border divide-y">
            {results.map((hit) => (
              <li key={hit.message_id}>
                <button
                  type="button"
                  onClick={() => onOpen(hit.conversation_id, hit.message_id)}
                  className="hover:bg-muted focus-visible:bg-muted flex w-full flex-col gap-1 rounded-md px-2 py-2 text-left outline-none"
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-medium">{hit.contact_name || t('unknownContact')}</span>
                    <time dateTime={hit.created_at} className="text-muted-foreground shrink-0 text-xs">
                      {format.dateTime(new Date(hit.created_at), { dateStyle: 'medium', timeStyle: 'short' })}
                    </time>
                  </span>
                  <span className="text-muted-foreground line-clamp-2 text-sm break-words">
                    {splitSnippet(hit.snippet).map((part, i) =>
                      part.match ? (
                        <mark key={i} className="bg-primary/15 text-foreground rounded-sm px-0.5">
                          {part.text}
                        </mark>
                      ) : (
                        <span key={i}>{part.text}</span>
                      )
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {view === 'ready' && cursor && (
          <div className="flex flex-col items-center gap-2 py-3">
            {loadMoreError && (
              <p role="alert" className="text-destructive text-center text-sm">
                {t(loadMoreError === 'rate_limited' ? 'rateLimited' : 'failed')}
              </p>
            )}
            <Button type="button" variant="outline" size="sm" disabled={loadingMore} onClick={() => void run(cursor)}>
              {loadingMore && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
              {t('loadMore')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
