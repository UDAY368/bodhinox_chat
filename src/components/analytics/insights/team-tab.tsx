'use client';

/**
 * Analytics > Team: what each member handled and how quickly. Headline cards,
 * resolved by member, and a searchable, sortable members table with CSV
 * export. Selecting a member opens their detail: figures, handled and resolved
 * over time, a by-channel split, an export and a link to their chats.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Download, Search } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';

import { Button, buttonVariants } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import type { GroupRow, MemberDetail, Presence, TeamMemberRow } from '@/lib/analytics/insights';
import { reportQuery, useDuration, useReport } from '@/components/analytics/shared';
import { cn } from '@/lib/utils';
import { BarList, CHART_COLORS, XYChart } from './charts';
import { useAnalyticsFilters } from './context';
import { downloadCsv } from './csv';
import { useBucketLabels, useDelta } from './format';
import { Empty, Grid, InsightCard, Loadable, SortableTable, StatRow, type Column } from './parts';

interface TeamResponse {
  range: { startDay: string; endDay: string; days: number; timezone: string };
  previousRange: { startDay: string; endDay: string };
  members: TeamMemberRow[];
  previous: TeamMemberRow[];
}

const sum = (rows: TeamMemberRow[], key: 'handled' | 'resolved' | 'msgs') => rows.reduce((a, r) => a + r[key], 0);
/** Members' median first responses weighted by how many each measured. */
function weightedFirstResponse(rows: TeamMemberRow[]): number | null {
  const measured = rows.filter((r) => r.frtMedian != null && r.frtCount > 0);
  const w = measured.reduce((a, r) => a + r.frtCount, 0);
  return w ? measured.reduce((a, r) => a + r.frtMedian! * r.frtCount, 0) / w : null;
}

const presenceClass: Record<Presence, string> = {
  online: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-400',
  away: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  offline: 'bg-muted text-muted-foreground',
};

function Initials({ name }: { name: string }) {
  const letters = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('') || '?';
  return <span aria-hidden className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-primary-soft text-[11px] font-semibold text-primary">{letters}</span>;
}

export function TeamTab() {
  const t = useTranslations('Analytics.insights.team');
  const tRoles = useTranslations('Sidebar');
  const format = useFormatter();
  const duration = useDuration();
  const delta = useDelta();
  const { query, setShown } = useAnalyticsFilters();
  const team = useReport<TeamResponse>('team', query);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<TeamMemberRow | null>(null);
  const data = team.data;
  useEffect(() => {
    if (data) setShown({ range: data.range, previousRange: data.previousRange });
  }, [data, setShown]);

  const n = (v: number) => format.number(v);
  const roleKey: Record<string, string> = { owner: 'roleOwner', admin: 'roleAdmin', agent: 'roleAgent', viewer: 'roleViewer' };
  const role = (r: string) => (roleKey[r] ? tRoles(roleKey[r]) : r);
  const name = (m: TeamMemberRow) => m.name || t('unnamed');
  const members = data?.members ?? [];
  const previous = data?.previous ?? [];
  const q = search.trim().toLowerCase();
  const rows = members.filter((m) => !q || name(m).toLowerCase().includes(q) || role(m.role).toLowerCase().includes(q));
  const firstResponse = weightedFirstResponse(members);

  const stats = [
    { label: t('stats.handled'), value: data ? n(sum(members, 'handled')) : '–', delta: data && delta(sum(members, 'handled'), sum(previous, 'handled')) },
    { label: t('stats.resolved'), value: data ? n(sum(members, 'resolved')) : '–', delta: data && delta(sum(members, 'resolved'), sum(previous, 'resolved')) },
    { label: t('stats.firstResponse'), value: data ? duration(firstResponse) : '–', delta: data && delta(firstResponse, weightedFirstResponse(previous), true) },
    { label: t('stats.messages'), value: data ? n(sum(members, 'msgs')) : '–', delta: data && delta(sum(members, 'msgs'), sum(previous, 'msgs')) },
    { label: t('stats.online'), value: data ? t('onlineOf', { online: members.filter((m) => m.presence === 'online').length, total: members.length }) : '–' },
  ];

  const columns: Column<TeamMemberRow>[] = [
    {
      key: 'name', label: t('cols.member'), sort: (r) => name(r).toLowerCase(),
      cell: (r) => (
        <button type="button" onClick={(e) => { e.stopPropagation(); setOpen(r); }} aria-label={t('openMember', { name: name(r) })}
          className="flex min-w-0 items-center gap-2.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
          <Initials name={name(r)} />
          <span className="flex min-w-0 flex-col">
            <strong className="truncate font-semibold">{name(r)}</strong>
            <small className="truncate text-xs text-muted-foreground">{role(r.role)}</small>
          </span>
        </button>
      ),
    },
    { key: 'handled', label: t('cols.handled'), numeric: true, sort: (r) => r.handled, cell: (r) => n(r.handled) },
    { key: 'msgs', label: t('cols.messages'), numeric: true, sort: (r) => r.msgs, cell: (r) => n(r.msgs) },
    { key: 'resolved', label: t('cols.resolved'), numeric: true, sort: (r) => r.resolved, cell: (r) => n(r.resolved) },
    { key: 'frt', label: t('cols.firstResponse'), numeric: true, sort: (r) => r.frtMedian ?? Number.MAX_SAFE_INTEGER, cell: (r) => duration(r.frtMedian) },
    {
      key: 'presence', label: t('cols.status'), numeric: true, sort: (r) => ({ online: 0, away: 1, offline: 2 })[r.presence],
      cell: (r) => <span className={cn('inline-flex rounded-full px-2 py-0.5 text-xs font-medium', presenceClass[r.presence])}>{t(`presence.${r.presence}`)}</span>,
    },
  ];
  const exportTeam = () => downloadCsv(`${t('fileName')} ${data?.range.startDay ?? ''} ${data?.range.endDay ?? ''}`,
    [t('cols.member'), t('cols.role'), t('cols.handled'), t('cols.messages'), t('cols.resolved'), t('cols.firstResponseSeconds'), t('cols.status')],
    members.map((m) => [name(m), role(m.role), m.handled, m.msgs, m.resolved, m.frtMedian ?? '', t(`presence.${m.presence}`)]));

  return (
    <div className="space-y-4">
      <StatRow stats={stats} loading={team.loading} />
      <Grid>
        <InsightCard title={t('resolvedTitle')} sub={t('resolvedSub')}>
          <Loadable loading={team.loading} error={team.error} onRetry={team.retry} height="h-32">
            {members.length ? (
              <BarList label={t('resolvedTitle')} rows={[...members].sort((a, b) => b.resolved - a.resolved).map((m) => ({
                key: m.userId, name: name(m), value: m.resolved, text: n(m.resolved), lead: <Initials name={name(m)} />,
                onClick: () => setOpen(m), action: t('openMember', { name: name(m) }),
              }))} />
            ) : <Empty title={t('noMembers')} />}
          </Loadable>
        </InsightCard>
        <InsightCard title={t('tableTitle')} sub={t('tableSub')}
          tools={
            <div className="flex w-full flex-wrap items-center gap-2 min-[761px]:w-auto">
              <label className="relative min-w-0 flex-1 min-[761px]:w-56 min-[761px]:flex-none">
                <span className="sr-only">{t('search')}</span>
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('search')} className="h-8 pl-8" />
              </label>
              <Button size="sm" variant="outline" onClick={exportTeam} disabled={!members.length}><Download aria-hidden />{t('exportCsv')}</Button>
            </div>
          }>
          <Loadable loading={team.loading} error={team.error} onRetry={team.retry}>
            {rows.length ? (
              <SortableTable caption={t('tableTitle')} columns={columns} rows={rows} rowKey={(r) => r.userId}
                initial={{ key: 'resolved', dir: -1 }} onRow={setOpen} />
            ) : (
              <Empty title={t('noMatch')} text={t('noMatchHint')} action={<Button size="sm" variant="ghost" onClick={() => setSearch('')}>{t('clearSearch')}</Button>} />
            )}
            <p className="mt-3 text-xs text-muted-foreground">{t('attribution')}</p>
          </Loadable>
        </InsightCard>
      </Grid>
      {open && <MemberDialog member={open} roleName={role(open.role)} name={name(open)} onClose={() => setOpen(null)} />}
    </div>
  );
}

function MemberDialog({ member, name, roleName, onClose }: { member: TeamMemberRow; name: string; roleName: string; onClose: () => void }) {
  const t = useTranslations('Analytics.insights.team');
  const tc = useTranslations('Analytics.channel');
  const format = useFormatter();
  const duration = useDuration();
  const labels = useBucketLabels();
  const { query } = useAnalyticsFilters();
  const detail = useReport<{ detail: MemberDetail }>('team', `${query}${query ? '&' : ''}${reportQuery({ member: member.userId })}`);
  const d = detail.data?.detail;
  const n = (v: number) => format.number(v);
  const bucket = d?.bucket ?? 'day';
  const totals: GroupRow | undefined = d?.totals;
  const exportMember = () => d && downloadCsv(`${name} ${labels.word(bucket)}`, [labels.word(bucket), t('cols.handled'), t('cols.resolved')],
    d.points.map((p) => [labels.long(p.key, bucket), p.handled, p.resolved]));
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{name}</DialogTitle>
          <DialogDescription>{roleName} · {t(`presence.${member.presence}`)}</DialogDescription>
        </DialogHeader>
        <Loadable loading={detail.loading} error={detail.error} onRetry={detail.retry}>
          {d && totals && (
            <div className="grid min-w-0 gap-4">
              <StatRow stats={[
                { label: t('cols.handled'), value: n(totals.handled) },
                { label: t('cols.resolved'), value: n(totals.resolved) },
                { label: t('cols.firstResponse'), value: duration(totals.frtMedian) },
                { label: t('cols.messages'), value: n(totals.msgs) },
              ]} />
              <div>
                <h3 className="text-sm font-semibold">{t('detailChart')}</h3>
                <XYChart label={t('detailChart')} height={190} labels={d.points.map((p) => labels.short(p.key, bucket))}
                  long={d.points.map((p) => labels.long(p.key, bucket))} format={(v) => n(v ?? 0)}
                  series={[
                    { key: 'handled', name: t('cols.handled'), color: CHART_COLORS.primary, area: true, values: d.points.map((p) => p.handled) },
                    { key: 'resolved', name: t('cols.resolved'), color: CHART_COLORS.secondary, dash: true, values: d.points.map((p) => p.resolved) },
                  ]} />
              </div>
              <div>
                <h3 className="mb-1 text-sm font-semibold">{t('byChannel')}</h3>
                <BarList label={t('byChannel')} rows={d.channels.map((c) => ({
                  key: c.key, name: tc(c.key as 'whatsapp' | 'instagram'), value: c.handled, text: n(c.handled),
                  color: c.key === 'whatsapp' ? CHART_COLORS.whatsapp : CHART_COLORS.instagram,
                }))} />
              </div>
              <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 border-t border-border pt-3 text-sm">
                <dt className="text-muted-foreground">{t('medianResolution')}</dt><dd className="text-right tabular-nums">{duration(totals.resMedian)}</dd>
                <dt className="text-muted-foreground">{t('resolutionRate')}</dt>
                <dd className="text-right tabular-nums">{totals.handled ? `${Math.round(Math.min(100, (totals.resolved / totals.handled) * 100))}%` : '–'}</dd>
              </dl>
            </div>
          )}
        </Loadable>
        <DialogFooter>
          <Button variant="outline" onClick={exportMember} disabled={!d}><Download aria-hidden />{t('exportCsv')}</Button>
          <Link href={`/inbox?agent=${encodeURIComponent(member.userId)}`} className={buttonVariants()}>{t('openChats')}</Link>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
