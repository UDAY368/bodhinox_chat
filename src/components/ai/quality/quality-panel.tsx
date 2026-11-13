'use client';

// AI page, Quality tab (admins with 'ai.settings'; it shows customer text):
// four outcome cards for suggested replies, a By day / By outcome chart, the
// safety checks that fired, team ratings, and the recent AI replies (suggested
// and sent by agents) with filters and helpful / not helpful buttons. Every
// number comes from what the app records (GET /api/ai/quality/dashboard);
// ratings are saved per member (PUT /api/ai/quality/ratings).

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, ShieldCheck, ThumbsDown, ThumbsUp } from 'lucide-react';
import { authFetch } from '@/lib/auth/client';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { segmentedItem, segmentedTrack } from '@/components/dashboard/segmented';
import { cn } from '@/lib/utils';
import { applyVote, OUTCOMES, REPLY_FILTERS, share, type QualityReplyView, type QualityView, type ReplyFilter } from './quality-view';

const OUTCOME_BORDER = { accepted: 'border-t-emerald-500', edited: 'border-t-primary', rejected: 'border-t-destructive', unused: 'border-t-muted-foreground' } as const;
const OUTCOME_FILL = { accepted: 'bg-emerald-500', edited: 'bg-primary', rejected: 'bg-destructive', unused: 'bg-muted-foreground' } as const;
const RESULT_VARIANT = { accepted: 'secondary', edited: 'outline', rejected: 'destructive', shown: 'outline', sent: 'secondary' } as const;

export function QualityPanel({ onWriteAnswer }: { onWriteAnswer?: (question: string) => void }) {
  const t = useTranslations('AiStudio.quality');
  const tc = useTranslations('AiStudio.common');
  const format = useFormatter();
  const [filter, setFilter] = useState<ReplyFilter>('all');
  const [view, setView] = useState<QualityView | null>(null);
  const [failed, setFailed] = useState(false);
  const [chart, setChart] = useState<'day' | 'outcome'>('day');
  const [open, setOpen] = useState<QualityReplyView | null>(null);
  const [voting, setVoting] = useState<string | null>(null);

  const load = useCallback(async (f: ReplyFilter) => {
    setFailed(false);
    try {
      const res = await authFetch(`/api/ai/quality/dashboard?filter=${f}`, { cache: 'no-store' });
      if (!res.ok) throw new Error();
      setView(await res.json());
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => { void load(filter); }, [load, filter]);

  const vote = async (reply: QualityReplyView, v: 'up' | 'down') => {
    const next = reply.my_vote === v ? null : v;
    setVoting(reply.id);
    try {
      const res = await authFetch('/api/ai/quality/ratings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: reply.kind, id: reply.id, vote: next }),
      });
      if (!res.ok) throw new Error();
      setView((current) => (current ? applyVote(current, reply.id, next) : current));
      setOpen((o) => (o && o.id === reply.id ? { ...o, my_vote: next } : o));
      toast.success(next === null ? t('toasts.cleared') : next === 'up' ? t('toasts.up') : t('toasts.down'));
    } catch {
      toast.error(tc('failed'));
    } finally {
      setVoting(null);
    }
  };

  if (failed) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4 text-sm">
        <p className="text-destructive">{tc('loadFailed')}</p>
        <Button type="button" size="sm" variant="outline" onClick={() => void load(filter)}>{tc('retry')}</Button>
      </div>
    );
  }
  if (!view) return <div className="flex justify-center py-10"><Loader2 className="size-5 animate-spin text-muted-foreground" aria-label={tc('loading')} /></div>;

  const o = view.outcomes;
  const shown = o.accepted + o.edited + o.rejected + o.unused;
  const max = Math.max(1, ...view.daily.map((d) => d.shown));
  const busiest = Math.max(0, ...view.daily.map((d) => d.shown));
  const outcomeMax = Math.max(1, ...OUTCOMES.map((k) => o[k]));
  const rated = view.ratings.up + view.ratings.down;
  const safetyTotal = view.safety.reduce((n, s) => n + s.count, 0);
  const dayLabel = (day: string) => format.dateTime(new Date(`${day}T12:00:00`), { day: 'numeric', month: 'short' });
  const W = 600, H = 170, bw = W / Math.max(1, view.daily.length);
  const ticks = view.daily.length ? [0, Math.floor(view.daily.length / 3), Math.floor((2 * view.daily.length) / 3), view.daily.length - 1] : [];

  return (
    <div className="min-w-0 space-y-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">{t('windowTitle', { days: view.window_days })}</h2>
        <span className="text-[13px] text-muted-foreground tabular-nums">{t('shown', { n: format.number(shown) })}</span>
      </div>
      <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
        {OUTCOMES.map((k) => (
          <div key={k} className={cn('flex min-w-0 flex-col gap-0.5 rounded-xl border border-border border-t-[3px] bg-card p-3.5', OUTCOME_BORDER[k])}>
            <small className="text-xs text-muted-foreground">{t(`outcomes.${k}.label`)}</small>
            <strong className="text-2xl font-bold tracking-tight tabular-nums">{format.number(o[k])}</strong>
            <em className="text-xs not-italic text-muted-foreground tabular-nums">{t('pctOf', { n: share(o[k], shown) })}</em>
            <span className="text-xs text-muted-foreground">{t(`outcomes.${k}.hint`)}</span>
          </div>
        ))}
      </div>

      <div className="grid gap-3.5 lg:grid-cols-[minmax(0,1.6fr)_minmax(280px,1fr)] lg:items-start">
        <section className="min-w-0 rounded-xl border border-border bg-card p-4" aria-labelledby="ai-q-chart">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="ai-q-chart" className="text-base font-semibold">{chart === 'day' ? t('chartDay') : t('chartOutcome')}</h2>
            <div className={segmentedTrack} role="group" aria-label={t('chartLabel')}>
              <button type="button" aria-pressed={chart === 'day'} className={segmentedItem(chart === 'day')} onClick={() => setChart('day')}>{t('byDay')}</button>
              <button type="button" aria-pressed={chart === 'outcome'} className={segmentedItem(chart === 'outcome')} onClick={() => setChart('outcome')}>{t('byOutcome')}</button>
            </div>
          </div>
          {chart === 'day' ? (
            <div className="mt-4 flex flex-col gap-2">
              <svg className="block h-[170px] w-full" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={t('dayChartLabel', { max: busiest })}>
                <line x1="0" x2={W} y1={10} y2={10} className="stroke-border" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
                <line x1="0" x2={W} y1={H - (H - 10) / 2} y2={H - (H - 10) / 2} className="stroke-border" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
                {view.daily.map((d, i) => {
                  const bh = Math.max(2, (d.shown / max) * (H - 10));
                  return (
                    <rect key={d.day} x={i * bw + 3} y={H - bh} width={Math.max(1, bw - 6)} height={bh} rx={3} className="fill-primary opacity-90 transition-opacity hover:opacity-100">
                      <title>{t('dayBar', { day: dayLabel(d.day), n: d.shown })}</title>
                    </rect>
                  );
                })}
              </svg>
              <div className="flex justify-between text-xs text-muted-foreground">
                {ticks.map((i) => <span key={i}>{dayLabel(view.daily[i].day)}</span>)}
              </div>
              <p className="text-xs text-muted-foreground">{t('busiest', { max: busiest })}</p>
            </div>
          ) : (
            <div className="mt-4 flex flex-col gap-4 py-2">
              {OUTCOMES.map((k) => (
                <div key={k} className="grid grid-cols-[minmax(0,1fr)_52px_40px] items-center gap-x-3 gap-y-1 text-[13px] sm:grid-cols-[140px_minmax(0,1fr)_52px_40px]">
                  <span className="col-span-3 sm:col-span-1">{t(`outcomes.${k}.label`)}</span>
                  <div className="h-[22px] overflow-hidden rounded-md bg-muted" aria-hidden>
                    <i className={cn('block h-full rounded-md', OUTCOME_FILL[k])} style={{ width: `${(o[k] / outcomeMax) * 100}%` }} />
                  </div>
                  <b className="text-right tabular-nums">{format.number(o[k])}</b>
                  <span className="text-right text-muted-foreground tabular-nums">{share(o[k], shown)}%</span>
                </div>
              ))}
            </div>
          )}
        </section>

        <div className="flex min-w-0 flex-col gap-3.5">
          <section className="rounded-xl border border-border bg-card p-4" aria-labelledby="ai-q-safety">
            <div className="flex items-center justify-between gap-2">
              <h2 id="ai-q-safety" className="text-base font-semibold">{t('safetyTitle')}</h2>
              <Badge variant="outline" className="rounded-full tabular-nums"><ShieldCheck aria-hidden />{format.number(safetyTotal)}</Badge>
            </div>
            <ul className="my-3 flex flex-col">
              {view.safety.map((s) => (
                <li key={s.check} className="flex justify-between gap-3 border-t border-border py-2 text-[13px] first:border-t-0">
                  <span>{t(`checks.${s.check}`)}</span><b className="tabular-nums">{format.number(s.count)}</b>
                </li>
              ))}
            </ul>
            <small className="text-xs text-muted-foreground">{t('safetyNote')}</small>
          </section>
          <section className="rounded-xl border border-border bg-card p-4" aria-labelledby="ai-q-ratings">
            <div className="flex items-center justify-between gap-2">
              <h2 id="ai-q-ratings" className="text-base font-semibold">{t('ratingsTitle')}</h2>
              <Badge variant="secondary" className="rounded-full tabular-nums">{t('helpfulPct', { n: share(view.ratings.up, rated) })}</Badge>
            </div>
            <div className="my-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[13px] text-muted-foreground">
              <span className="inline-flex items-center gap-1.5 tabular-nums"><ThumbsUp className="size-3.5" aria-hidden /><b className="text-foreground">{format.number(view.ratings.up)}</b> {t('helpful')}</span>
              <span className="inline-flex items-center gap-1.5 tabular-nums"><ThumbsDown className="size-3.5" aria-hidden /><b className="text-foreground">{format.number(view.ratings.down)}</b> {t('notHelpful')}</span>
            </div>
            <div className={cn('h-2.5 overflow-hidden rounded-full', rated ? 'bg-destructive/45' : 'bg-muted')} aria-hidden>
              <i className="block h-full bg-emerald-500" style={{ width: `${rated ? (view.ratings.up / rated) * 100 : 0}%` }} />
            </div>
            {rated === 0 && <p className="mt-2 text-xs text-muted-foreground">{t('noRatings')}</p>}
          </section>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 pt-3">
        <h2 className="text-base font-semibold">{t('repliesTitle')}</h2>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('filterLabel')}>
          {REPLY_FILTERS.map((f) => (
            <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}
              className={cn('inline-flex h-8 items-center rounded-full border px-3 text-[13px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                filter === f ? 'border-primary bg-primary-soft text-primary' : 'border-border bg-card text-muted-foreground hover:text-foreground')}>
              {t(`filters.${f}`)}
            </button>
          ))}
        </div>
      </div>
      {view.replies.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-4 py-10 text-center">
          <h3 className="text-base font-semibold">{t('nothing')}</h3>
          <p className="text-sm text-muted-foreground">{filter === 'all' ? t('nothingYet') : t('nothingBody')}</p>
          {filter !== 'all' && <Button type="button" variant="outline" onClick={() => setFilter('all')}>{t('showAll')}</Button>}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card" role="table" aria-label={t('repliesTitle')}>
          <div role="row" className="hidden grid-cols-[170px_minmax(0,1fr)_130px_84px] gap-3.5 bg-muted px-4 py-2 text-xs font-semibold text-muted-foreground md:grid xl:grid-cols-[200px_minmax(0,1fr)_150px_84px]">
            <span role="columnheader">{t('cols.customer')}</span><span role="columnheader">{t('cols.reply')}</span>
            <span role="columnheader">{t('cols.result')}</span><span role="columnheader">{t('cols.helpful')}</span>
          </div>
          {view.replies.map((r) => {
            const name = r.contact_name || t('unknownContact');
            return (
              <div key={`${r.kind}:${r.id}`} role="row"
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2.5 border-t border-border px-4 py-3 transition-colors duration-150 [grid-template-areas:'who_votes''text_text''res_res'] first:border-t-0 hover:bg-muted/50 md:grid-cols-[170px_minmax(0,1fr)_130px_84px] md:[grid-template-areas:none] md:[&:nth-child(2)]:border-t-0 xl:grid-cols-[200px_minmax(0,1fr)_150px_84px]">
                <div role="cell" className="flex min-w-0 items-center gap-2.5 [grid-area:who] md:[grid-area:auto]">
                  <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold uppercase">{name.slice(0, 1)}</span>
                  <span className="min-w-0 leading-tight">
                    <strong className="block truncate text-sm font-semibold">{name}</strong>
                    <small className="block truncate text-xs text-muted-foreground">{format.dateTime(new Date(r.created_at), { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</small>
                  </span>
                </div>
                <button type="button" role="cell" onClick={() => setOpen(r)} aria-label={t('openReply', { name })}
                  className="group flex min-w-0 flex-col gap-0.5 rounded-md text-left [grid-area:text] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 md:[grid-area:auto]">
                  <span className="truncate text-sm font-medium transition-colors duration-150 group-hover:text-primary">{r.question || '—'}</span>
                  <span className="line-clamp-2 text-[13px] text-muted-foreground">{r.answer}</span>
                </button>
                <div role="cell" className="flex min-w-0 flex-row items-center gap-2 [grid-area:res] md:flex-col md:items-start md:gap-1 md:[grid-area:auto]">
                  <Badge variant={RESULT_VARIANT[r.outcome]} className="rounded-full">{t(`results.${r.outcome}`)}</Badge>
                  <small className="truncate text-xs text-muted-foreground">{r.kind === 'agent' ? (r.by ?? t('agentReply')) : t('suggestion')}</small>
                </div>
                <div role="cell" className="flex items-center gap-0.5 [grid-area:votes] md:[grid-area:auto]">
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={t('rateUp')} title={t('rateUp')} aria-pressed={r.my_vote === 'up'} disabled={voting === r.id}
                    className={cn(r.my_vote === 'up' && 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300')} onClick={() => void vote(r, 'up')}>
                    <ThumbsUp aria-hidden />
                  </Button>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={t('rateDown')} title={t('rateDown')} aria-pressed={r.my_vote === 'down'} disabled={voting === r.id}
                    className={cn(r.my_vote === 'down' && 'bg-destructive/15 text-destructive')} onClick={() => void vote(r, 'down')}>
                    <ThumbsDown aria-hidden />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {open && (
        <Dialog open onOpenChange={(v) => { if (!v) setOpen(null); }}>
          <DialogContent className="max-h-[90vh] overflow-y-auto border-border bg-popover sm:max-w-lg">
            <DialogHeader><DialogTitle>{t('detail.title', { name: open.contact_name || t('unknownContact') })}</DialogTitle></DialogHeader>
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <Badge variant="outline" className="rounded-full">{open.kind === 'agent' ? t('agentReply') : t('suggestion')}</Badge>
              <Badge variant={RESULT_VARIANT[open.outcome]} className="rounded-full">{t(`results.${open.outcome}`)}</Badge>
              <span className="text-muted-foreground">{format.dateTime(new Date(open.created_at), { dateStyle: 'medium', timeStyle: 'short' })}</span>
            </div>
            <div className="space-y-1 rounded-xl bg-muted px-3.5 py-3">
              <small className="text-xs text-muted-foreground">{t('detail.asked', { name: open.contact_name || t('unknownContact') })}</small>
              <p className="text-sm whitespace-pre-wrap break-words">{open.question || '—'}</p>
            </div>
            <div className="space-y-1 rounded-xl bg-primary-soft px-3.5 py-3">
              <small className="text-xs text-muted-foreground">{open.kind === 'agent' ? t('detail.agentReplied', { name: open.by ?? t('agentReply') }) : t('detail.suggested')}</small>
              <p className="text-sm whitespace-pre-wrap break-words">{open.answer}</p>
            </div>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[13px]">
              <dt className="text-muted-foreground">{t('detail.source')}</dt><dd className="break-words">{open.source ?? '—'}</dd>
              <dt className="text-muted-foreground">{open.kind === 'agent' ? t('detail.agent') : t('detail.shownTo')}</dt><dd className="break-words">{open.by ?? '—'}</dd>
              <dt className="text-muted-foreground">{t('detail.rating')}</dt>
              <dd>{open.my_vote === 'up' ? t('rateUp') : open.my_vote === 'down' ? t('rateDown') : t('detail.notRated')}</dd>
            </dl>
            <DialogFooter>
              {open.conversation_id && (
                <Link href={`/inbox?c=${encodeURIComponent(open.conversation_id)}`} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                  {t('detail.openConversation')}
                </Link>
              )}
              {onWriteAnswer && open.question && (
                <Button type="button" onClick={() => { const q = open.question ?? ''; setOpen(null); onWriteAnswer(q); }}>{t('detail.writeBetter')}</Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
