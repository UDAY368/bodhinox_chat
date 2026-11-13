'use client';

/**
 * Analytics > Campaigns: how broadcasts and automations performed. Headline
 * cards, the broadcast funnel as counts or rates, the busiest automations by
 * runs or click rate (each links to its editor), the period's broadcasts
 * (select one for its own funnel and export), runs by kind, then the flow
 * drop-off and the comparisons. Broadcast figures are WhatsApp only.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Download } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';

import { Button, buttonVariants } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useAuth } from '@/hooks/use-auth';
import { hasMinRole } from '@/lib/auth/roles';
import type { AutomationRunRow, AutomationStats } from '@/lib/analytics/insights';
import type { CampaignFunnel, FlowStats, FunnelCounts } from '@/lib/analytics/queries';
import { CompareSection } from '@/components/analytics/compare-section';
import { FlowDropOff } from '@/components/analytics/flow-dropoff';
import { reportQuery, useReport } from '@/components/analytics/shared';
import { channelPath } from '@/lib/channels/routes';
import { BarList, CHART_COLORS, Donut, DonutWithKey, KeyRow, type BarRow } from './charts';
import { useAnalyticsFilters } from './context';
import { downloadCsv } from './csv';
import { useDelta } from './format';
import { Empty, Grid, InsightCard, Loadable, MiniToggle, SortableTable, StatRow, type Column } from './parts';

interface CampaignsResponse {
  range: { startDay: string; endDay: string; days: number; timezone: string };
  funnel: CampaignFunnel;
  previous: { totals: FunnelCounts; count: number };
}
type Broadcast = CampaignFunnel['broadcasts'][number];

const STEPS = ['sent', 'delivered', 'read', 'replied', 'clicked', 'failed'] as const;
const ratio = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : null);

/** Where an automation is edited. */
export function automationHref(a: Pick<AutomationRunRow, 'id' | 'kind' | 'channel'>): string {
  if (a.kind === 'flow') return `/flows/${a.id}`;
  if (a.kind === 'rule') return channelPath(a.channel === 'instagram' ? 'instagram' : 'whatsapp', 'automations', a.id);
  return a.channel === 'instagram' ? `/instagram/sequences/${a.id}` : '/automation';
}

export function CampaignsTab() {
  const t = useTranslations('Analytics.insights.campaigns');
  const ts = useTranslations('Analytics.campaigns.stage');
  const format = useFormatter();
  const delta = useDelta();
  const { accountRole } = useAuth();
  const { channel, channelQuery, rangeQuery, setShown } = useAnalyticsFilters();
  const whatsappHidden = channel === 'instagram';
  const campaigns = useReport<CampaignsResponse>('campaigns', rangeQuery, !whatsappHidden);
  const automations = useReport<{ range: CampaignsResponse['range']; automations: AutomationStats; previousTotal: number }>('automations', channelQuery);
  const [flowId, setFlowId] = useState('');
  const flows = useReport<{ stats: FlowStats; flows: { id: string; name: string }[] }>('flows', `${rangeQuery}${rangeQuery ? '&' : ''}${reportQuery({ flow: flowId })}`);
  const [mode, setMode] = useState<'counts' | 'rates'>('counts');
  const [metric, setMetric] = useState<'runs' | 'ctr'>('runs');
  const [open, setOpen] = useState<Broadcast | null>(null);
  const shownRange = automations.data?.range;
  useEffect(() => {
    if (shownRange) setShown({ range: shownRange, previousRange: null });
  }, [shownRange, setShown]);

  const n = (v: number) => format.number(v);
  const pct = (v: number | null, digits = 1) => (v == null ? '–' : `${format.number(v, { maximumFractionDigits: digits, minimumFractionDigits: digits })}%`);
  const f = campaigns.data?.funnel, prev = campaigns.data?.previous;
  const tot = f?.totals;
  const a = automations.data?.automations;
  const has = Boolean(f && f.broadcasts.length);

  const stats = [
    ...(whatsappHidden ? [] : [
      { label: t('stats.broadcasts'), value: f ? n(f.broadcasts.length) : '–', delta: f && prev && delta(f.broadcasts.length, prev.count) },
      { label: t('stats.sent'), value: tot ? n(tot.sent) : '–', delta: tot && prev && delta(tot.sent, prev.totals.sent) },
      { label: t('stats.delivered'), value: tot && has ? pct(ratio(tot.delivered, tot.sent)) : '–', delta: tot && prev && has ? delta(ratio(tot.delivered, tot.sent), ratio(prev.totals.delivered, prev.totals.sent)) : null },
      { label: t('stats.read'), value: tot && has ? pct(ratio(tot.read, tot.delivered), 0) : '–', delta: tot && prev && has ? delta(ratio(tot.read, tot.delivered), ratio(prev.totals.read, prev.totals.delivered)) : null },
      { label: t('stats.replied'), value: tot && has ? pct(ratio(tot.replied, tot.delivered)) : '–', delta: tot && prev && has ? delta(ratio(tot.replied, tot.delivered), ratio(prev.totals.replied, prev.totals.delivered)) : null },
    ]),
    { label: t('stats.runs'), value: a ? n(a.total) : '–', delta: a && delta(a.total, automations.data!.previousTotal) },
  ];

  const funnelRows = (counts: FunnelCounts): BarRow[] => STEPS.map((k) => ({
    key: k, name: ts(k),
    value: mode === 'rates' ? ratio(counts[k], counts.sent) ?? 0 : counts[k],
    text: mode === 'rates' ? pct(ratio(counts[k], counts.sent)) : n(counts[k]),
    color: k === 'failed' ? CHART_COLORS.bad : undefined,
  }));
  const ranked = a ? (metric === 'runs' ? a.top : a.top.filter((x) => x.clickRate != null).sort((x, y) => (y.clickRate ?? 0) - (x.clickRate ?? 0))) : [];
  const kinds = a ? (['flow', 'rule', 'sequence'] as const).map((k, i) => ({
    key: k, name: t(`kinds.${k}`), color: [CHART_COLORS.primary, CHART_COLORS.secondary, CHART_COLORS.whatsapp][i], value: a.byKind[k],
  })) : [];

  const columns: Column<Broadcast>[] = [
    {
      key: 'name', label: t('cols.broadcast'), sort: (b) => b.name.toLowerCase(),
      cell: (b) => (
        <button type="button" onClick={(e) => { e.stopPropagation(); setOpen(b); }} aria-label={t('openBroadcast', { name: b.name })}
          className="flex min-w-0 flex-col rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
          <strong className="truncate font-semibold">{b.name}</strong>
          <small className="truncate text-xs text-muted-foreground">{b.templateName}</small>
        </button>
      ),
    },
    { key: 'at', label: t('cols.sentOn'), sort: (b) => b.at ?? '', cell: (b) => (b.at ? format.dateTime(new Date(b.at), { day: 'numeric', month: 'short' }) : '–') },
    { key: 'sent', label: ts('sent'), numeric: true, sort: (b) => b.sent, cell: (b) => n(b.sent) },
    { key: 'delivered', label: ts('delivered'), numeric: true, sort: (b) => ratio(b.delivered, b.sent) ?? -1, cell: (b) => pct(ratio(b.delivered, b.sent)) },
    { key: 'read', label: ts('read'), numeric: true, sort: (b) => ratio(b.read, b.delivered) ?? -1, cell: (b) => pct(ratio(b.read, b.delivered), 0) },
    { key: 'replied', label: ts('replied'), numeric: true, sort: (b) => ratio(b.replied, b.delivered) ?? -1, cell: (b) => pct(ratio(b.replied, b.delivered)) },
  ];
  const exportBroadcasts = () => f && downloadCsv(`${t('fileName')} ${campaigns.data?.range.startDay ?? ''} ${campaigns.data?.range.endDay ?? ''}`,
    [t('cols.broadcast'), t('cols.template'), t('cols.sentOn'), ...STEPS.map((k) => ts(k))],
    f.broadcasts.map((b) => [b.name, b.templateName, b.at ? b.at.slice(0, 10) : '', ...STEPS.map((k) => b[k])]));
  const canSeeProducts = accountRole ? hasMinRole(accountRole, 'agent') : false;

  return (
    <div className="space-y-4">
      <StatRow stats={stats} loading={automations.loading || (!whatsappHidden && campaigns.loading)} />
      {whatsappHidden && <p className="text-xs text-muted-foreground">{t('whatsappOnly')}</p>}
      <Grid>
        {!whatsappHidden && (
          <InsightCard span={6} title={t('funnelTitle')} sub={t('funnelSub', { count: f?.broadcasts.length ?? 0 })}
            tools={<MiniToggle label={t('funnelMode')} value={mode} onChange={setMode} options={[['counts', t('counts')], ['rates', t('rates')]]} />}>
            <Loadable loading={campaigns.loading} error={campaigns.error} onRetry={campaigns.retry} height="h-40">
              {f && has ? (
                <BarList label={t('funnelTitle')} rows={funnelRows(f.totals)} max={mode === 'rates' ? 100 : Math.max(1, f.totals.sent)} />
              ) : (
                <Empty title={t('noBroadcasts')} text={t('noBroadcastsHint')}
                  action={<Link href={channelPath('whatsapp', 'broadcasts')} className={buttonVariants({ size: 'sm', variant: 'outline' })}>{t('openCampaigns')}</Link>} />
              )}
            </Loadable>
          </InsightCard>
        )}
        <InsightCard span={whatsappHidden ? 8 : 6} title={t('topTitle')} sub={metric === 'runs' ? t('topSubRuns') : t('topSubCtr')}
          tools={<MiniToggle label={t('topMode')} value={metric} onChange={setMetric} options={[['runs', t('runs')], ['ctr', t('clickRate')]]} />}>
          <Loadable loading={automations.loading} error={automations.error} onRetry={automations.retry} height="h-40">
            {ranked.length ? (
              <BarList label={t('topTitle')} max={metric === 'runs' ? undefined : 100} rows={ranked.slice(0, 10).map((x) => ({
                key: `${x.kind}-${x.id}`, name: x.name, value: metric === 'runs' ? x.runs : x.clickRate ?? 0,
                text: metric === 'runs' ? n(x.runs) : `${x.clickRate}%`, href: automationHref(x),
                action: t('openAutomation', { name: x.name }),
                lead: <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{t(`kinds.${x.kind}One`)}</span>,
              }))} />
            ) : <Empty title={t('noAutomations')} text={metric === 'runs' ? t('noAutomationsHint') : t('noClicksHint')} />}
          </Loadable>
        </InsightCard>
        {!whatsappHidden && (
          <InsightCard span={8} title={t('tableTitle')} sub={t('tableSub')}
            tools={has ? <Button size="sm" variant="outline" onClick={exportBroadcasts}><Download aria-hidden />{t('exportCsv')}</Button> : undefined}>
            <Loadable loading={campaigns.loading} error={campaigns.error} onRetry={campaigns.retry}>
              {f && has ? (
                <SortableTable caption={t('tableTitle')} columns={columns} rows={f.broadcasts} rowKey={(b) => b.id} initial={{ key: 'at', dir: -1 }} onRow={setOpen} />
              ) : <p className="py-5 text-center text-sm text-muted-foreground">{t('nothingSent')}</p>}
            </Loadable>
          </InsightCard>
        )}
        <InsightCard span={4} title={t('kindsTitle')} sub={t('kindsSub')}>
          <Loadable loading={automations.loading} error={automations.error} onRetry={automations.retry} height="h-40">
            <DonutWithKey donut={<Donut label={t('kindsTitle')} segments={kinds} centre={a ? n(a.total) : '0'} sub={t('runsWord')} format={n} />}>
              {kinds.map((k) => <KeyRow key={k.key} color={k.color} name={k.name} value={n(k.value)} />)}
            </DonutWithKey>
          </Loadable>
        </InsightCard>
      </Grid>
      <FlowDropOff stats={flows.data?.stats ?? null} flows={flows.data?.flows ?? []} flowId={flowId} onFlowChange={setFlowId}
        loading={flows.loading} error={flows.error} onRetry={flows.retry} />
      {!whatsappHidden && <CompareSection query={rangeQuery} campaigns={f?.broadcasts ?? []} showProducts={canSeeProducts} />}
      {open && <BroadcastDialog broadcast={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function BroadcastDialog({ broadcast: b, onClose }: { broadcast: Broadcast; onClose: () => void }) {
  const t = useTranslations('Analytics.insights.campaigns');
  const ts = useTranslations('Analytics.campaigns.stage');
  const format = useFormatter();
  const n = (v: number) => format.number(v);
  const pct = (v: number | null, digits = 1) => (v == null ? '–' : `${format.number(v, { maximumFractionDigits: digits, minimumFractionDigits: digits })}%`);
  const exportOne = () => downloadCsv(b.name, [t('cols.step'), t('cols.people'), t('cols.shareOfSent')],
    STEPS.map((k) => [ts(k), b[k], ratio(b[k], b.sent) == null ? '' : `${(ratio(b[k], b.sent) as number).toFixed(1)}%`]));
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{b.name}</DialogTitle>
          <DialogDescription>
            {b.templateName}{b.at ? ` · ${t('sentOn', { date: format.dateTime(new Date(b.at), { dateStyle: 'medium' }) })}` : ''}
          </DialogDescription>
        </DialogHeader>
        <StatRow stats={[
          { label: ts('sent'), value: n(b.sent) },
          { label: ts('delivered'), value: pct(ratio(b.delivered, b.sent)) },
          { label: ts('read'), value: pct(ratio(b.read, b.delivered), 0) },
          { label: ts('replied'), value: pct(ratio(b.replied, b.delivered)) },
        ]} />
        <BarList label={t('funnelTitle')} max={Math.max(1, b.sent)} rows={STEPS.map((k) => ({
          key: k, name: ts(k), value: b[k], text: `${n(b[k])} · ${pct(ratio(b[k], b.sent))}`, color: k === 'failed' ? CHART_COLORS.bad : undefined,
        }))} />
        <DialogFooter>
          <Button variant="outline" onClick={exportOne}><Download aria-hidden />{t('exportCsv')}</Button>
          <Link href={channelPath('whatsapp', 'broadcasts')} className={buttonVariants()}>{t('openCampaigns')}</Link>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
