'use client';

// What happens when a paid subscription ends, is cancelled or stops being paid,
// and why a plan's published changes do not reach this workspace mid-subscription.
// Matches the server: a non-granting subscription falls back to the Free plan,
// extras beyond its limits are archived (never deleted) and restored on
// resubscribing, inbound messages and opt-outs always keep working, and a
// subscription is held to the plan version it started on until its plan changes.

import { Info } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { SubscriptionView } from './types';

export function ExpiryNote({ subscription }: { subscription: SubscriptionView }) {
  const t = useTranslations('Billing.expiry');
  if (!subscription.managed) return null;
  return (
    <div className="flex gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground" data-testid="billing-expiry-note">
      <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <div className="space-y-1">
        <p>{t('ends')}</p>
        <p>{t('inbound')}</p>
        <p>{t('terms')}</p>
      </div>
    </div>
  );
}
