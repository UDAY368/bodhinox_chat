'use client';

// Settings → Plan & usage: the workspace plan, its features and how much
// of each limit is used. Read-only; plans change through billing (the hint
// points there only while platform billing is configured).

import { useEffect, useState } from 'react';
import { Check, Loader2, X } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { authFetch } from '@/lib/auth/client';
import { FEATURES } from '@/lib/billing/entitlements-catalogue';
import { usePlanState } from '@/lib/billing/client';
import { Button } from '@/components/ui/button';
import { SettingsPanelHead } from './settings-panel-head';
import { UsageMeters } from './billing/usage-meters';

export function PlanPanel() {
  const t = useTranslations('Settings.plan');
  const { plan, reload } = usePlanState();
  const [billingConfigured, setBillingConfigured] = useState(false);

  useEffect(() => {
    let live = true;
    authFetch('/api/billing/prices', { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<{ configured?: unknown }>) : null))
      .then((body) => { if (live) setBillingConfigured(body?.configured === true); })
      .catch(() => { if (live) setBillingConfigured(false); });
    return () => { live = false; };
  }, []);

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
          <UsageMeters plan={plan} />
          <p className="text-xs text-muted-foreground" data-testid="plan-upgrade-hint">{t(billingConfigured ? 'upgradeHintBilling' : 'upgradeHint')}</p>
        </>
      )}
    </section>
  );
}
