'use client';

// Settings → Plan & usage: the workspace plan, its features and how much
// of each limit is used. Read-only; plans change through billing.

import { Check, Loader2, X } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FEATURES, LIMITS } from '@/lib/billing/entitlements-catalogue';
import { usePlanState } from '@/lib/billing/client';
import { Button } from '@/components/ui/button';
import { SettingsPanelHead } from './settings-panel-head';

export function PlanPanel() {
  const t = useTranslations('Settings.plan');
  const { plan, reload } = usePlanState();

  return (
    <section className="max-w-3xl animate-in fade-in-50 space-y-4 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />
      {plan === undefined ? (
        <Loader2 className="size-5 animate-spin text-primary" />
      ) : plan === null ? (
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          {t('loadFailed')}
          <Button variant="outline" size="sm" onClick={reload}>{t('retry')}</Button>
        </div>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-foreground" data-testid="plan-name">{t('current', { plan: plan.planName })}</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="grid gap-2 sm:grid-cols-2">
                {FEATURES.map((feature) => (
                  <li key={feature} className="flex items-center gap-2 text-sm">
                    {plan.features[feature] ? <Check className="size-4 text-emerald-500" /> : <X className="size-4 text-muted-foreground" />}
                    <span className={plan.features[feature] ? 'text-foreground' : 'text-muted-foreground'}>{t(`features.${feature}`)}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-foreground">{t('limitsTitle')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {LIMITS.map((key) => {
                const limit = plan.limits[key];
                const used = plan.usage[key];
                const pct = limit && used !== undefined ? Math.min(100, Math.round((used / limit) * 100)) : 0;
                return (
                  <div key={key} className="space-y-1">
                    <div className="flex justify-between text-sm">
                      <span className="text-foreground">{t(`limits.${key}`)}</span>
                      <span className="text-muted-foreground">
                        {used !== undefined ? `${used.toLocaleString()} / ` : ''}
                        {limit === null ? t('unlimited') : limit.toLocaleString()}
                      </span>
                    </div>
                    {limit !== null && used !== undefined && (
                      <div className="h-1.5 rounded-full bg-muted">
                        <div className={`h-1.5 rounded-full ${pct >= 100 ? 'bg-red-500' : 'bg-primary'}`} style={{ width: `${pct}%` }} />
                      </div>
                    )}
                  </div>
                );
              })}
            </CardContent>
          </Card>
          <p className="text-xs text-muted-foreground">{t('upgradeHint')}</p>
        </>
      )}
    </section>
  );
}
