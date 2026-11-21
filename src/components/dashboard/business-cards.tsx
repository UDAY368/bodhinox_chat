'use client';

import { useCallback, useEffect, useState } from 'react';
import { Bot, CalendarCheck, Banknote, Megaphone } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { authFetch } from '@/lib/auth/client';
import { formatMajor, formatMoney } from '@/lib/format/money';
import type { BusinessCards as Cards } from '@/lib/dashboard/types';
import { MetricCard } from '@/components/dashboard/metric-card';
import { SkeletonCard } from '@/components/dashboard/skeleton';
import { InlineError } from '@/components/ui/inline-error';

/** The currency to headline: the workspace default when it has an amount, else the largest. */
export function headlineCurrency(amounts: Record<string, number>, preferred: string | null | undefined): string | null {
  const codes = Object.keys(amounts).filter((c) => amounts[c] !== 0);
  if (!codes.length) return null;
  if (preferred && codes.includes(preferred)) return preferred;
  return codes.sort((a, b) => amounts[b] - amounts[a])[0];
}

/**
 * Home: revenue, bookings, ad spend and AI handled. Each card opens its
 * records. Viewers get the bookings card only (the API leaves the rest out).
 */
export function BusinessCards({ currency }: { currency?: string | null }) {
  const t = useTranslations('Dashboard.business');
  const locale = useLocale();
  const [data, setData] = useState<Cards | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    authFetch('/api/dashboard/business', { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`business cards ${res.status}`);
        setData((await res.json()) as Cards);
      })
      .catch(() => setFailed(true));
  }, []);
  useEffect(() => { load(); }, [load]);
  const retry = () => { setFailed(false); setData(null); load(); };

  if (failed) {
    return (
      <section className="border-border bg-card flex items-center justify-center rounded-xl border">
        <InlineError message={t('failed')} onRetry={retry} />
      </section>
    );
  }
  if (!data) {
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-busy="true">
        {Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)}
      </div>
    );
  }

  const money = (amounts: Record<string, number>) => {
    const code = headlineCurrency(amounts, currency);
    return code ? formatMoney(amounts[code], code, { locale }) : formatMoney(0, currency || 'INR', { locale });
  };
  const others = (amounts: Record<string, number>) => Math.max(0, Object.values(amounts).filter((v) => v !== 0).length - 1);

  const spend = data.adSpend?.last7Days ?? [];
  const spendHead = spend.find((s) => s.currency === currency) ?? spend[0];

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {data.revenue && (
        <MetricCard
          title={t('revenue')}
          value={money(data.revenue.todayMinor)}
          icon={Banknote}
          subtitle={t('revenueWeek', { amount: money(data.revenue.last7DaysMinor), more: others(data.revenue.last7DaysMinor) })}
          href="/commerce/orders"
        />
      )}
      <MetricCard
        title={t('bookings')}
        value={String(data.bookings.today)}
        icon={CalendarCheck}
        subtitle={t('bookingsSub', { upcoming: data.bookings.upcomingToday, week: data.bookings.next7Days })}
        href="/appointments?view=today"
      />
      {data.revenue && (
        <MetricCard
          title={t('adSpend')}
          value={spendHead ? formatMajor(spendHead.amount, spendHead.currency, { locale }) : '–'}
          icon={Megaphone}
          subtitle={data.adSpend ? t('adSpendSub', { more: Math.max(0, spend.length - 1) }) : t('adSpendNone')}
          href="/ads"
        />
      )}
      {data.aiHandled && (
        <MetricCard
          title={t('aiHandled')}
          value={String(data.aiHandled.today)}
          icon={Bot}
          subtitle={t('aiHandledSub', { week: data.aiHandled.last7Days })}
          href="/analytics"
        />
      )}
    </div>
  );
}
