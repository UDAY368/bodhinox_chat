'use client';

// The Ads page's shared controls: which ad account (when more than one is
// linked) and which date range. Every report tab reads the same selection.

import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { OptionSelect } from '@/components/contacts/option-select';
import type { LinkedAdAccount } from '@/lib/meta-ads/accounts';
import { customRange, presetRange, type AdsRange, type RangePreset } from './ads-shared';

const PRESETS: Exclude<RangePreset, 'custom'>[] = ['last_7d', 'last_30d', 'last_90d'];

export function AdsToolbar({ accounts, adAccountId, onAccount, range, onRange }: {
  accounts: LinkedAdAccount[];
  /** null = all linked ad accounts. */
  adAccountId: string | null;
  onAccount: (id: string | null) => void;
  range: AdsRange;
  onRange: (range: AdsRange) => void;
}) {
  const t = useTranslations('Ads.toolbar');
  return (
    <div className="flex flex-wrap items-center gap-3" data-testid="ads-toolbar">
      {accounts.length > 1 && (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground" aria-hidden>{t('account')}</span>
          <OptionSelect
            aria-label={t('account')}
            className="max-w-[16rem]"
            value={adAccountId ?? 'all'}
            onValueChange={(v) => onAccount(v === 'all' ? null : v)}
            options={[
              { value: 'all', label: t('allAccounts') },
              ...accounts.map((a) => ({ value: a.adAccountId, label: `${a.name ?? a.adAccountId}${a.currency ? ` · ${a.currency}` : ''}` })),
            ]}
          />
        </div>
      )}
      <SegmentedControl
        aria-label={t('range')}
        value={range.preset}
        onValueChange={(preset) => onRange(preset === 'custom' ? customRange(range.from, range.to) : presetRange(preset))}
        options={[...PRESETS, 'custom' as const].map((preset) => ({ value: preset, label: t(`presets.${preset}`) }))}
      />
      {range.preset === 'custom' && (
        <div className="flex items-center gap-2">
          <Input type="date" aria-label={t('from')} value={range.from} max={range.to}
            onChange={(e) => e.target.value && onRange(customRange(e.target.value, range.to))} className="h-9 w-40" />
          <span className="text-muted-foreground" aria-hidden>–</span>
          <Input type="date" aria-label={t('to')} value={range.to} min={range.from}
            onChange={(e) => e.target.value && onRange(customRange(range.from, e.target.value))} className="h-9 w-40" />
        </div>
      )}
    </div>
  );
}
