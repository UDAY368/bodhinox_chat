'use client';

// Instagram › Insights: the comment funnel per post and per flow (Stage 3).
// Counts only (comments, DMs, opened DMs, link clicks, leads, new followers);
// the numbers come from GET /api/analytics/instagram, which any member may
// read. The Instagram section layout explains a channel that is off.

import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { RangePicker, rangeParams, type RangeValue } from '@/components/analytics/range-picker';
import { DataTable, Panel, ReportState, reportQuery, useReport } from '@/components/analytics/shared';
import { Button } from '@/components/ui/button';
import type { CommentFunnel, CommentFunnelBy } from '@/lib/instagram/funnel';

interface InsightsReport {
  range: { startDay: string; endDay: string };
  by: CommentFunnelBy;
  funnel: CommentFunnel;
}

/** Share of `part` in `whole` as a whole percent, or null without a base. */
const percent = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : null);

export default function InstagramInsightsPage() {
  const t = useTranslations('Instagram.insights');
  const format = useFormatter();
  const [range, setRange] = useState<RangeValue>({ preset: '30d' });
  const [by, setBy] = useState<CommentFunnelBy>('post');
  const report = useReport<InsightsReport>('instagram', reportQuery({ ...rangeParams(range), by }));
  const funnel = report.data?.funnel ?? null;
  const rate = (row: { optIns: number; comments: number }) => {
    const value = percent(row.optIns, row.comments);
    return value == null ? '–' : `${value}%`;
  };
  const label = (row: { id: string | null; name: string | null }) =>
    by === 'flow' ? (row.name ?? t('deletedFlow')) : row.id ? `…${row.id.slice(-8)}` : t('untitledPost');
  return (
    <div className="studio-dashboard space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">{t('title')}</h1>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">{t('description')}</p>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <RangePicker value={range} onChange={setRange} today={range.preset === 'custom' ? undefined : report.data?.range.endDay} />
          <div role="group" aria-label={t('range')} className="flex gap-1">
            {(['post', 'flow'] as const).map((key) => (
              <Button key={key} size="sm" variant={by === key ? 'default' : 'outline'} aria-pressed={by === key} onClick={() => setBy(key)}>
                {key === 'post' ? t('byPost') : t('byFlow')}
              </Button>
            ))}
          </div>
        </div>
      </div>
      <Panel title={by === 'post' ? t('byPost') : t('byFlow')} description={t('clicksNote')}>
        <ReportState loading={report.loading} error={report.error} onRetry={report.retry} empty={!!funnel && funnel.totals.comments === 0}>
          {funnel && (
            <DataTable
              caption={by === 'post' ? t('byPost') : t('byFlow')}
              columns={[by === 'post' ? t('post') : t('flow'), t('comments'), t('dms'), t('optIns'), t('optInRate'), t('clicks'), t('leads'), t('follows')]}
              rows={funnel.rows.map((row) => [
                label(row), format.number(row.comments), format.number(row.dms), format.number(row.optIns), rate(row),
                format.number(row.clicks), format.number(row.leads), format.number(row.follows),
              ])}
            />
          )}
        </ReportState>
      </Panel>
    </div>
  );
}
