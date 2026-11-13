'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { hasMinRole } from '@/lib/auth/roles';
import type { AgentLeaderboardRow, AiStats, CampaignFunnel as Funnel, FlowStats } from '@/lib/analytics/queries';
import { AgentLeaderboard } from '@/components/analytics/agent-leaderboard';
import { AiSection } from '@/components/analytics/ai-section';
import { ChannelFilter, type ChannelFilterValue } from '@/components/analytics/channel-filter';
import { CampaignFunnel } from '@/components/analytics/campaign-funnel';
import { CommerceCard } from '@/components/analytics/commerce-card';
import { CompareSection } from '@/components/analytics/compare-section';
import { FlowDropOff } from '@/components/analytics/flow-dropoff';
import { ConversationCharts, OverviewTiles, type OverviewReport } from '@/components/analytics/overview-section';
import { NumberFilter, RangePicker, rangeParams, type RangeValue } from '@/components/analytics/range-picker';
import { reportQuery, useReport } from '@/components/analytics/shared';
import { ReportsTab } from '@/components/analytics/reports';
import { AiInsightsPanel } from '@/components/analytics/ai-insights';

export default function AnalyticsPage() {
  const t = useTranslations('Analytics.page');
  const tChannel = useTranslations('Analytics.channel');
  const { accountRole } = useAuth();
  const [range, setRange] = useState<RangeValue>({ preset: '30d' });
  const [number, setNumber] = useState('');
  const [flowId, setFlowId] = useState('');
  const [channel, setChannel] = useState<ChannelFilterValue>('');
  // Campaign, template, product and number figures are WhatsApp by definition.
  const whatsappOnlyHidden = channel === 'instagram';

  const rangeQuery = reportQuery(rangeParams(range));
  const overview = useReport<OverviewReport>('overview', reportQuery({ ...rangeParams(range), number: whatsappOnlyHidden ? '' : number, channel }));
  const agents = useReport<{ agents: AgentLeaderboardRow[] }>('agents', rangeQuery);
  const campaigns = useReport<{ funnel: Funnel }>('campaigns', rangeQuery);
  const flows = useReport<{ stats: FlowStats; flows: { id: string; name: string }[] }>(
    'flows',
    reportQuery({ ...rangeParams(range), flow: flowId }),
  );
  const canSeeAi = accountRole ? hasMinRole(accountRole, 'agent') : false;
  const ai = useReport<{ stats: AiStats }>('ai', rangeQuery, canSeeAi);
  const shown = overview.data?.range;

  return (
    <div className="mx-auto w-full max-w-[1440px] space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[22px] leading-tight font-bold tracking-tight text-foreground">{t('title')}</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t('description')}</p>
        </div>
        <div className="flex max-w-full flex-col items-start gap-2 sm:items-end">
          <RangePicker value={range} onChange={setRange} today={range.preset === 'custom' ? undefined : shown?.endDay} />
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            <ChannelFilter value={channel} onChange={setChannel} />
            {!whatsappOnlyHidden && <NumberFilter numbers={overview.data?.numbers ?? []} value={number} onChange={setNumber} />}
          </div>
        </div>
      </header>

      {shown && (
        <p className="-mt-1 text-[13px] text-muted-foreground" aria-live="polite">
          {t('showing', { from: shown.startDay, to: shown.endDay, previousFrom: overview.data!.previousRange.startDay, previousTo: overview.data!.previousRange.endDay })}
        </p>
      )}

      <OverviewTiles data={overview.data} loading={overview.loading} error={overview.error} onRetry={overview.retry} />
      <ConversationCharts data={overview.data} loading={overview.loading} error={overview.error} onRetry={overview.retry} />

      <AgentLeaderboard agents={agents.data?.agents ?? null} loading={agents.loading} error={agents.error} onRetry={agents.retry} />
      {whatsappOnlyHidden && <p className="text-xs text-muted-foreground">{tChannel('whatsappOnlyNote')}</p>}
      {!whatsappOnlyHidden && <CampaignFunnel funnel={campaigns.data?.funnel ?? null} loading={campaigns.loading} error={campaigns.error} onRetry={campaigns.retry} />}
      <FlowDropOff
        stats={flows.data?.stats ?? null}
        flows={flows.data?.flows ?? []}
        flowId={flowId}
        onFlowChange={setFlowId}
        loading={flows.loading}
        error={flows.error}
        onRetry={flows.retry}
      />
      {!whatsappOnlyHidden && <CompareSection query={rangeQuery} campaigns={campaigns.data?.funnel.broadcasts ?? []} showProducts={canSeeAi} />}
      {canSeeAi && !whatsappOnlyHidden && <CommerceCard query={rangeQuery} />}
      {canSeeAi && <AiSection stats={ai.data?.stats ?? null} loading={ai.loading} error={ai.error} onRetry={ai.retry} />}
      {canSeeAi && <AiInsightsPanel range={range} />}
      {number && !whatsappOnlyHidden && <p className="text-xs text-muted-foreground">{t('numberScope')}</p>}
      {accountRole && hasMinRole(accountRole, 'admin') && <ReportsTab canManage />}
    </div>
  );
}
