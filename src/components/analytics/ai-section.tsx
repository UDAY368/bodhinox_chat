'use client';

import { Bot, CheckCircle2, CircleDollarSign, HelpCircle, MessagesSquare, UserRoundCog } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';

import type { AiStats } from '@/lib/analytics/queries';
import type { AiCostEstimate } from '@/lib/analytics/ai-cost';
import { MetricCard } from '@/components/dashboard/metric-card';
import { Panel, ReportState } from './shared';

/**
 * AI agent figures. Each card opens its records where a filtered list exists
 * (resolved chats, chats handed to a person, unanswered questions). Admins also
 * see the estimated AI cost: tokens x list price, never the provider's invoice.
 */
export function AiSection({
  stats,
  cost = null,
  loading,
  error,
  onRetry,
}: {
  stats: AiStats | null;
  /** Admins only (null for other roles): tokens x the model price table. */
  cost?: AiCostEstimate | null;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  const t = useTranslations('Analytics.ai');
  const format = useFormatter();
  const cols = cost ? 'lg:grid-cols-6' : 'lg:grid-cols-5';
  return (
    <Panel title={t('title')} description={t('description')}>
      <ReportState loading={loading} error={error} onRetry={onRetry} empty={!!stats && stats.aiReplies === 0 && stats.handoffs === 0 && !cost?.promptTokens}>
        {stats && (
          <div className={`grid grid-cols-2 gap-3 ${cols}`}>
            <MetricCard
              title={t('resolutionRate')}
              value={stats.resolutionRate == null ? '–' : format.number(stats.resolutionRate, { style: 'percent', maximumFractionDigits: 0 })}
              icon={CheckCircle2}
              subtitle={t('resolvedByAi', { count: stats.resolvedByAi })}
              href="/inbox?filter=lifecycle-resolved"
            />
            <MetricCard title={t('replies')} value={format.number(stats.aiReplies)} icon={Bot} />
            <MetricCard title={t('conversations')} value={format.number(stats.aiConversations)} icon={MessagesSquare} />
            <MetricCard title={t('handoffs')} value={format.number(stats.handoffs)} icon={UserRoundCog} href="/inbox?filter=lifecycle-requesting" />
            <MetricCard title={t('unanswered')} value={format.number(stats.unansweredRecorded)} icon={HelpCircle} href="/agents?tab=activity" />
            {cost && (
              <MetricCard
                title={t('estimatedCost')}
                value={format.number(cost.estimatedUsd, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })}
                icon={CircleDollarSign}
                subtitle={cost.unpricedTokens > 0
                  ? t('estimatedCostUnpriced', { tokens: format.number(cost.unpricedTokens) })
                  : t('estimatedCostNote', { tokens: format.number(cost.promptTokens + cost.completionTokens) })}
                href="/agents?tab=activity"
              />
            )}
          </div>
        )}
      </ReportState>
    </Panel>
  );
}
