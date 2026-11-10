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
import { SkeletonCard } from '@/components/dashboard/skeleton';
import { QuickActions } from '@/components/dashboard/quick-actions';
import { ConversationsChart } from '@/components/dashboard/conversations-chart';
import { PipelineDonut } from '@/components/dashboard/pipeline-donut';
import { ResponseTimeChart } from '@/components/dashboard/response-time-chart';
import { ActivityFeed } from '@/components/dashboard/activity-feed';
import { OperationsPanel } from '@/components/dashboard/operations-panel';
import { OnboardingChecklist } from '@/components/dashboard/onboarding-checklist';
import { ChannelPickerCard } from '@/components/dashboard/channel-picker-card';
import styles from '@/components/dashboard/dashboard.module.css';

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
      .catch((err) => console.error('[dashboard] metrics failed:', err))
      .finally(() => setMetricsLoading(false));

    void charts
      .then((c) => {
        setSeries((prev) => ({ ...prev, 30: c.series }));
        setResponseTime(c.responseTime);
      })
      .catch((err) => console.error('[dashboard] charts failed:', err))
      .finally(() => {
        setSeriesLoading(false);
        setResponseTimeLoading(false);
      });

    void loadPipelineDonut(db, charts)
      .then((p) => setPipeline(p))
      .catch((err) => console.error('[dashboard] pipeline failed:', err))
      .finally(() => setPipelineLoading(false));

    // Fetch up to 50 so the biggest page-size option in the feed
    // (50 rows) is already in memory — switching sizes then becomes
    // a pure client-side slice with no extra round trip.
    void loadActivity(db, 50)
      .then((a) => setActivity(a))
      .catch((err) => console.error('[dashboard] activity failed:', err))
      .finally(() => setActivityLoading(false));
  }, []);

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
        .catch((err) => console.error('[dashboard] series failed:', err))
        .finally(() => setSeriesLoading(false));
    },
    [series]
  );

  return (
    <div className={`${styles.dashboard} studio-dashboard space-y-6`}>
      {/* Header */}
      <div className={styles.pageHeader}>
        <div>
          <p className="eyebrow">{t('workspaceLabel')}</p>
          <h1 className="text-foreground mt-2 text-2xl font-semibold tracking-tight">
            {t('title')}
          </h1>
          <p className="text-muted-foreground mt-2 max-w-xl text-sm leading-relaxed">
            {t('description')}
          </p>
        </div>
        <Link href="/inbox" className={styles.inboxLink}>
          {t('openInbox')} <ArrowUpRight className="h-4 w-4" aria-hidden />
        </Link>
      </div>

      <ChannelPickerCard />
      <OnboardingChecklist />

      <div className={styles.introGrid}>
        <section className={`${styles.hero} studio-hero`}>
          <div className={styles.orbit} aria-hidden>
            <span />
            <i />
          </div>
          <div className={styles.heroContent}>
            <h2 className="studio-editorial">
              {t('heroTitle')}
              <br />
              <span>{t('heroAccent')}</span>
            </h2>
            <p>{t('heroDescription')}</p>
          </div>
        </section>
        <Link href="/agents" className={styles.aiTile}>
          <div className={styles.aiTileTop}>
            <span>{t('aiLabel')}</span>
          </div>
          <div className={styles.aiTileBody}>
            <div>
              <h2 className="studio-editorial">{t('aiTitle')}</h2>
              <p>{t('aiDescription')}</p>
            </div>
            <Image src="/brand/khaga-sun-orange.webp" alt="" aria-hidden="true"
              width={640} height={640} sizes="(max-width: 720px) 140px, 160px"
              className={styles.aiAvatar} />
          </div>
          <div className={styles.aiTileLink}>
            {t('openAi')} <ArrowUpRight className="h-4 w-4" aria-hidden />
          </div>
        </Link>
      </div>

      {/* Metric cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {metricsLoading || !metrics ? (
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

      {/* Quick actions */}
      <QuickActions />
      <OperationsPanel onReplyTarget={setReplyTargetMinutes} />

      {/* Charts row */}
      {/* items-stretch (the grid default) stretches the two columns to
          match the tallest sibling; adding h-full on each wrapper and
          on the inner panels makes both cards actually fill that
          stretched height so their rounded borders line up. Without
          this, the pipeline card rendered at its natural (shorter)
          height while the line chart drove the row height. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <div className="h-full lg:col-span-3">
          <ConversationsChart
            series={series}
            loading={seriesLoading}
            range={range}
            onRangeChange={handleRangeChange}
          />
        </div>
        <div className="h-full lg:col-span-2">
          <PipelineDonut
            data={pipeline}
            loading={pipelineLoading}
            currency={defaultCurrency}
          />
        </div>
      </div>

      {/* Response time */}
      <ResponseTimeChart
        data={responseTime}
        loading={responseTimeLoading}
        thresholdMinutes={replyTargetMinutes}
      />

      {/* Activity feed */}
      <ActivityFeed items={activity} loading={activityLoading} />
    </div>
  );
}

// ------------------------------------------------------------

function deltaLabel(
  delta: number,
  suffix: string,
  noChangeLabel: string
): string {
  if (delta === 0) return noChangeLabel;
  const sign = delta > 0 ? '+' : '';
  return `${sign}${delta.toLocaleString()} ${suffix}`;
}
