'use client';

// Current subscription: plan, status and the trial / grace / suspension /
// scheduled-change banners, with cancel and pay actions for admins.

import { AlertTriangle, Loader2 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDay, type BillingOverview } from './types';

const WARN = 'border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200';
const DANGER = 'border-red-500/40 bg-red-500/10 text-red-900 dark:text-red-200';

export function SubscriptionCard({ overview, busy, onCancel, onPay }: {
  overview: BillingOverview;
  busy: 'cancel' | 'pay' | null;
  onCancel: () => void;
  onPay: () => void;
}) {
  const t = useTranslations('Billing.subscription');
  const plans = useTranslations('Billing.plans');
  const planLabel = (plan: string) => (plans.has(`names.${plan}`) ? plans(`names.${plan}`) : plan);
  const locale = useLocale();
  const s = overview.subscription;
  const day = (iso: string | null) => formatDay(iso, locale);
  const pending = overview.pending.filter((p) => p.status !== 'created');

  const banner = (tone: string, text: string, action?: React.ReactNode) => (
    <div className={`flex flex-wrap items-center gap-3 rounded-md border px-3 py-2 text-sm ${tone}`} role="status">
      <AlertTriangle className="size-4 shrink-0" />
      <span className="flex-1">{text}</span>
      {action}
    </div>
  );
  const payButton = overview.can_manage && s?.managed ? (
    <Button size="sm" onClick={onPay} disabled={busy !== null}>
      {busy === 'pay' && <Loader2 className="size-4 animate-spin" />}{t('pay')}
    </Button>
  ) : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-foreground">
          {s ? t('current', { plan: s.planName }) : t('none')}
          {s && <Badge variant={s.status === 'active' || s.status === 'trialing' ? 'secondary' : 'destructive'} data-testid="billing-status">{t(`status.${s.status}`)}</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!s && <p className="text-muted-foreground">{t('noneHint')}</p>}
        {s?.interval && s.currentPeriodEnd && (s.status === 'active' || s.status === 'trialing') && (
          <p className="text-muted-foreground">
            {s.cancelAtPeriodEnd ? t('endsOn', { date: day(s.currentPeriodEnd) }) : t('renewsOn', { interval: t(`interval.${s.interval}`), date: day(s.currentPeriodEnd) })}
          </p>
        )}
        {s?.status === 'trialing' && s.trialEndsAt && banner(WARN, t('trialBanner', { date: day(s.trialEndsAt) }))}
        {s?.status === 'past_due' && banner(WARN, t('pastDueBanner'), payButton)}
        {s?.status === 'grace' && banner(DANGER, t('graceBanner', { date: day(s.graceEndsAt) }), payButton)}
        {s?.status === 'suspended' && banner(DANGER, t('suspendedBanner'), payButton)}
        {s?.cancelAtPeriodEnd && s.status !== 'cancelled' && banner(WARN, t('cancelBanner', { date: day(s.currentPeriodEnd) }))}
        {s?.scheduledPlan && banner(WARN, t('scheduledBanner', { plan: planLabel(s.scheduledPlan), date: day(s.currentPeriodEnd) }))}
        {pending.map((p, i) => (
          <div key={i}>{banner(WARN, t(`pending.${p.kind}`))}</div>
        ))}
        {overview.can_manage && s?.managed && !s.cancelAtPeriodEnd && s.status !== 'cancelled' && (
          <div className="pt-1">
            <Button variant="outline" size="sm" onClick={onCancel} disabled={busy !== null}>
              {busy === 'cancel' && <Loader2 className="size-4 animate-spin" />}{t('cancel')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
