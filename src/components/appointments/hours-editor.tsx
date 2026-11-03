'use client';

/**
 * Weekly hours (and single-day range lists for exceptions) in the inbox
 * working-hours shape: up to MAX_RANGES_PER_DAY ranges a day, an end of
 * "24:00" for midnight. Same editor pattern as settings/inbox/working-hours-card.
 */
import { Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { MAX_RANGES_PER_DAY, WEEKDAYS, type TimeRange, type Weekday, type WorkingHours } from '@/lib/inbox/working-hours';

const DEFAULT_RANGE: TimeRange = { start: '09:00', end: '18:00' };

export function RangesEditor({
  ranges, onChange, disabled, label,
}: { ranges: TimeRange[]; onChange: (ranges: TimeRange[]) => void; disabled?: boolean; label: string }) {
  const t = useTranslations('Settings.workingHours');
  return (
    <div className="space-y-1.5">
      {ranges.map((range, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input type="time" className="h-8 w-28" aria-label={t('opensAt', { day: label })} value={range.start} disabled={disabled}
            onChange={(e) => onChange(ranges.map((r, j) => (j === i ? { ...r, start: e.target.value } : r)))} />
          <span className="text-xs text-muted-foreground">{t('to')}</span>
          <Input type="time" className="h-8 w-28" aria-label={t('closesAt', { day: label })}
            value={range.end === '24:00' ? '23:59' : range.end} disabled={disabled}
            onChange={(e) => onChange(ranges.map((r, j) => (j === i ? { ...r, end: e.target.value === '23:59' ? '24:00' : e.target.value } : r)))} />
          {!disabled && (
            <Button type="button" variant="ghost" size="icon" aria-label={t('removeRange')}
              onClick={() => onChange(ranges.filter((_, j) => j !== i))}>
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      ))}
      {!disabled && ranges.length < MAX_RANGES_PER_DAY && (ranges.length === 0 || ranges[ranges.length - 1].end < '23:59') && (
        <Button type="button" variant="ghost" size="sm"
          onClick={() => onChange([...ranges, ranges.length ? { start: ranges[ranges.length - 1].end, end: '24:00' } : DEFAULT_RANGE])}>
          <Plus className="h-4 w-4" /> {t('addRange')}
        </Button>
      )}
    </div>
  );
}

export function WeeklyHoursEditor({
  hours, onChange, disabled,
}: { hours: WorkingHours; onChange: (hours: WorkingHours) => void; disabled?: boolean }) {
  const t = useTranslations('Settings.workingHours');
  const tDay = useTranslations('Weekdays');
  const setDay = (day: Weekday, ranges: TimeRange[]) => onChange({ ...hours, [day]: ranges });
  return (
    <div className="space-y-2">
      {WEEKDAYS.map((day) => {
        const ranges = hours[day] ?? [];
        return (
          <div key={day} className="flex flex-wrap items-start gap-3 border-b border-border/50 pb-2 last:border-0">
            <label className="flex w-32 items-center gap-2 pt-1 text-sm">
              <Switch checked={ranges.length > 0} disabled={disabled} aria-label={t('openOn', { day: tDay(day) })}
                onCheckedChange={(open) => setDay(day, open ? [DEFAULT_RANGE] : [])} />
              {tDay(day)}
            </label>
            <div className="min-w-0 flex-1">
              {ranges.length === 0
                ? <p className="py-1 text-xs text-muted-foreground">{t('closed')}</p>
                : <RangesEditor ranges={ranges} disabled={disabled} label={tDay(day)} onChange={(r) => setDay(day, r)} />}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Drop empty days so the saved object only lists open days. */
export function compactHours(hours: WorkingHours): WorkingHours {
  return Object.fromEntries(WEEKDAYS.filter((d) => (hours[d]?.length ?? 0) > 0).map((d) => [d, hours[d]])) as WorkingHours;
}
