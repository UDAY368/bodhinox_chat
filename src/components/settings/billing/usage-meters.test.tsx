import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';

import { LIMITS, type LimitKey } from '@/lib/billing/entitlements-catalogue';
import type { PlanView } from '@/lib/billing/client';
import { UsageMeters } from './usage-meters';

const plan = (limits: Partial<Record<LimitKey, number | null>>, usage: Record<string, number>): PlanView => ({
  planId: 'basic', planName: 'Basic', features: {} as PlanView['features'],
  limits: Object.fromEntries(LIMITS.map((k) => [k, limits[k] ?? null])) as PlanView['limits'],
  usage,
});

const render = (view: PlanView) => renderToStaticMarkup(
  <NextIntlClientProvider locale="en" messages={{}} onError={() => {}} getMessageFallback={({ namespace, key }) => `${namespace}.${key}`}>
    <UsageMeters plan={view} />
  </NextIntlClientProvider>,
);

describe('UsageMeters', () => {
  it('shows contacts, integrations and messages this month, with the policy of each finite limit', () => {
    const html = render(plan({ contacts: 1000, integrations: 2 }, { contacts: 850, integrations: 2, messages_monthly: 120 }));
    for (const key of ['contacts', 'integrations', 'messages_monthly']) expect(html).toContain(`data-testid="meter-${key}"`);
    expect(html).toContain('850 / 1,000');
    expect(html).toContain('Settings.plan.policies.hard_inbound_exempt');
    expect(html).toContain('data-testid="policy-integrations"');
    // Soft, unlimited: shown without a policy line.
    expect(html).not.toContain('data-testid="policy-messages_monthly"');
    expect(html).toContain('data-testid="how-limits-work"');
    expect(html).toContain('Settings.plan.meters.how.inbound');
  });

  it('shows no policy line for an unlimited workspace (every workspace without a subscription)', () => {
    const html = render(plan({}, { contacts: 50_000 }));
    expect(html).not.toContain('data-testid="policy-');
    expect(html).toContain('Settings.plan.unlimited');
  });
});
