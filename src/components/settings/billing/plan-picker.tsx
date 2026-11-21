'use client';

// Plan picker: monthly / yearly prices from plan_prices. Subscribes through
// Checkout when there is no live subscription, otherwise changes the plan
// (upgrades now, downgrades at the end of the period).

import { useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { SETTINGS_ROW_HAIRLINE, SettingsGroup } from '../settings-row';
import { cn } from '@/lib/utils';
import { formatMajor } from '@/lib/format/money';
import { type Interval, type PlanPrice, type SubscriptionView } from './types';

const LIVE = new Set(['trialing', 'active', 'past_due', 'grace']);

export function PlanPicker({ prices, subscription, canManage, busyPlan, onChoose }: {
  prices: PlanPrice[];
  subscription: SubscriptionView | null;
  canManage: boolean;
  busyPlan: string | null;
  onChoose: (plan: string, interval: Interval, mode: 'subscribe' | 'change') => void;
}) {
  const t = useTranslations('Billing.plans');
  const locale = useLocale();
  const [interval, setInterval] = useState<Interval>(subscription?.interval ?? 'month');
  const live = !!subscription?.managed && LIVE.has(subscription.status);
  const shown = useMemo(() => prices.filter((p) => p.interval === interval), [prices, interval]);
  const hasYearly = prices.some((p) => p.interval === 'year');
  const label = (plan: string) => (t.has(`names.${plan}`) ? t(`names.${plan}`) : plan);

  if (!prices.length) return null;
  return (
    <SettingsGroup
      title={live ? t('changeTitle') : t('title')}
      footer={<>{t('gstNote')}{!canManage && <> {t('adminsOnly')}</>}{live && <> {t('changeHint')}</>}</>}
      action={hasYearly ? (
        <SegmentedControl
          size="sm"
          aria-label={t('intervalLabel')}
          value={interval}
          onValueChange={setInterval}
          options={(['month', 'year'] as const).map((i) => ({ value: i, label: t(`interval.${i}`) }))}
        />
      ) : undefined}
    >
      {shown.map((p) => {
        const current = live && subscription?.plan === p.plan && subscription.interval === p.interval;
        return (
          <div key={`${p.plan}-${p.interval}`} className={cn(SETTINGS_ROW_HAIRLINE, 'flex min-h-11 flex-wrap items-center gap-3 px-4 py-3', current && 'bg-primary/5')}>
            <div className="min-w-0 flex-1">
              <p className="font-medium text-foreground">{label(p.plan)}</p>
              <p className="text-lg font-semibold text-foreground">
                {formatMajor(p.amountMinor / 100, p.currency, { locale })}
                <span className="text-sm font-normal text-muted-foreground"> / {t(`per.${p.interval}`)}</span>
              </p>
            </div>
            <Button size="sm" variant={current ? 'outline' : 'default'}
              disabled={!canManage || current || busyPlan !== null}
              onClick={() => onChoose(p.plan, p.interval, live ? 'change' : 'subscribe')}>
              {busyPlan === `${p.plan}:${p.interval}` && <Loader2 className="size-4 animate-spin" />}
              {current ? t('current') : live ? t('switch') : t('subscribe')}
            </Button>
          </div>
        );
      })}
    </SettingsGroup>
  );
}
