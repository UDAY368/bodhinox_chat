'use client';

/**
 * AI Agents → Activity (admins and owners): what the WhatsApp auto-reply
 * agent did with each customer message, newest first (GET /api/ai/activity).
 * Filters by outcome, reason and period; "Load more" follows the server
 * cursor. A row opens the full entry (GET /api/ai/activity/[id]) with the
 * customer's message, the reply, the knowledge used, flags and numbers.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { History, Loader2 } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { authFetch } from '@/lib/auth/client';
import {
  ALL_REPLY_EVENT_REASONS, REPLY_EVENT_OUTCOMES, REPLY_EVENT_REASONS, type ReplyEventOutcome,
} from '@/lib/ai/reply-event-codes';
import { cn } from '@/lib/utils';

interface Contact { id: string; name: string | null; phone: string | null }
export interface ActivityEvent {
  id: string;
  created_at: string;
  conversation_id: string | null;
  contact: Contact | null;
  outcome: ReplyEventOutcome;
  reason: string;
  preview: string | null;
  has_reply: boolean;
  model: string | null;
  total_tokens: number;
  latency_ms: number | null;
}
export interface ActivityDetail extends Omit<ActivityEvent, 'preview' | 'has_reply'> {
  customer_text: string | null;
  reply_text: string | null;
  sources: { document_id: string; title: string | null }[];
  confidence: number | null;
  guard_flags: string[];
  provider: string | null;
  prompt_tokens: number;
  completion_tokens: number;
}
interface Page { events: ActivityEvent[]; next_cursor: string | null }

const ANY = 'any';
const RANGES = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 } as const;
type Range = keyof typeof RANGES;
export interface Filters { outcome: string; reason: string; range: Range }
const DEFAULT_FILTERS: Filters = { outcome: ANY, reason: ANY, range: '7d' };

const OUTCOME_STYLE: Record<ReplyEventOutcome, string> = {
  replied: 'border-transparent bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  handed_off: 'border-transparent bg-amber-500/10 text-amber-700 dark:text-amber-300',
  skipped: 'border-transparent bg-muted text-muted-foreground',
  error: 'border-transparent bg-destructive/10 text-destructive',
};
const KNOWN_REASONS = new Set<string>(ALL_REPLY_EVENT_REASONS);

function queryFor(filters: Filters, cursor: string | null): string {
  const params = new URLSearchParams();
  if (filters.outcome !== ANY) params.set('outcome', filters.outcome);
  if (filters.reason !== ANY) params.set('reason', filters.reason);
  params.set('from', new Date(Date.now() - RANGES[filters.range] * 24 * 60 * 60_000).toISOString());
  if (cursor) params.set('cursor', cursor);
  return params.toString();
}

export interface ActivityState { events: ActivityEvent[]; cursor: string | null; loading: boolean; failed: boolean }
export const INITIAL_ACTIVITY_STATE: ActivityState = { events: [], cursor: null, loading: true, failed: false };

/**
 * Loads pages into the state. Only the newest request may change it, so a
 * slower response for an earlier filter, or a "Load more" started before
 * the filters changed, never lands under the current filters.
 */
export function createActivityLoader(update: (next: (state: ActivityState) => ActivityState) => void) {
  let latest = 0;
  return async (filters: Filters, after: string | null): Promise<void> => {
    const request = ++latest;
    update((state) => ({ ...state, loading: true }));
    try {
      const res = await authFetch(`/api/ai/activity?${queryFor(filters, after)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error('load_failed');
      const page = (await res.json()) as Page;
      if (request !== latest) return;
      update((state) => ({
        events: after ? [...state.events, ...page.events] : page.events,
        cursor: page.next_cursor, loading: false, failed: false,
      }));
    } catch {
      if (request === latest) update((state) => ({ ...state, loading: false, failed: true }));
    }
  };
}

function useActivityLabels() {
  const t = useTranslations('Agents.activity');
  return {
    reasonLabel: (code: string) => (KNOWN_REASONS.has(code) ? t(`reasons.${code}`) : t('unknownReason', { code })),
    contactLabel: (contact: Contact | null) => contact?.name || contact?.phone || t('unknownContact'),
  };
}

export function AiActivity() {
  const t = useTranslations('Agents.activity');
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [state, setState] = useState<ActivityState>(INITIAL_ACTIVITY_STATE);
  const [load] = useState(() => createActivityLoader(setState));
  const [openId, setOpenId] = useState<string | null>(null);
  const { reasonLabel } = useActivityLabels();

  useEffect(() => {
    void load(filters, null);
  }, [filters, load]);

  const reasonOptions: readonly string[] = filters.outcome === ANY
    ? ALL_REPLY_EVENT_REASONS
    : REPLY_EVENT_REASONS[filters.outcome as ReplyEventOutcome];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-[15px] font-semibold">
          <History className="h-4 w-4 text-primary" /> {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="ai-activity-outcome">{t('outcome')}</Label>
            <Select
              value={filters.outcome}
              onValueChange={(v) => setFilters((f) => ({ ...f, outcome: v ?? ANY, reason: ANY }))}
            >
              <SelectTrigger id="ai-activity-outcome" className="w-full">
                <SelectValue>{(v: string) => (v === ANY ? t('anyOutcome') : t(`outcomes.${v}`))}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>{t('anyOutcome')}</SelectItem>
                {REPLY_EVENT_OUTCOMES.map((o) => <SelectItem key={o} value={o}>{t(`outcomes.${o}`)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="ai-activity-reason">{t('reason')}</Label>
            <Select value={filters.reason} onValueChange={(v) => setFilters((f) => ({ ...f, reason: v ?? ANY }))}>
              <SelectTrigger id="ai-activity-reason" className="w-full">
                <SelectValue>{(v: string) => (v === ANY ? t('anyReason') : reasonLabel(v))}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>{t('anyReason')}</SelectItem>
                {reasonOptions.map((r) => <SelectItem key={r} value={r}>{reasonLabel(r)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="ai-activity-range">{t('period')}</Label>
            <Select value={filters.range} onValueChange={(v) => setFilters((f) => ({ ...f, range: (v as Range) ?? '7d' }))}>
              <SelectTrigger id="ai-activity-range" className="w-full">
                <SelectValue>{(v: string) => t(`range${v}`)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(RANGES) as Range[]).map((r) => <SelectItem key={r} value={r}>{t(`range${r}`)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>

        <ActivityResults
          state={state}
          onRetry={() => load(filters, null)}
          onLoadMore={() => load(filters, state.cursor)}
          onOpen={setOpenId}
        />
      </CardContent>
      <ActivityDetailDialog id={openId} onClose={() => setOpenId(null)} />
    </Card>
  );
}

/** The list with its error, empty, loading and "Load more" states. */
export function ActivityResults({ state, onRetry, onLoadMore, onOpen }: {
  state: ActivityState;
  onRetry: () => void;
  onLoadMore: () => void;
  onOpen: (id: string) => void;
}) {
  const t = useTranslations('Agents.activity');
  const format = useFormatter();
  const { reasonLabel, contactLabel } = useActivityLabels();
  const { events, cursor, loading, failed } = state;

  return (
    <>
      {failed ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg bg-destructive/10 px-3 py-2">
          <p role="alert" className="text-sm text-destructive">{t('loadFailed')}</p>
          <Button type="button" size="sm" variant="outline" onClick={onRetry}>{t('retry')}</Button>
        </div>
      ) : events.length === 0 && !loading ? (
        <div className="flex flex-col items-center gap-2 py-10 text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary"><History className="h-5 w-5" aria-hidden /></span>
          <p className="text-sm text-foreground">{t('empty')}</p>
          <p className="max-w-sm text-[13px] text-muted-foreground">{t('emptyHint')}</p>
        </div>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
          {events.map((event) => (
            <li key={event.id}>
              <button
                type="button"
                onClick={() => onOpen(event.id)}
                aria-label={`${t('openDetails')}: ${contactLabel(event.contact)}`}
                className="grid grid-cols-1 w-full gap-1 px-4 py-3 text-left text-sm transition-colors duration-150 hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none sm:grid-cols-[9rem_10rem_minmax(0,1fr)] sm:gap-3"
              >
                <span className="text-xs text-muted-foreground sm:text-sm">
                  {format.dateTime(new Date(event.created_at), { dateStyle: 'medium', timeStyle: 'short' })}
                </span>
                <span className="truncate font-medium text-foreground">{contactLabel(event.contact)}</span>
                <span className="min-w-0 space-y-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className={cn('rounded-full', OUTCOME_STYLE[event.outcome])}>{t(`outcomes.${event.outcome}`)}</Badge>
                    <span className="text-xs text-muted-foreground">{reasonLabel(event.reason)}</span>
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">{event.preview || t('noPreview')}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {loading && <Loader2 className="size-4 animate-spin text-primary" aria-hidden="true" />}
      {cursor && !loading && !failed && (
        <Button type="button" variant="outline" size="sm" onClick={onLoadMore}>{t('loadMore')}</Button>
      )}
    </>
  );
}

function ActivityDetailDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const t = useTranslations('Agents.activity');
  const format = useFormatter();
  const { contactLabel } = useActivityLabels();
  // Keyed by id, so a newly opened row never shows the previous row's details.
  const [loaded, setLoaded] = useState<{ id: string; detail: ActivityDetail | null } | null>(null);
  const current = loaded && loaded.id === id ? loaded : null;
  const detail = current?.detail ?? null;
  const failed = current !== null && current.detail === null;

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    authFetch(`/api/ai/activity/${encodeURIComponent(id)}`, { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error('load_failed');
        const body = (await res.json()) as { event: ActivityDetail };
        if (!cancelled) setLoaded({ id, detail: body.event });
      })
      .catch(() => { if (!cancelled) setLoaded({ id, detail: null }); });
    return () => { cancelled = true; };
  }, [id]);

  return (
    <Dialog open={id !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto border-border bg-popover sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{t('detailTitle')}</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {detail
              ? `${contactLabel(detail.contact)} · ${format.dateTime(new Date(detail.created_at), { dateStyle: 'medium', timeStyle: 'short' })}`
              : ' '}
          </DialogDescription>
        </DialogHeader>
        {failed ? (
          <p role="alert" className="text-sm text-destructive">{t('detailFailed')}</p>
        ) : !detail ? (
          <Loader2 className="size-4 animate-spin text-primary" aria-hidden="true" />
        ) : (
          <ActivityDetailBody detail={detail} onClose={onClose} />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The full entry: message, reply, knowledge used, flags, numbers and a link to the conversation. */
export function ActivityDetailBody({ detail, onClose }: { detail: ActivityDetail; onClose: () => void }) {
  const t = useTranslations('Agents.activity');
  const format = useFormatter();
  const { reasonLabel } = useActivityLabels();
  const number = (n: number) => format.number(n);
  const notRecorded = t('notRecorded');

  return (
    <div className="min-w-0 space-y-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className={cn('rounded-full', OUTCOME_STYLE[detail.outcome])}>{t(`outcomes.${detail.outcome}`)}</Badge>
        <span className="text-muted-foreground">{reasonLabel(detail.reason)}</span>
      </div>

      <section className="space-y-1">
        <h3 className="text-xs font-semibold text-muted-foreground">{t('message')}</h3>
        <p className="whitespace-pre-wrap break-words rounded-lg bg-muted p-3 text-foreground">{detail.customer_text || t('noPreview')}</p>
      </section>
      <section className="space-y-1">
        <h3 className="text-xs font-semibold text-muted-foreground">{t('aiReply')}</h3>
        {detail.reply_text
          ? <p className="whitespace-pre-wrap break-words rounded-lg bg-primary/10 p-3 text-foreground">{detail.reply_text}</p>
          : <p className="text-muted-foreground">{t('noReply')}</p>}
      </section>
      <section className="space-y-1">
        <h3 className="text-xs font-semibold text-muted-foreground">{t('sources')}</h3>
        {detail.sources.length
          ? <ul className="list-disc space-y-0.5 pl-5 text-foreground">
              {detail.sources.map((s) => <li key={s.document_id} className="break-words">{s.title || t('untitled')}</li>)}
            </ul>
          : <p className="text-muted-foreground">{t('noSources')}</p>}
      </section>
      <section className="space-y-1">
        <h3 className="text-xs font-semibold text-muted-foreground">{t('flags')}</h3>
        {detail.guard_flags.length
          ? <div className="flex flex-wrap gap-1.5">{detail.guard_flags.map((f) => <Badge key={f} variant="secondary" className="rounded-full font-mono">{f}</Badge>)}</div>
          : <p className="text-muted-foreground">{t('noFlags')}</p>}
      </section>

      <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
        {[
          [t('confidence'), detail.confidence === null ? notRecorded : format.number(detail.confidence, { style: 'percent' })],
          [t('provider'), detail.provider ?? notRecorded],
          [t('model'), detail.model ?? notRecorded],
          [t('tokens'), t('tokensValue', {
            total: number(detail.total_tokens), prompt: number(detail.prompt_tokens), completion: number(detail.completion_tokens),
          })],
          [t('latency'), detail.latency_ms === null ? notRecorded
            : t('latencyValue', { seconds: format.number(detail.latency_ms / 1000, { maximumFractionDigits: 1 }) })],
        ].map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="break-words text-foreground">{value}</dd>
          </div>
        ))}
      </dl>

      <div className="flex flex-wrap justify-end gap-2">
        {detail.conversation_id && (
          <Link href={`/inbox?c=${encodeURIComponent(detail.conversation_id)}`} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            {t('openConversation')}
          </Link>
        )}
        <Button type="button" size="sm" onClick={onClose}>{t('close')}</Button>
      </div>
    </div>
  );
}
