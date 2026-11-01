'use client';

import { useCallback, useEffect, useState, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/data/client';
import { Broadcast, BroadcastStatus } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CalendarClock, ChevronLeft, ChevronRight, Code, Loader2, Plus, Radio, Search } from 'lucide-react';
import { NumberHealthBar } from '@/components/broadcasts/number-health-bar';
import { ApiCampaignDialog } from '@/components/broadcasts/api-campaign-dialog';
import { useCan } from '@/hooks/use-can';
import { GatedButton } from '@/components/ui/gated-button';
import { getBroadcastStatus } from '@/lib/broadcast-status';
import { useTranslations } from 'next-intl';

/**
 * Poll cadence while any broadcast is sending. Kept modest so we don't
 * beat on Supabase — the aggregate trigger in migration 003 keeps
 * counts consistent; we just need to surface the freshest snapshot.
 */
const POLL_INTERVAL_MS = 5_000;
const PAGE_SIZE = 20;
type Tab = 'all' | BroadcastStatus;
const TABS: Tab[] = ['all', 'scheduled', 'sending', 'sent', 'failed', 'draft', 'cancelled'];

function percent(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 100);
}

function RateCell({
  value,
  total,
  color,
}: {
  value: number;
  total: number;
  /** Tailwind bg class for the fill, e.g. "bg-primary" */
  color: string;
}) {
  const pct = percent(value, total);
  return (
    <div className="flex items-center gap-2">
      <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">
        {pct}%
      </span>
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-1.5 rounded-full ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export default function BroadcastsPage() {
  const router = useRouter();
  const t = useTranslations('Broadcasts.page');
  const tStatus = useTranslations('Broadcasts.status');
  const tGate = useTranslations('GatedButton');
  const canCreate = useCan('send-messages');
  const [broadcasts, setBroadcasts] = useState<Broadcast[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [apiOpen, setApiOpen] = useState(false);
  // Each fetch claims a number; only the newest may commit (fast tab/search switching).
  const fetchSeq = useRef(0);

  // Used to kick off polling only while something is actively sending.
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchBroadcasts = useCallback(async () => {
    const seq = ++fetchSeq.current;
    try {
      const db = createClient();
      let query = db
        .from('broadcasts')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
      if (tab !== 'all') query = query.eq('status', tab);
      const term = search.trim();
      if (term) query = query.ilike('name', `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
      const { data, count, error: fetchError } = await query;
      if (seq !== fetchSeq.current) return;
      if (fetchError) throw fetchError;
      const last = Math.max(0, Math.ceil((count ?? 0) / PAGE_SIZE) - 1);
      // The list shrank under us (filters, deletes): step back to the last real page.
      if (page > last) { setPage(last); return; }
      setBroadcasts(data ?? []);
      setTotal(count ?? 0);
      setError(null);
    } catch (err) {
      if (seq === fetchSeq.current) setError(err instanceof Error ? err.message : t('errorLoad'));
    } finally {
      if (seq === fetchSeq.current) setLoading(false);
    }
  }, [page, tab, search, t]);

  useEffect(() => {
    fetchBroadcasts();
  }, [fetchBroadcasts]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  const anySending = useMemo(
    () => broadcasts.some((b) => b.status === 'sending'),
    [broadcasts],
  );

  useEffect(() => {
    function startPolling() {
      if (pollTimer.current) return;
      pollTimer.current = setInterval(fetchBroadcasts, POLL_INTERVAL_MS);
    }
    function stopPolling() {
      if (!pollTimer.current) return;
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }

    // Pause polling while the tab is hidden — keeps Supabase cold when
    // the user is away, and ensures a fresh fetch the moment they
    // refocus so they don't see stale data on return.
    function handleVisibilityChange() {
      if (!anySending) return;
      if (document.visibilityState === 'hidden') {
        stopPolling();
      } else {
        fetchBroadcasts();
        startPolling();
      }
    }

    if (anySending && document.visibilityState === 'visible') {
      startPolling();
    } else {
      stopPolling();
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [anySending, fetchBroadcasts]);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (error && broadcasts.length === 0) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p className="text-sm text-red-400">{error}</p>
        <Button variant="outline" onClick={() => window.location.reload()}>
          {t('retry')}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Top indeterminate progress bar: only visible while a broadcast
          is mid-send. Pure CSS animation so no extra deps. */}
      {anySending && (
        <div
          role="progressbar"
          aria-label={t('broadcastInProgress')}
          className="broadcast-indeterminate fixed inset-x-0 top-0 z-40 h-0.5 overflow-hidden bg-muted"
        >
          <div className="broadcast-indeterminate-bar h-0.5 bg-primary" />
          <style jsx>{`
            .broadcast-indeterminate-bar {
              width: 33%;
              transform: translateX(-100%);
              animation: broadcast-slide 1.6s cubic-bezier(0.4, 0, 0.2, 1)
                infinite;
            }
            @keyframes broadcast-slide {
              0% {
                transform: translateX(-100%);
              }
              100% {
                transform: translateX(400%);
              }
            }
          `}</style>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('subtitle')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canCreate && (
            <Button variant="outline" onClick={() => setApiOpen(true)}>
              <Code className="h-4 w-4" />
              {t('newApiCampaign')}
            </Button>
          )}
          <GatedButton
            canAct={canCreate}
            gateReason={tGate('reasons.createBroadcasts')}
            onClick={() => router.push('/broadcasts/new')}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            {t('newBroadcast')}
          </GatedButton>
        </div>
      </div>

      <NumberHealthBar />

      <ApiCampaignDialog open={apiOpen} onOpenChange={setApiOpen} onCreated={(id) => router.push(`/broadcasts/${id}`)} />

      {/* Status tabs + name search */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div role="tablist" aria-label={t('tabsLabel')} className="flex flex-wrap gap-1">
          {TABS.map((key) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key}
              onClick={() => { setTab(key); setPage(0); }}
              className={`rounded-full px-3 py-1 text-sm transition-colors ${tab === key ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-muted'}`}
            >
              {key === 'all' ? t('tabAll') : tStatus(key)}
            </button>
          ))}
        </div>
        <div className="relative w-full sm:w-64">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label={t('searchLabel')}
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            placeholder={t('searchPlaceholder')}
            className="pl-8"
          />
        </div>
      </div>

      {error && (
        <p role="alert" className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">{error}</p>
      )}

      {broadcasts.length === 0 && (tab !== 'all' || search.trim()) ? (
        <div className="flex h-40 items-center justify-center rounded-xl border border-border bg-card">
          <p className="text-sm text-muted-foreground">{t('noMatches')}</p>
        </div>
      ) : broadcasts.length === 0 ? (
        <div className="flex h-64 flex-col items-center justify-center rounded-xl border border-border bg-card">
          <Radio className="mb-3 h-10 w-10 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">{t('noBroadcastsYet')}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('createFirst')}
          </p>
          <GatedButton
            canAct={canCreate}
            gateReason={tGate('reasons.createBroadcasts')}
            onClick={() => router.push('/broadcasts/new')}
            className="mt-4 bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            {t('newBroadcast')}
          </GatedButton>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="border-border hover:bg-transparent">
                <TableHead className="text-muted-foreground">{t('table.name')}</TableHead>
                <TableHead className="hidden text-muted-foreground md:table-cell">{t('table.template')}</TableHead>
                <TableHead className="hidden text-right text-muted-foreground sm:table-cell">
                  {t('table.recipients')}
                </TableHead>
                <TableHead className="hidden text-muted-foreground lg:table-cell">{t('table.delivery')}</TableHead>
                <TableHead className="hidden text-muted-foreground lg:table-cell">{t('table.read')}</TableHead>
                <TableHead className="text-muted-foreground">{t('table.status')}</TableHead>
                <TableHead className="hidden text-muted-foreground sm:table-cell">{t('table.date')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {broadcasts.map((broadcast) => {
                const status = getBroadcastStatus(broadcast.status);
                return (
                  <TableRow
                    key={broadcast.id}
                    className="cursor-pointer border-border hover:bg-muted/50"
                    onClick={() => router.push(`/broadcasts/${broadcast.id}`)}
                  >
                    <TableCell className="font-medium text-foreground">
                      {broadcast.name}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground md:table-cell">
                      {broadcast.template_name}
                    </TableCell>
                    <TableCell className="hidden text-right text-muted-foreground tabular-nums sm:table-cell">
                      {broadcast.total_recipients}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <RateCell
                        value={broadcast.delivered_count}
                        total={broadcast.total_recipients}
                        color="bg-primary"
                      />
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <RateCell
                        value={broadcast.read_count}
                        total={broadcast.total_recipients}
                        color="bg-blue-500"
                      />
                    </TableCell>
                    <TableCell>
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${status.classes}`}
                      >
                        {status.pulse && (
                          <span className="relative flex h-1.5 w-1.5">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-yellow-400 opacity-75" />
                            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-yellow-400" />
                          </span>
                        )}
                        {tStatus(status.label)}
                      </span>
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">
                      {broadcast.status === 'scheduled' && broadcast.scheduled_at ? (
                        <span className="inline-flex items-center gap-1" title={t('scheduledFor')}>
                          <CalendarClock className="h-3.5 w-3.5" />
                          {new Date(broadcast.scheduled_at).toLocaleString()}
                        </span>
                      ) : (
                        new Date(broadcast.created_at).toLocaleDateString()
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {t('showing', { start: page * PAGE_SIZE + 1, end: Math.min((page + 1) * PAGE_SIZE, total), total })}
          </p>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="icon-sm" aria-label={t('previousPage')} disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              <ChevronLeft className="size-4" />
            </Button>
            <Button variant="outline" size="icon-sm" aria-label={t('nextPage')} disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}>
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
