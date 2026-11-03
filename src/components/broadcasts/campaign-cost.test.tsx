import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';

import type { AudienceCostEstimate } from '@/lib/analytics/campaign-cost';
import { EstimateSummary } from './campaign-cost';

// Keys render as their path plus their values, so the test sees which message and arguments were chosen.
const render = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}} getMessageFallback={({ namespace, key }) => `${namespace}.${key}`}>
      {node}
    </NextIntlClientProvider>,
  );
const noop = () => {};

const estimate = (over: Partial<AudienceCostEstimate> = {}): AudienceCostEstimate => ({
  category: 'marketing', recipients: 1200, capped: false, currency: 'INR', currencies: ['INR'], total: 100_000,
  byCountry: [{ countryCode: 'IN', recipients: 1000, unitPriceMinor: 100, totalMinor: 100_000 }],
  missingCountries: [{ countryCode: 'US', recipients: 200 }],
  ...over,
});

describe('wizard cost estimate', () => {
  it('prices one currency without a currency choice', () => {
    const html = render(<EstimateSummary estimate={estimate()} onCurrency={noop} />);
    expect(html).toContain('₹');
    expect(html).not.toContain('<select');
    expect(html).toContain('Analytics.cost.missingCountries');
    expect(html).not.toContain('missingCountriesInCurrency');
  });

  it('offers the other currencies and says a country lacks a rate in this currency, not at all', () => {
    const html = render(<EstimateSummary estimate={estimate({ currencies: ['INR', 'USD'] })} onCurrency={noop} />);
    expect(html).toContain('<select');
    expect(html).toContain('<option value="USD">USD</option>');
    expect(html).toContain('Analytics.cost.missingCountriesInCurrency');
    const none = render(<EstimateSummary estimate={estimate({ currencies: ['INR', 'USD'], byCountry: [], total: 0 })} onCurrency={noop} />);
    expect(none).toContain('Analytics.cost.noCurrencyRate');
    expect(none).not.toContain('Analytics.cost.rateNotConfigured');
  });

  it('warns instead of pricing an audience over the campaign limit', () => {
    const html = render(<EstimateSummary estimate={estimate({ capped: true, recipients: 50_001 })} onCurrency={noop} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('Analytics.cost.overLimit');
    expect(html).not.toContain('₹');
    expect(html).not.toContain('Analytics.cost.missingCountries');
  });
});
