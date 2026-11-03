'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export type Preset = 'today' | '7d' | '30d' | '90d' | 'custom';
export interface RangeValue {
  preset: Preset;
  from?: string;
  to?: string;
}

const PRESETS: Exclude<Preset, 'custom'>[] = ['today', '7d', '30d', '90d'];

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
    <div className="flex flex-wrap items-end gap-2">
      <div role="group" aria-label={t('label')} className="flex flex-wrap gap-1">
        {PRESETS.map((preset) => (
          <Button
            key={preset}
            size="sm"
            variant={value.preset === preset && !custom ? 'default' : 'outline'}
            aria-pressed={value.preset === preset && !custom}
            onClick={() => {
              setCustom(false);
              onChange({ preset });
            }}
          >
            {t(preset)}
          </Button>
        ))}
        <Button size="sm" variant={custom ? 'default' : 'outline'} aria-pressed={custom} onClick={() => setCustom(true)}>
          {t('custom')}
        </Button>
      </div>
      {custom && (
        <form
          className="flex flex-wrap items-end gap-2"
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
          <p className="basis-full text-xs text-muted-foreground">{t('maxDays')}</p>
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
    <label className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">{t('label')}</span>
      <select
        className="h-8 rounded-md border border-border bg-background px-2 text-sm"
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
