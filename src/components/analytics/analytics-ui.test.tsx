import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';

import type { ConversationStats } from '@/lib/analytics/queries';
import { AgentLeaderboard } from './agent-leaderboard';
import { CampaignFunnel, rate } from './campaign-funnel';
import { FlowDropOff } from './flow-dropoff';
import { ConversationCharts, OverviewTiles, percentChange, type OverviewReport } from './overview-section';
import { NumberFilter, rangeParams } from './range-picker';
import { reportQuery } from './shared';

// Keys render as their path (messages are merged into messages/*.json separately).
const render = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}} getMessageFallback={({ namespace, key }) => `${namespace}.${key}`}>
      {node}
    </NextIntlClientProvider>,
  );
const noop = () => {};

const stats = (over: Partial<ConversationStats> = {}): ConversationStats => ({
  started: { total: 10, inbound: 6, business: 3, campaignReply: 1 },
  byLifecycle: { bot: 1, requesting: 2, assigned: 3, resolved: 4 },
  firstResponse: { count: 8, unanswered: 2, medianSeconds: 125, p90Seconds: 4000 },
  resolution: { resolved: 4, count: 3, medianSeconds: 90_000, p90Seconds: null },
  ...over,
});

describe('analytics helpers', () => {
  it('computes changes and rates only with a baseline', () => {
    expect(percentChange(15, 10)).toBe(50);
    expect(percentChange(5, 0)).toBeNull();
    expect(percentChange(null, 10)).toBeNull();
    expect(rate(1, 3)).toBe(33);
    expect(rate(1, 0)).toBeNull();
  });

  it('builds report queries from presets or custom days, dropping empty filters', () => {
    expect(reportQuery({ ...rangeParams({ preset: '7d' }), number: '' })).toBe('preset=7d');
    expect(reportQuery(rangeParams({ preset: 'custom', from: '2026-01-01', to: '2026-01-31' }))).toBe('from=2026-01-01&to=2026-01-31');
  });
});

describe('analytics panels', () => {
  const report: OverviewReport = {
    range: { startDay: '2026-10-01', endDay: '2026-10-30', days: 30 },
    previousRange: { startDay: '2026-09-01', endDay: '2026-09-30' },
    current: stats(),
    previous: stats({ started: { total: 5, inbound: 5, business: 0, campaignReply: 0 } }),
    numbers: [],
  };

  it('shows tiles with durations and the change against the previous period', () => {
    const html = render(<OverviewTiles data={report} loading={false} />);
    expect(html).toContain('Analytics.duration.minutes');
    expect(html).toContain('Analytics.duration.days');
    expect(html).toContain('Analytics.overview.change');
  });

  it('shows overview tiles as skeletons only while loading, and a retry when the report failed', () => {
    expect(render(<OverviewTiles data={null} loading />)).toContain('animate-pulse');
    const silent = render(<OverviewTiles data={null} loading={false} error />);
    expect(silent).not.toContain('animate-pulse');
    expect(silent).toBe('');
    const failed = render(<OverviewTiles data={null} loading={false} error onRetry={noop} />);
    expect(failed).not.toContain('animate-pulse');
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('Analytics.page.overviewFailed');
    expect(failed).toContain('Analytics.retry');
  });

  it('keeps the number filter when a selected number is set but the list is reloading', () => {
    const html = render(<NumberFilter numbers={[]} value="n2" onChange={noop} />);
    expect(html).toContain('<select');
    expect(render(<NumberFilter numbers={[]} value="" onChange={noop} />)).toBe('');
    const two = [{ id: 'n1', label: 'Main', isDefault: true }, { id: 'n2', label: null, isDefault: false }];
    expect(render(<NumberFilter numbers={two} value="n2" onChange={noop} />)).toContain('value="n2" selected');
  });

  it('pairs every chart with an accessible table', () => {
    const html = render(<ConversationCharts data={report} loading={false} error={false} onRetry={noop} />);
    expect(html.match(/role="img"/g)).toHaveLength(3);
    expect(html.match(/<table/g)).toHaveLength(3);
    expect(html).toContain('scope="col"');
    expect(html).toContain('scope="row"');
  });

  it('shows a retry on error and an empty state without data', () => {
    expect(render(<ConversationCharts data={null} loading={false} error onRetry={noop} />)).toContain('role="alert"');
    const empty = { ...report, current: stats({ started: { total: 0, inbound: 0, business: 0, campaignReply: 0 }, byLifecycle: { bot: 0, requesting: 0, assigned: 0, resolved: 0 },
      firstResponse: { count: 0, unanswered: 0, medianSeconds: null, p90Seconds: null }, resolution: { resolved: 0, count: 0, medianSeconds: null, p90Seconds: null } }) };
    expect(render(<ConversationCharts data={empty} loading={false} error={false} onRetry={noop} />)).toContain('Analytics.emptyTitle');
  });

  it('lists the leaderboard, campaign funnel and flow drop-off as tables', () => {
    const board = render(<AgentLeaderboard loading={false} error={false} onRetry={noop} agents={[
      { userId: 'u1', name: 'Asha', role: 'agent', conversationsHandled: 3, repliesSent: 9, firstResponseCount: 2, medianFirstResponseSeconds: 30, resolved: 1 }]} />);
    expect(board).toContain('Asha');
    expect(board).toContain('<table');

    const totals = { recipients: 100, sent: 90, delivered: 80, read: 40, replied: 9, clicked: 4, failed: 10 };
    const funnel = render(<CampaignFunnel loading={false} error={false} onRetry={noop}
      funnel={{ totals, broadcasts: [{ ...totals, id: 'b1', name: 'Diwali', templateName: 'offer', at: null }] }} />);
    expect(funnel).toContain('Diwali');
    expect(funnel).toContain('Analytics.campaigns.percent');

    const flows = render(<FlowDropOff loading={false} error={false} onRetry={noop} flowId="" onFlowChange={noop}
      flows={[{ id: 'f1', name: 'Welcome' }]}
      stats={{ started: 5, completed: 2, handedOff: 1, timedOut: 1, failed: 1, cancelled: 0, active: 0,
        dropOff: [{ flowId: 'f1', nodeKey: 'ask_name', nodeType: 'question', runs: 2 }] }} />);
    expect(flows).toContain('Welcome · ask_name (question)');
    expect(flows).toContain('<select');
  });
});
