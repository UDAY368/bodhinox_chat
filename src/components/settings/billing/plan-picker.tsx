'use client';

// Plan picker: monthly / yearly prices from plan_prices. Subscribes through
// Checkout when there is no live subscription, otherwise changes the plan
// (upgrades now, downgrades at the end of the period).

import { useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { formatAmount, type Interval, type PlanPrice, type SubscriptionView } from './types';

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
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
        <CardTitle className="text-foreground">{live ? t('changeTitle') : t('title')}</CardTitle>
        {hasYearly && (
          <div className="inline-flex rounded-md border p-0.5 text-sm" role="group" aria-label={t('intervalLabel')}>
            {(['month', 'year'] as const).map((i) => (
              <button key={i} type="button" onClick={() => setInterval(i)} aria-pressed={interval === i}
                className={cn('rounded px-3 py-1', interval === i ? 'bg-primary text-primary-foreground' : 'text-muted-foreground')}>
                {t(`interval.${i}`)}
              </button>
            ))}
          </div>
        )}
      </CardHeader>
      <CardContent>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((p) => {
            const current = live && subscription?.plan === p.plan && subscription.interval === p.interval;
            return (
              <li key={`${p.plan}-${p.interval}`} className={cn('flex flex-col gap-2 rounded-lg border p-4', current && 'border-primary')}>
                <span className="font-medium text-foreground">{label(p.plan)}</span>
                <span className="text-2xl font-semibold text-foreground">
                  {formatAmount(p.amountMinor, p.currency, locale)}
                  <span className="text-sm font-normal text-muted-foreground"> / {t(`per.${p.interval}`)}</span>
                </span>
                <span className="text-xs text-muted-foreground">{t('gstNote')}</span>
                <Button className="mt-auto" size="sm" variant={current ? 'outline' : 'default'}
                  disabled={!canManage || current || busyPlan !== null}
                  onClick={() => onChoose(p.plan, p.interval, live ? 'change' : 'subscribe')}>
                  {busyPlan === `${p.plan}:${p.interval}` && <Loader2 className="size-4 animate-spin" />}
                  {current ? t('current') : live ? t('switch') : t('subscribe')}
                </Button>
              </li>
            );
          })}
        </ul>
        {!canManage && <p className="mt-3 text-xs text-muted-foreground">{t('adminsOnly')}</p>}
        {live && <p className="mt-3 text-xs text-muted-foreground">{t('changeHint')}</p>}
      </CardContent>
    </Card>
  );
}
