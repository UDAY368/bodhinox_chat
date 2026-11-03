'use client';

import { useFormatter, useTranslations } from 'next-intl';

import type { AgentLeaderboardRow } from '@/lib/analytics/queries';
import { DataTable, Panel, ReportState, useDuration } from './shared';

export function AgentLeaderboard({
  agents,
  loading,
  error,
  onRetry,
}: {
  agents: AgentLeaderboardRow[] | null;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  const t = useTranslations('Analytics.agents');
  const roles = useTranslations('Sidebar');
  const duration = useDuration();
  const format = useFormatter();
  const roleKey: Record<string, string> = { owner: 'roleOwner', admin: 'roleAdmin', agent: 'roleAgent', viewer: 'roleViewer' };
  return (
    <Panel title={t('title')} description={t('description')}>
      <ReportState loading={loading} error={error} onRetry={onRetry} empty={!!agents && agents.length === 0}>
        <DataTable
          caption={t('title')}
          columns={[t('member'), t('handled'), t('replies'), t('medianFirstResponse'), t('resolved')]}
          rows={(agents ?? []).map((agent) => [
            <span key="name" className="flex flex-col">
              <span>{agent.name || t('unnamed')}</span>
              <span className="text-xs text-muted-foreground">{roleKey[agent.role] ? roles(roleKey[agent.role]) : agent.role}</span>
            </span>,
            format.number(agent.conversationsHandled),
            format.number(agent.repliesSent),
            agent.firstResponseCount ? duration(agent.medianFirstResponseSeconds) : t('none'),
            format.number(agent.resolved),
          ])}
        />
        <p className="mt-3 text-xs text-muted-foreground">{t('attribution')}</p>
      </ReportState>
    </Panel>
  );
}
