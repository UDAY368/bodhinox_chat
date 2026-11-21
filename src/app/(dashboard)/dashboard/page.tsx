'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { createClient } from '@/lib/data/client';
import { useAuth } from '@/hooks/use-auth';
import { formatCurrency } from '@/lib/currency';
import {
  MessageSquare,
  UserPlus,
  DollarSign,
  Send,
  ArrowUpRight,
  ChevronRight,
} from 'lucide-react';

import {
  fetchDashboardCharts,
  loadActivity,
  loadMetrics,
  loadPipelineDonut,
} from '@/lib/dashboard/queries';
import type {
  ActivityItem,
  ConversationsSeriesPoint,
  MetricsBundle,
  PipelineDonutData,
  ResponseTimeSummary,
} from '@/lib/dashboard/types';

import { MetricCard } from '@/components/dashboard/metric-card';
import { BusinessCards } from '@/components/dashboard/business-cards';
import { SkeletonCard } from '@/components/dashboard/skeleton';
import { QuickActions } from '@/components/dashboard/quick-actions';
import { ConversationsChart } from '@/components/dashboard/conversations-chart';
import { PipelineDonut } from '@/components/dashboard/pipeline-donut';
import { ResponseTimeChart } from '@/components/dashboard/response-time-chart';
import { ActivityFeed } from '@/components/dashboard/activity-feed';
import { OperationsPanel } from '@/components/dashboard/operations-panel';
import { OnboardingChecklist } from '@/components/dashboard/onboarding-checklist';
import { ChannelPickerCard } from '@/components/dashboard/channel-picker-card';
import { buttonVariants } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { InlineError } from '@/components/ui/inline-error';
import { cn } from '@/lib/utils';

import { useTranslations } from 'next-intl';

type RangeDays = 7 | 30 | 90;

export default function DashboardPage() {
  const t = useTranslations('Dashboard.page');
  const { defaultCurrency } = useAuth();
  const [metrics, setMetrics] = useState<MetricsBundle | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(true);
  const [replyTargetMinutes, setReplyTargetMinutes] = useState(0);

  const [range, setRange] = useState<RangeDays>(30);
  // Keep a cache per range so switching tabs doesn't re-fetch what we
  // already have. Ranges the user hasn't opened yet stay null and
  // trigger a fetch on first view.
  const [series, setSeries] = useState<
    Record<RangeDays, ConversationsSeriesPoint[] | null>
  >({
    7: null,
    30: null,
    90: null,
  });
  const [seriesLoading, setSeriesLoading] = useState(true);

  const [pipeline, setPipeline] = useState<PipelineDonutData | null>(null);
  const [pipelineLoading, setPipelineLoading] = useState(true);

  const [responseTime, setResponseTime] = useState<ResponseTimeSummary | null>(
    null
  );
  const [responseTimeLoading, setResponseTimeLoading] = useState(true);

  const [activity, setActivity] = useState<ActivityItem[] | null>(null);
  const [activityLoading, setActivityLoading] = useState(true);

  // A widget whose request failed shows what happened and Retry, never a skeleton forever.
  const [failed, setFailed] = useState<Record<Widget, boolean>>(NONE_FAILED);
  const fail = useCallback((widget: Widget) => setFailed((prev) => ({ ...prev, [widget]: true })), []);

  const loadAll = useCallback(() => {
    const db = createClient();

    // Kick everything off in parallel. Each block has its own
    // setState + finally so a slow query doesn't hold up faster
    // sections — each widget shows its own skeleton independently.
    // One SQL-aggregated request feeds the series, response time,
    // open deal totals and the pipeline donut.
    const charts = fetchDashboardCharts(30);

    void loadMetrics(db, charts)
      .then((m) => setMetrics(m))
      .catch((err) => {
        console.error('[dashboard] metrics failed:', err);
        fail('metrics');
      })
      .finally(() => setMetricsLoading(false));

    void charts
      .then((c) => {
        setSeries((prev) => ({ ...prev, 30: c.series }));
        setResponseTime(c.responseTime);
      })
      .catch((err) => {
        console.error('[dashboard] charts failed:', err);
        fail('charts');
      })
      .finally(() => {
        setSeriesLoading(false);
        setResponseTimeLoading(false);
      });

    void loadPipelineDonut(db, charts)
      .then((p) => setPipeline(p))
      .catch((err) => {
        console.error('[dashboard] pipeline failed:', err);
        fail('pipeline');
      })
      .finally(() => setPipelineLoading(false));

    // Fetch up to 50 so the biggest page-size option in the feed
    // (50 rows) is already in memory — switching sizes then becomes
    // a pure client-side slice with no extra round trip.
    void loadActivity(db, 50)
      .then((a) => setActivity(a))
      .catch((err) => {
        console.error('[dashboard] activity failed:', err);
        fail('activity');
      })
      .finally(() => setActivityLoading(false));
  }, [fail]);

  // Retry reloads every widget (one request feeds most of them).
  const retry = useCallback(() => {
    setFailed(NONE_FAILED);
    setMetricsLoading(true);
    setSeriesLoading(true);
    setResponseTimeLoading(true);
    setPipelineLoading(true);
    setActivityLoading(true);
    setSeries({ 7: null, 30: null, 90: null });
    setRange(30);
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // Range switch handler — kept in an event callback (not an effect)
  // so the setState calls stay out of the react-hooks/set-state-in-effect
  // rule's way. The cached bucket check means switching back to a
  // previously-viewed range is instant and doesn't re-fetch.
  const handleRangeChange = useCallback(
    (r: RangeDays) => {
      setRange(r);
      if (series[r] !== null) return;
      setSeriesLoading(true);
      fetchDashboardCharts(r)
        .then((c) => setSeries((prev) => ({ ...prev, [r]: c.series })))
        .catch((err) => {
          console.error('[dashboard] series failed:', err);
          fail('charts');
        })
        .finally(() => setSeriesLoading(false));
    },
    [series, fail]
  );

  return (
    <div className="mx-auto w-full max-w-[1440px] space-y-5">
      {/* One large title, one line, and the one primary action. */}
      <PageHeader
        className="mb-0"
        title={t('title')}
        subtitle={t('description')}
        primaryAction={
          <Link href="/inbox" className={buttonVariants({ size: 'lg' })}>
            {t('openInbox')} <ArrowUpRight aria-hidden />
          </Link>
        }
      />

      <ChannelPickerCard />
      <OnboardingChecklist />

      {/* Metric cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {failed.metrics ? (
          <WidgetError className="col-span-2 lg:col-span-4" onRetry={retry} />
        ) : metricsLoading || !metrics ? (
          Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)
        ) : (
          <>
            <MetricCard
              title={t('activeConversations')}
              value={metrics.activeConversations.current.toLocaleString()}
              icon={MessageSquare}
              delta={{
                sign: metrics.activeConversations.previous,
                label: deltaLabel(
                  metrics.activeConversations.previous,
                  t('newTodayVsYesterday'),
                  t('noChange', { suffix: t('newTodayVsYesterday') })
                ),
              }}
            />
            <MetricCard
              title={t('newContactsToday')}
              value={metrics.newContactsToday.current.toLocaleString()}
              icon={UserPlus}
              delta={{
                sign:
                  metrics.newContactsToday.current -
                  metrics.newContactsToday.previous,
                label: deltaLabel(
                  metrics.newContactsToday.current -
                    metrics.newContactsToday.previous,
                  t('vsYesterday'),
                  t('noChange', { suffix: t('vsYesterday') })
                ),
              }}
            />
            <MetricCard
              title={t('openDealsValue')}
              value={formatCurrency(metrics.openDealsValue, defaultCurrency)}
              icon={DollarSign}
              subtitle={t('openDeals', { count: metrics.openDealsCount })}
            />
            <MetricCard
              title={t('messagesSentToday')}
              value={metrics.messagesSentToday.current.toLocaleString()}
              icon={Send}
              delta={{
                sign:
                  metrics.messagesSentToday.current -
                  metrics.messagesSentToday.previous,
                label: deltaLabel(
                  metrics.messagesSentToday.current -
                    metrics.messagesSentToday.previous,
                  t('vsYesterday'),
                  t('noChange', { suffix: t('vsYesterday') })
                ),
              }}
            />
          </>
        )}
      </div>

      {/* Business cards: revenue, bookings, ad spend, AI handled (each opens its records) */}
      <BusinessCards currency={defaultCurrency} />

      {/* Quick actions, with the AI workspace as one more calm row */}
      <QuickActions />
      <Link
        href="/agents"
        className="border-border bg-card hover:bg-muted/60 group flex items-center gap-3 rounded-xl border p-3 pr-4 transition-colors duration-150"
      >
        <Image src="/brand/khaga-sun-orange.webp" alt="" aria-hidden="true"
          width={80} height={80} sizes="40px"
          className="bg-muted size-10 shrink-0 rounded-xl object-contain p-1" />
        <span className="min-w-0 flex-1">
          <span className="text-foreground block text-sm font-semibold">{t('aiTitle')}</span>
          <span className="text-muted-foreground block truncate text-xs">{t('aiDescription')}</span>
        </span>
        <span className="text-primary hidden items-center gap-1 text-[13px] font-medium sm:inline-flex">
          {t('openAi')}
        </span>
        <ChevronRight className="text-muted-foreground size-4 shrink-0 transition-transform duration-150 group-hover:translate-x-0.5" aria-hidden />
      </Link>

      <OperationsPanel onReplyTarget={setReplyTargetMinutes} />

      {/* Charts row */}
      {/* items-stretch (the grid default) stretches the two columns to
          match the tallest sibling; adding h-full on each wrapper and
          on the inner panels makes both cards actually fill that
          stretched height so their rounded borders line up. Without
          this, the pipeline card rendered at its natural (shorter)
          height while the line chart drove the row height. */}
      <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-12">
        <div className="h-full min-w-0 lg:col-span-7">
          {failed.charts ? (
            <WidgetError onRetry={retry} />
          ) : (
            <ConversationsChart
              series={series}
              loading={seriesLoading}
              range={range}
              onRangeChange={handleRangeChange}
            />
          )}
        </div>
        <div className="h-full min-w-0 lg:col-span-5">
          {failed.pipeline ? (
            <WidgetError onRetry={retry} />
          ) : (
            <PipelineDonut
              data={pipeline}
              loading={pipelineLoading}
              currency={defaultCurrency}
            />
          )}
        </div>
      </div>

      {/* Response time beside the most recent activity */}
      <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-7">
          {failed.charts ? (
            <WidgetError onRetry={retry} />
          ) : (
            <ResponseTimeChart
              data={responseTime}
              loading={responseTimeLoading}
              thresholdMinutes={replyTargetMinutes}
            />
          )}
        </div>
        <div className="min-w-0 lg:col-span-5">
          {failed.activity ? (
            <WidgetError onRetry={retry} />
          ) : (
            <ActivityFeed items={activity} loading={activityLoading} />
          )}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------

type Widget = 'metrics' | 'charts' | 'pipeline' | 'activity';
const NONE_FAILED: Record<Widget, boolean> = { metrics: false, charts: false, pipeline: false, activity: false };

/** A dashboard card whose request failed: what happened, then Retry. */
function WidgetError({ onRetry, className }: { onRetry: () => void; className?: string }) {
  return (
    <section className={cn('border-border bg-card flex h-full items-center justify-center rounded-xl border', className)}>
      <InlineError onRetry={onRetry} />
    </section>
  );
}

function deltaLabel(
  delta: number,
  suffix: string,
  noChangeLabel: string
): string {
  if (delta === 0) return noChangeLabel;
  const sign = delta > 0 ? '+' : '';
  return `${sign}${delta.toLocaleString()} ${suffix}`;
}
