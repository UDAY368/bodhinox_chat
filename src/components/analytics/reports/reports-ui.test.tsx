import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';

import { ConfirmProvider } from '@/components/ui/confirm-dialog';
import { REPORT_KIND_OPTIONS } from './reports-tab';

import { ReportsTab } from './reports-tab';
import { SchedulesPanel } from './schedules-panel';
import { SharePanel } from './share-panel';

const render = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}} getMessageFallback={({ namespace, key }) => `${namespace}.${key}`}>
      <ConfirmProvider>{node}</ConfirmProvider>
    </NextIntlClientProvider>,
  );

describe('reports UI', () => {
  it('offers the new kinds, the calendar presets and the PDF format, plus scheduling', () => {
    const html = render(<ReportsTab canManage />);
    for (const kind of ['product_summary', 'service_summary', 'commerce_daily']) expect(REPORT_KIND_OPTIONS).toContain(kind);
    // The menus show the chosen kind and range by name; CSV and PDF are a segmented control.
    expect(html).toContain('Analytics.reports.kinds.campaign_summary');
    expect(html).toContain('Analytics.reports.presets.30d');
    expect(html).toContain('Analytics.reports.formats.pdf');
    expect(html).toContain('Analytics.reports.schedules.title');
  });

  it('shows nothing to non-admins', () => {
    const html = render(<ReportsTab canManage={false} />);
    expect(html).toContain('Analytics.reports.adminsOnly');
    expect(html).not.toContain('Analytics.reports.schedules.title');
  });

  it('never offers a share role below the kind minimum', () => {
    const products = render(<SharePanel reportId="r1" kind="product_summary" />);
    expect(products).not.toContain('Analytics.reports.share.roles.viewer');
    expect(products).toContain('Analytics.reports.share.roles.agent');
    const campaigns = render(<SharePanel reportId="r1" kind="campaign_summary" />);
    expect(campaigns).toContain('Analytics.reports.share.roles.viewer');
    expect(campaigns).toContain('Analytics.reports.share.hours.168');
    expect(campaigns).not.toContain('Analytics.reports.share.hours.169');
  });

  it('schedules daily, weekly and monthly at a local hour', () => {
    const html = render(<SchedulesPanel />);
    for (const cadence of ['daily', 'weekly', 'monthly']) expect(html).toContain(`Analytics.reports.schedules.cadences.${cadence}`);
    expect(html).toContain('08:00');
  });
});
