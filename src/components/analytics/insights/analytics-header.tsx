'use client';

/**
 * Heading and filters of the analytics tabs: the tab's title, the range
 * (Today, 7, 30 or 90 days, a calendar period, or custom dates picked in a
 * validated dialog), the channel menu and the WhatsApp number filter, then a
 * caption naming the range shown and what it is compared with.
 */

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { CalendarDays } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { quietSelect, segmentedItem, segmentedTrack } from '@/components/dashboard/segmented';
import { NumberFilter, type Preset } from '@/components/analytics/range-picker';
import { customRangeIssue } from '@/lib/analytics/saved-report-shape';
import { useAnalyticsFilters } from './context';

const QUICK: Exclude<Preset, 'custom'>[] = ['today', '7d', '30d', '90d'];
const CALENDAR: Exclude<Preset, 'custom'>[] = ['this_week', 'last_week', 'this_month', 'last_month'];
/** Presets whose range ends today (so the shown end day is the workspace's today). */
const ENDS_TODAY = new Set(['today', '7d', '30d', '90d', 'this_week', 'this_month']);
export type AnalyticsTab = 'overview' | 'conversations' | 'team' | 'campaigns';

export function tabOf(pathname: string): AnalyticsTab {
  const sub = pathname.split('/')[2];
  return sub === 'conversations' || sub === 'team' || sub === 'campaigns' ? sub : 'overview';
}

/** Today in the browser's zone, YYYY-MM-DD (the server clamps to the workspace's today). */
function browserToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function CustomRangeDialog({ open, onOpenChange, initial, today, onApply }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: { from?: string; to?: string };
  today: string;
  onApply: (from: string, to: string) => void;
}) {
  const t = useTranslations('Analytics.insights.custom');
  const tr = useTranslations('Analytics.range');
  const [from, setFrom] = useState(initial.from ?? '');
  const [to, setTo] = useState(initial.to ?? '');
  const [error, setError] = useState<string | null>(null);
  const apply = (event: React.FormEvent) => {
    event.preventDefault();
    const issue = customRangeIssue(from, to, today);
    if (issue) {
      setError(t(`errors.${issue}`));
      return;
    }
    onApply(from, to);
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={apply} noValidate className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t('title')}</DialogTitle>
            <DialogDescription>{t('description')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 min-[480px]:grid-cols-2">
            <label className="grid gap-1 text-xs font-medium text-muted-foreground">
              {tr('from')}
              <Input type="date" value={from} max={today} onChange={(e) => { setFrom(e.target.value); setError(null); }} aria-invalid={Boolean(error)} />
            </label>
            <label className="grid gap-1 text-xs font-medium text-muted-foreground">
              {tr('to')}
              <Input type="date" value={to} max={today} onChange={(e) => { setTo(e.target.value); setError(null); }} aria-invalid={Boolean(error)} />
            </label>
          </div>
          {error && <p role="alert" className="text-xs font-medium text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t('cancel')}</Button>
            <Button type="submit">{tr('apply')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function AnalyticsHeader() {
  const t = useTranslations('Analytics.insights');
  const tr = useTranslations('Analytics.range');
  const tc = useTranslations('Analytics.channel');
  const format = useFormatter();
  const tab = tabOf(usePathname());
  const { range, setRange, channel, setChannel, number, setNumber, numbers, shown } = useAnalyticsFilters();
  const [customOpen, setCustomOpen] = useState(false);
  const custom = range.preset === 'custom';
  const day = (d: string) => format.dateTime(new Date(`${d}T00:00:00Z`), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const customLabel = custom && range.from && range.to ? (range.from === range.to ? day(range.from) : `${day(range.from)} – ${day(range.to)}`) : tr('custom');
  const today = shown?.range.endDay && ENDS_TODAY.has(shown.range.preset ?? '') ? shown.range.endDay : browserToday();

  return (
    <div className="space-y-3">
      <header className="min-w-0">
        <h1 className="text-[22px] leading-tight font-bold tracking-tight text-foreground">{t(`tabs.${tab}.title`)}</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t(`tabs.${tab}.description`)}</p>
      </header>
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label={tr('label')} className={`${segmentedTrack} w-full min-[761px]:w-auto`}>
          {QUICK.map((preset) => (
            <button key={preset} type="button" aria-pressed={range.preset === preset} onClick={() => setRange({ preset })}
              className={segmentedItem(range.preset === preset, 'flex-1 min-[761px]:flex-none')}>
              {tr(preset)}
            </button>
          ))}
          <button type="button" aria-pressed={custom} aria-haspopup="dialog" onClick={() => setCustomOpen(true)}
            className={segmentedItem(custom, 'flex-1 min-[761px]:flex-none')}>
            <CalendarDays aria-hidden />
            {customLabel}
          </button>
        </div>
        <select aria-label={tr('calendarLabel')} className={`${quietSelect} min-w-0 flex-1 min-[761px]:flex-none`}
          value={CALENDAR.includes(range.preset as (typeof CALENDAR)[number]) ? range.preset : ''}
          onChange={(e) => {
            const preset = e.target.value as (typeof CALENDAR)[number];
            if (CALENDAR.includes(preset)) setRange({ preset });
          }}>
          <option value="">{tr('calendar')}</option>
          {CALENDAR.map((preset) => <option key={preset} value={preset}>{tr(preset)}</option>)}
        </select>
        <select aria-label={tc('label')} className={`${quietSelect} min-w-0 flex-1 min-[761px]:flex-none`} value={channel}
          onChange={(e) => setChannel(e.target.value as typeof channel)}>
          <option value="">{tc('all')}</option>
          <option value="whatsapp">{tc('whatsapp')}</option>
          <option value="instagram">{tc('instagram')}</option>
        </select>
        {channel !== 'instagram' && <NumberFilter numbers={numbers} value={number} onChange={setNumber} />}
      </div>
      {shown && (
        <p className="text-[13px] text-muted-foreground" aria-live="polite">
          {t('caption', {
            from: day(shown.range.startDay),
            to: day(shown.range.endDay),
            channel: channel ? tc(channel) : tc('all'),
          })}
          {shown.previousRange ? ` ${t('comparedWith', { from: day(shown.previousRange.startDay), to: day(shown.previousRange.endDay) })}` : ''}
        </p>
      )}
      {customOpen && (
        <CustomRangeDialog
          open={customOpen}
          onOpenChange={setCustomOpen}
          initial={{ from: range.from ?? shown?.range.startDay, to: range.to ?? shown?.range.endDay }}
          today={today}
          onApply={(from, to) => setRange({ preset: 'custom', from, to })}
        />
      )}
    </div>
  );
}
