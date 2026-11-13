'use client';

import { useCallback, useEffect, useState, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/data/client';
import { Broadcast, BroadcastStatus } from '@/types';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CalendarClock, ChevronLeft, ChevronRight, Code, Loader2, Plus, Radio, Search } from 'lucide-react';
import {
  CampaignEmpty,
  CampaignHeader,
  IconTile,
  ProgressBar,
  SearchField,
  SegmentedTabs,
  StatusPill,
  BROADCAST_STATUS_TONE as STATUS_TONE,
} from '@/components/broadcasts/campaign-ui';
import { NumberHealthBar } from '@/components/broadcasts/number-health-bar';
import { numberLabel, useWhatsAppNumbers } from '@/components/settings/numbers/use-whatsapp-numbers';
import { ApiCampaignDialog } from '@/components/broadcasts/api-campaign-dialog';
import { planAllows, usePlan } from '@/lib/billing/client';
import { UpgradeBadge } from '@/components/ui/upgrade-badge';
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

function RateCell({ value, total }: { value: number; total: number }) {
  const pct = percent(value, total);
  return (
    <div className="flex items-center gap-2">
      <ProgressBar pct={pct} />
      <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">{pct}%</span>
    </div>
  );
}

export default function BroadcastsPage() {
  const router = useRouter();
  const t = useTranslations('Broadcasts.page');
  const tStatus = useTranslations('Broadcasts.status');
  const tGate = useTranslations('GatedButton');
  const tn = useTranslations('whatsappNumbers');
  // "Send from" only matters when the workspace has more than one number.
  const { numbers } = useWhatsAppNumbers();
  const showSendFrom = numbers.length > 1;
  const sendFromOf = (b: Broadcast): string => {
    const id = (b as Broadcast & { whatsapp_config_id?: string | null }).whatsapp_config_id;
    const n = id ? numbers.find((x) => x.id === id) : undefined;
    return n ? numberLabel(n, tn) : '—';
  };
  const canCreate = useCan('send-messages');
  const [broadcasts, setBroadcasts] = useState<Broadcast[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [apiOpen, setApiOpen] = useState(false);
  const canApi = planAllows(usePlan(), 'api_campaigns');
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
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
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

      <CampaignHeader
        title={t('title')}
        description={t('subtitle')}
        actions={
          <>
            {canCreate && !canApi && <UpgradeBadge />}
            {canCreate && (
              <Button variant="outline" onClick={() => setApiOpen(true)} disabled={!canApi}>
                <Code className="h-4 w-4" />
                {t('newApiCampaign')}
              </Button>
            )}
            <GatedButton
              canAct={canCreate}
              gateReason={tGate('reasons.createBroadcasts')}
              onClick={() => router.push('/broadcasts/new')}
              className="h-9 bg-primary px-4 text-primary-foreground hover:bg-primary/90"
            >
              <Plus className="h-4 w-4" />
              {t('newBroadcast')}
            </GatedButton>
          </>
        }
      />

      <NumberHealthBar />

      <ApiCampaignDialog open={apiOpen} onOpenChange={setApiOpen} onCreated={(id) => router.push(`/broadcasts/${id}`)} />

      {/* Status filter (segmented) + name search */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <SegmentedTabs
          ariaLabel={t('tabsLabel')}
          value={tab}
          onChange={(key) => { setTab(key); setPage(0); }}
          items={TABS.map((key) => ({ value: key, label: key === 'all' ? t('tabAll') : tStatus(key) }))}
        />
        <SearchField
          ariaLabel={t('searchLabel')}
          value={search}
          onChange={(v) => { setSearch(v); setPage(0); }}
          placeholder={t('searchPlaceholder')}
        />
      </div>

      {error && (
        <p role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">{error}</p>
      )}

      {broadcasts.length === 0 && (tab !== 'all' || search.trim()) ? (
        <CampaignEmpty icon={Search} title={t('noMatches')} />
      ) : broadcasts.length === 0 ? (
        <CampaignEmpty
          icon={Radio}
          title={t('noBroadcastsYet')}
          description={t('createFirst')}
          action={
            <GatedButton
              canAct={canCreate}
              gateReason={tGate('reasons.createBroadcasts')}
              onClick={() => router.push('/broadcasts/new')}
              variant="outline"
            >
              <Plus className="h-4 w-4" />
              {t('newBroadcast')}
            </GatedButton>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <Table>
            <TableHeader className="bg-muted">
              <TableRow className="border-border hover:bg-transparent">
                <TableHead className="h-9 px-4 text-xs font-semibold text-muted-foreground">{t('table.name')}</TableHead>
                {showSendFrom && (
                  <TableHead className="hidden h-9 px-3 text-xs font-semibold text-muted-foreground md:table-cell">{tn('picker.sendFrom')}</TableHead>
                )}
                <TableHead className="h-9 px-3 text-xs font-semibold text-muted-foreground">{t('table.status')}</TableHead>
                <TableHead className="hidden h-9 px-3 text-right text-xs font-semibold text-muted-foreground sm:table-cell">
                  {t('table.recipients')}
                </TableHead>
                <TableHead className="hidden h-9 px-3 text-xs font-semibold text-muted-foreground lg:table-cell">{t('table.delivery')}</TableHead>
                <TableHead className="hidden h-9 px-3 pr-4 text-xs font-semibold text-muted-foreground lg:table-cell">{t('table.read')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {broadcasts.map((broadcast) => {
                const status = getBroadcastStatus(broadcast.status);
                return (
                  <TableRow
                    key={broadcast.id}
                    className="cursor-pointer border-border/70 transition-colors duration-150 hover:bg-muted/60"
                    onClick={() => router.push(`/broadcasts/${broadcast.id}`)}
                  >
                    <TableCell className="w-full max-w-0 px-4 py-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <IconTile icon={Radio} />
                        <div className="flex min-w-0 flex-col leading-snug">
                          <span className="truncate font-semibold text-foreground">{broadcast.name}</span>
                          <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                            <span className="truncate">{broadcast.template_name}</span>
                            <span aria-hidden>·</span>
                            {broadcast.status === 'scheduled' && broadcast.scheduled_at ? (
                              <span className="inline-flex shrink-0 items-center gap-1" title={t('scheduledFor')}>
                                <CalendarClock className="h-3 w-3" />
                                {new Date(broadcast.scheduled_at).toLocaleString()}
                              </span>
                            ) : (
                              <span className="shrink-0">{new Date(broadcast.created_at).toLocaleDateString()}</span>
                            )}
                          </span>
                        </div>
                      </div>
                    </TableCell>
                    {showSendFrom && (
                      <TableCell className="hidden px-3 text-muted-foreground md:table-cell">{sendFromOf(broadcast)}</TableCell>
                    )}
                    <TableCell className="px-3">
                      <StatusPill tone={STATUS_TONE[broadcast.status] ?? 'neutral'} pulse={status.pulse}>
                        {tStatus(status.label)}
                      </StatusPill>
                    </TableCell>
                    <TableCell className="hidden px-3 text-right font-semibold tabular-nums text-foreground sm:table-cell">
                      {broadcast.total_recipients.toLocaleString()}
                    </TableCell>
                    <TableCell className="hidden px-3 lg:table-cell">
                      <RateCell value={broadcast.delivered_count} total={broadcast.total_recipients} />
                    </TableCell>
                    <TableCell className="hidden px-3 pr-4 lg:table-cell">
                      <RateCell value={broadcast.read_count} total={broadcast.total_recipients} />
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
