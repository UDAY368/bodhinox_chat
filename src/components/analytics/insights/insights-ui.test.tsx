import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';

import { automationHref } from './campaigns-tab';
import { BarList, Legend, niceMax } from './charts';
import { tabOf } from './analytics-header';
import { csvCell, slug, toCsvText } from './csv';
import { deltaOf } from './format';
import { SortableTable, StatRow } from './parts';

const render = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}} getMessageFallback={({ namespace, key }) => `${namespace}.${key}`}>
      {node}
    </NextIntlClientProvider>,
  );

describe('analytics redesign helpers', () => {
  it('reports change against the previous period, with lower-is-better durations', () => {
    expect(deltaOf(null, 3)).toEqual({ kind: 'none' });
    expect(deltaOf(5, 0)).toEqual({ kind: 'new' });
    expect(deltaOf(0, 0)).toEqual({ kind: 'same' });
    expect(deltaOf(100, 100.2)).toEqual({ kind: 'same' });
    expect(deltaOf(150, 100)).toEqual({ kind: 'change', percent: 50, good: true });
    expect(deltaOf(150, 100, true)).toEqual({ kind: 'change', percent: 50, good: false });
    expect(deltaOf(50, 100, true)).toMatchObject({ good: true });
  });

  it('writes formula-safe CSV with a BOM', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell(null)).toBe('');
    expect(toCsvText(['A', 'B'], [[1, '-2']])).toBe("﻿A,B\r\n1,'-2\r\n");
    expect(slug('Team · 2026-11-01')).toBe('team-2026-11-01');
  });

  it('rounds chart axes up to 1, 2 or 5 steps', () => {
    expect(niceMax(0)).toBe(4);
    expect(niceMax(37)).toBe(40);
    expect(niceMax(41)).toBe(80);
    expect(niceMax(0.3, false)).toBeCloseTo(0.4);
  });

  it('links each automation to where it is edited, and maps paths to tabs', () => {
    expect(automationHref({ id: 'f', kind: 'flow', channel: 'any' })).toBe('/flows/f');
    expect(automationHref({ id: 'r', kind: 'rule', channel: 'instagram' })).toBe('/instagram/automations/r');
    expect(automationHref({ id: 'r', kind: 'rule', channel: 'whatsapp' })).toBe('/whatsapp/automations/r');
    expect(automationHref({ id: 's', kind: 'sequence', channel: 'instagram' })).toBe('/instagram/sequences/s');
    expect(tabOf('/analytics')).toBe('overview');
    expect(tabOf('/analytics/team')).toBe('team');
    expect(tabOf('/analytics/unknown')).toBe('overview');
  });
});

describe('analytics redesign parts', () => {
  it('renders linked stat cards with their change', () => {
    const html = render(<StatRow stats={[{ label: 'New', value: '12', delta: { text: '+5%', tone: 'good' }, href: '/analytics/conversations' }, { label: 'Online', value: '2 of 3' }]} />);
    expect(html).toContain('href="/analytics/conversations"');
    expect(html).toContain('+5%');
    expect(html).toContain('2 of 3');
  });

  it('sorts a table by its initial column with aria-sort, and limits rows', () => {
    const rows = [{ id: 'a', n: 1 }, { id: 'b', n: 3 }, { id: 'c', n: 2 }];
    const html = render(
      <SortableTable caption="T" rows={rows} rowKey={(r) => r.id} initial={{ key: 'n', dir: -1 }} limit={2}
        columns={[{ key: 'id', label: 'Id', sort: (r) => r.id, cell: (r) => r.id }, { key: 'n', label: 'N', numeric: true, sort: (r) => r.n, cell: (r) => `n${r.n}` }]} />,
    );
    expect(html).toContain('aria-sort="descending"');
    expect(html.indexOf('n3')).toBeLessThan(html.indexOf('n2'));
    expect(html).not.toContain('n1');
  });

  it('keeps the last visible series on and renders bar list links', () => {
    const legend = render(<Legend series={[{ key: 'a', name: 'A', color: 'red' }, { key: 'b', name: 'B', color: 'blue' }]} hidden={new Set(['b'])} onToggle={() => {}} />);
    expect(legend).toContain('aria-pressed="true" aria-disabled="true"');
    expect(legend).toContain('aria-pressed="false"');
    const bars = render(<BarList label="L" rows={[{ key: 'x', name: 'Welcome', value: 5, text: '5', href: '/flows/x', action: 'Open Welcome' }]} />);
    expect(bars).toContain('href="/flows/x"');
    expect(bars).toContain('aria-label="Open Welcome"');
  });
});
