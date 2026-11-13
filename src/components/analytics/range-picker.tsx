'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { CalendarDays } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { quietSelect, segmentedItem, segmentedTrack } from '@/components/dashboard/segmented';

export type Preset = 'today' | '7d' | '30d' | '90d' | 'this_week' | 'last_week' | 'this_month' | 'last_month' | 'custom';
export interface RangeValue {
  preset: Preset;
  from?: string;
  to?: string;
}

const PRESETS: Exclude<Preset, 'custom'>[] = ['today', '7d', '30d', '90d'];
/** Calendar periods in the workspace timezone; weeks start on Monday. */
const CALENDAR_PRESETS: Exclude<Preset, 'custom'>[] = ['this_week', 'last_week', 'this_month', 'last_month'];

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
      <div role="group" aria-label={t('label')} className={segmentedTrack}>
        {PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            className={segmentedItem(value.preset === preset && !custom)}
            aria-pressed={value.preset === preset && !custom}
            onClick={() => {
              setCustom(false);
              onChange({ preset });
            }}
          >
            {t(preset)}
          </button>
        ))}
        <button type="button" className={segmentedItem(custom)} aria-pressed={custom} onClick={() => setCustom(true)}>
          <CalendarDays aria-hidden />
          {t('custom')}
        </button>
      </div>
      <select
        aria-label={t('calendarLabel')}
        className={quietSelect}
        value={!custom && CALENDAR_PRESETS.includes(value.preset as Exclude<Preset, 'custom'>) ? value.preset : ''}
        onChange={(e) => {
          const preset = e.target.value as Exclude<Preset, 'custom'>;
          if (!CALENDAR_PRESETS.includes(preset)) return;
          setCustom(false);
          onChange({ preset });
        }}
      >
        <option value="">{t('calendar')}</option>
        {CALENDAR_PRESETS.map((preset) => (
          <option key={preset} value={preset}>
            {t(preset)}
          </option>
        ))}
      </select>
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
  return (
    <label className="flex items-center gap-2 text-[13px]">
      <span className="text-muted-foreground">{t('label')}</span>
      <select
        className={quietSelect}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{t('all')}</option>
        {shown.map((number, i) => (
          <option key={number.id} value={number.id}>
            {number.label || t('fallback', { n: i + 1 })}
            {number.isDefault ? ` ${t('default')}` : ''}
          </option>
        ))}
      </select>
    </label>
  );
}
