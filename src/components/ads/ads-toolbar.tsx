'use client';

// The Ads page's shared controls: which ad account (when more than one is
// linked) and which date range. Every report tab reads the same selection.

import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
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
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">{t('account')}</span>
          <select
            value={adAccountId ?? 'all'}
            onChange={(e) => onAccount(e.target.value === 'all' ? null : e.target.value)}
            className="h-9 max-w-[16rem] rounded-lg border border-border bg-card px-2.5 text-sm text-foreground outline-none transition-shadow duration-150 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="all">{t('allAccounts')}</option>
            {accounts.map((a) => (
              <option key={a.adAccountId} value={a.adAccountId}>
                {a.name ?? a.adAccountId}{a.currency ? ` · ${a.currency}` : ''}
              </option>
            ))}
          </select>
        </label>
      )}
      <div role="radiogroup" aria-label={t('range')} className="flex gap-0.5 rounded-xl bg-muted p-[3px]">
        {[...PRESETS, 'custom' as const].map((preset) => (
          <button
            key={preset}
            type="button"
            role="radio"
            aria-checked={range.preset === preset}
            onClick={() => onRange(preset === 'custom' ? customRange(range.from, range.to) : presetRange(preset))}
            className={cn(
              'h-8 rounded-[9px] px-3 text-xs font-medium outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring',
              range.preset === preset ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t(`presets.${preset}`)}
          </button>
        ))}
      </div>
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
