import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';

import { CompareSection, shareOfSent, uniqueLabels, visibleSelection } from './compare-section';
import { RangePicker, rangeParams } from './range-picker';
import { reportQuery } from './shared';

const render = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}} getMessageFallback={({ namespace, key }) => `${namespace}.${key}`}>
      {node}
    </NextIntlClientProvider>,
  );
const campaign = (id: string, name: string) => ({ id, name, templateName: 't', at: null, recipients: 10, sent: 8, delivered: 6, read: 4, replied: 2, clicked: 1, failed: 2 });

describe('calendar presets in the range picker', () => {
  it('offers this/last week and month and sends them as presets', () => {
    const html = render(<RangePicker value={{ preset: 'last_month' }} onChange={() => {}} />);
    for (const preset of ['this_week', 'last_week', 'this_month', 'last_month']) expect(html).toContain(`Analytics.range.${preset}`);
    expect(html).toMatch(/<option value="last_month" selected="">/);
    expect(reportQuery(rangeParams({ preset: 'this_week' }))).toBe('preset=this_week');
  });
});

describe('comparison section', () => {
  it('computes rates as a share of sent, null without sends', () => {
    expect(shareOfSent(campaign('a', 'A'), 'read')).toBe(50);
    expect(shareOfSent(campaign('a', 'A'), 'replied')).toBe(25);
    expect(shareOfSent({ ...campaign('a', 'A'), sent: 0 }, 'read')).toBeNull();
  });

  it('hides the products tab unless allowed, and asks for two campaigns', () => {
    const viewer = render(<CompareSection query="preset=30d" campaigns={[campaign('a', 'A')]} showProducts={false} />);
    expect(viewer).toContain('Analytics.compare.tabs.campaigns');
    expect(viewer).toContain('Analytics.compare.tabs.services');
    expect(viewer).not.toContain('Analytics.compare.tabs.products');
    expect(viewer).toContain('Analytics.compare.campaigns.needTwo');
    const agent = render(<CompareSection query="preset=30d" campaigns={[campaign('a', 'Spring'), campaign('b', 'Summer')]} showProducts />);
    expect(agent).toContain('Analytics.compare.tabs.products');
    expect(agent).toContain('Spring');
    expect(agent).toContain('Analytics.compare.campaigns.selectMore');
  });
});

describe('campaign comparison selection and labels', () => {
  it('keeps only picked campaigns the current range still lists, so hidden picks never lock the checkboxes', () => {
    const picked = ['a', 'b', 'c', 'd', 'e'];
    expect(visibleSelection(picked, [{ id: 'x' }, { id: 'y' }])).toEqual([]);
    expect(visibleSelection(picked, [{ id: 'c' }, { id: 'x' }, { id: 'a' }])).toEqual(['a', 'c']);
  });

  it('gives campaigns with the same name their own series', () => {
    expect(uniqueLabels(['Diwali offer', 'Diwali offer', 'Sale'])).toEqual(['Diwali offer', 'Diwali offer (2)', 'Sale']);
    expect(new Set(uniqueLabels(['A', 'A', 'A'])).size).toBe(3);
  });
});
