'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { CalendarDays } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export type Preset = 'today' | '7d' | '30d' | '90d' | 'this_week' | 'last_week' | 'this_month' | 'last_month' | 'custom';
export interface RangeValue {
  preset: Preset;
  from?: string;
  to?: string;
}

const PRESETS: Exclude<Preset, 'custom'>[] = ['today', '7d', '30d', '90d'];
/** Calendar periods in the workspace timezone; weeks start on Monday. */
const CALENDAR_PRESETS: Exclude<Preset, 'custom'>[] = ['this_week', 'last_week', 'this_month', 'last_month'];

/** Select value standing for "no option picked" (base-ui Select has no clean empty value). */
export const NONE = '__none';
/** A filter menu in a toolbar: a 44px row on phones, compact from 640px. */
export const filterTrigger = 'min-h-11 w-full sm:min-h-9 sm:w-auto';

/** Range query values for a report request. */
export function rangeParams(value: RangeValue) {
  return value.preset === 'custom' ? { from: value.from, to: value.to } : { preset: value.preset };
}

export function RangePicker({
  value,
  onChange,
  today,
}: {
  value: RangeValue;
  onChange: (value: RangeValue) => void;
  /** The workspace's current day (from the last report), YYYY-MM-DD. */
  today?: string;
}) {
  const t = useTranslations('Analytics.range');
  const [from, setFrom] = useState(value.from ?? '');
  const [to, setTo] = useState(value.to ?? '');
  const [custom, setCustom] = useState(value.preset === 'custom');
  const valid = Boolean(from && to && from <= to);

  return (
    <div className="flex max-w-full flex-wrap items-center gap-2 sm:justify-end">
      <SegmentedControl
        aria-label={t('label')}
        value={custom ? 'custom' : value.preset}
        onValueChange={(preset) => {
          setCustom(false);
          onChange({ preset: preset as Exclude<Preset, 'custom'> });
        }}
        options={PRESETS.map((preset) => ({ value: preset, label: t(preset) }))}
      />
      <Button type="button" variant="outline" className="min-h-11 sm:min-h-9" aria-pressed={custom} onClick={() => setCustom(true)}>
        <CalendarDays aria-hidden />
        {t('custom')}
      </Button>
      <Select
        value={!custom && CALENDAR_PRESETS.includes(value.preset as Exclude<Preset, 'custom'>) ? value.preset : NONE}
        onValueChange={(v) => {
          const preset = v as Exclude<Preset, 'custom'>;
          if (!CALENDAR_PRESETS.includes(preset)) return;
          setCustom(false);
          onChange({ preset });
        }}
      >
        <SelectTrigger aria-label={t('calendarLabel')} className={filterTrigger}>
          <SelectValue>{(v: string) => (v === NONE ? t('calendar') : t(v as Exclude<Preset, 'custom'>))}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{t('calendar')}</SelectItem>
          {CALENDAR_PRESETS.map((preset) => (
            <SelectItem key={preset} value={preset}>
              {t(preset)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {custom && (
        <form
          className="flex basis-full flex-wrap items-end gap-2 sm:justify-end"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) onChange({ preset: 'custom', from, to });
          }}
        >
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('from')}
            <Input type="date" value={from} max={to || today} onChange={(e) => setFrom(e.target.value)} className="h-8 w-40" required />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('to')}
            <Input type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} className="h-8 w-40" required />
          </label>
          <Button size="sm" type="submit" disabled={!valid}>
            {t('apply')}
          </Button>
          <p className="basis-full text-xs text-muted-foreground sm:text-right">{t('maxDays')}</p>
        </form>
      )}
    </div>
  );
}

export function NumberFilter({
  numbers,
  value,
  onChange,
}: {
  numbers: { id: string; label: string | null; isDefault: boolean }[];
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useTranslations('Analytics.numbers');
  // The list comes from the overview report, which is empty while it reloads;
  // keep the last list so the filter neither vanishes nor shows the wrong number.
  const [kept, setKept] = useState(numbers);
  if (numbers.length > 0 && numbers !== kept) setKept(numbers);
  const shown = numbers.length > 0 ? numbers : kept;
  if (shown.length < 2 && !value) return null;
  const numberLabel = (id: string) => {
    const i = shown.findIndex((number) => number.id === id);
    if (i < 0) return t('label');
    const number = shown[i];
    return `${number.label || t('fallback', { n: i + 1 })}${number.isDefault ? ` ${t('default')}` : ''}`;
  };
  return (
    <Select value={value || NONE} onValueChange={(v) => onChange(!v || v === NONE ? '' : v)}>
      <SelectTrigger aria-label={t('label')} className={`${filterTrigger} max-w-full`}>
        <SelectValue>{(v: string) => (v === NONE ? t('all') : numberLabel(v))}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>{t('all')}</SelectItem>
        {shown.map((number) => (
          <SelectItem key={number.id} value={number.id}>
            {numberLabel(number.id)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
