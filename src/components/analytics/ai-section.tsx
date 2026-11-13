'use client';

import { Bot, CheckCircle2, HelpCircle, MessagesSquare, UserRoundCog } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';

import type { AiStats } from '@/lib/analytics/queries';
import { MetricCard } from '@/components/dashboard/metric-card';
import { Panel, ReportState } from './shared';

export function AiSection({
  stats,
  loading,
  error,
  onRetry,
}: {
  stats: AiStats | null;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  const t = useTranslations('Analytics.ai');
  const format = useFormatter();
  return (
    <Panel title={t('title')} description={t('description')}>
      <ReportState loading={loading} error={error} onRetry={onRetry} empty={!!stats && stats.aiReplies === 0 && stats.handoffs === 0}>
        {stats && (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <MetricCard
              title={t('resolutionRate')}
              value={stats.resolutionRate == null ? '–' : format.number(stats.resolutionRate, { style: 'percent', maximumFractionDigits: 0 })}
              icon={CheckCircle2}
              subtitle={t('resolvedByAi', { count: stats.resolvedByAi })}
            />
            <MetricCard title={t('replies')} value={format.number(stats.aiReplies)} icon={Bot} />
            <MetricCard title={t('conversations')} value={format.number(stats.aiConversations)} icon={MessagesSquare} />
            <MetricCard title={t('handoffs')} value={format.number(stats.handoffs)} icon={UserRoundCog} />
            <MetricCard title={t('unanswered')} value={format.number(stats.unansweredRecorded)} icon={HelpCircle} />
          </div>
        )}
      </ReportState>
    </Panel>
  );
}
