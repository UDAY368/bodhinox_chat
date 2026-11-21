'use client';

// Settings → Plan & usage: the workspace plan, its features and how much
// of each limit is used. Read-only; plans change through billing (the hint
// points there only while platform billing is configured).

import { useEffect, useState } from 'react';
import { Check, X } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { authFetch } from '@/lib/auth/client';
import { FEATURES } from '@/lib/billing/entitlements-catalogue';
import { usePlanState } from '@/lib/billing/client';
import { GroupedListRow } from '@/components/ui/grouped-list';
import { InlineError } from '@/components/ui/inline-error';
import { PageLoading } from '@/components/ui/page-loading';
import { SettingsPanelHead } from './settings-panel-head';
import { UsageMeters } from './billing/usage-meters';
import { SettingsGroup } from './settings-row';

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
        <PageLoading rows={4} />
      ) : plan === null ? (
        <InlineError message={t('loadFailed')} onRetry={reload} />
      ) : (
        <>
          <SettingsGroup title={<span data-testid="plan-name">{t('current', { plan: plan.planName })}</span>}>
            {FEATURES.map((feature) => (
              <GroupedListRow
                key={feature}
                leading={plan.features[feature] ? <Check className="size-4 text-emerald-500" aria-hidden /> : <X className="size-4 text-muted-foreground" aria-hidden />}
                title={<span className={plan.features[feature] ? 'text-foreground' : 'text-muted-foreground'}>{t(`features.${feature}`)}</span>}
              />
            ))}
          </SettingsGroup>
          <UsageMeters plan={plan} />
          <p className="text-xs text-muted-foreground" data-testid="plan-upgrade-hint">{t(billingConfigured ? 'upgradeHintBilling' : 'upgradeHint')}</p>
        </>
      )}
    </section>
  );
}
