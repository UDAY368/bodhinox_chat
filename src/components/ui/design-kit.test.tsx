import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import messages from '@app-messages';

import { Button } from './button';
import { ConfirmDialog, ConfirmProvider, useConfirm } from './confirm-dialog';
import { GroupedList, GroupedListRow } from './grouped-list';
import { PageHeader } from './page-header';
import { SegmentedControl, nextIndex } from './segmented-control';

const render = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      {node}
    </NextIntlClientProvider>,
  );
const count = (html: string, pattern: RegExp) => (html.match(pattern) ?? []).length;

describe('PageHeader', () => {
  it('renders one h1, the subtitle and the primary action', () => {
    const html = render(
      <PageHeader title="Orders" subtitle="12 open" primaryAction={<Button>New order</Button>}>
        <span>filters</span>
      </PageHeader>,
    );
    expect(count(html, /<h1/g)).toBe(1);
    expect(html).toContain('>Orders</h1>');
    expect(html).toContain('12 open');
    expect(html).toContain('New order');
    expect(html).toContain('filters');
    expect(html).toContain('data-slot="page-header"');
    expect(html).not.toContain('aria-label="More"');
  });

  it('shows the More button only when there are more actions', () => {
    const html = render(<PageHeader title="Orders" moreActions={[{ label: 'Export', href: '/orders/export' }]} />);
    expect(count(html, /aria-label="More"/g)).toBe(1);
    expect(render(<PageHeader title="Orders" moreActions={[]} />)).not.toContain('aria-label="More"');
  });
});

describe('GroupedList', () => {
  it('renders header, footer and rows as link, button or plain content', () => {
    const html = render(
      <GroupedList header="Account" footer="Changes apply at once.">
        <GroupedListRow title="Profile" href="/settings/profile" />
        <GroupedListRow title="Sign out" onClick={() => {}} destructive />
        <GroupedListRow title="Plan" trailing="Pro" />
      </GroupedList>,
    );
    expect(html).toContain('Account');
    expect(html).toContain('Changes apply at once.');
    expect(html).toMatch(/<a[^>]*href="\/settings\/profile"[^>]*data-slot="grouped-row"|<a[^>]*data-slot="grouped-row"[^>]*href="\/settings\/profile"/);
    expect(html).toMatch(/<button type="button"[^>]*data-slot="grouped-row"/);
    expect(html).toMatch(/<div data-slot="grouped-row"/);
    expect(count(html, /lucide-chevron-right/g)).toBe(1); // only the link row
    expect(html).toContain('text-destructive');
  });

  it('chevron can be turned off on a link and on for a button; selected shows a check', () => {
    const html = render(
      <GroupedList>
        <GroupedListRow title="A" href="/a" chevron={false} selected />
        <GroupedListRow title="B" onClick={() => {}} chevron />
      </GroupedList>,
    );
    expect(count(html, /lucide-chevron-right/g)).toBe(1);
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('lucide-check');
  });
});

describe('SegmentedControl', () => {
  it('nextIndex moves with arrows, wraps, skips disabled and handles Home/End', () => {
    const none = [false, false, false, false];
    expect(nextIndex(0, 'ArrowRight', none)).toBe(1);
    expect(nextIndex(3, 'ArrowRight', none)).toBe(0);
    expect(nextIndex(0, 'ArrowLeft', none)).toBe(3);
    expect(nextIndex(1, 'ArrowDown', none)).toBe(2);
    expect(nextIndex(1, 'ArrowUp', none)).toBe(0);
    expect(nextIndex(0, 'ArrowRight', [false, true, false, false])).toBe(2);
    expect(nextIndex(2, 'Home', [true, false, false, true])).toBe(1);
    expect(nextIndex(1, 'End', [true, false, false, true])).toBe(2);
    expect(nextIndex(0, 'Enter', none)).toBeNull();
    expect(nextIndex(0, 'ArrowRight', [true, true])).toBeNull();
    expect(nextIndex(0, 'ArrowRight', [])).toBeNull();
  });

  it('renders a labelled radio group with one checked, tabbable option', () => {
    const html = render(
      <SegmentedControl
        aria-label="Status"
        value="open"
        onValueChange={() => {}}
        options={[
          { value: 'open', label: 'Open', count: 3 },
          { value: 'resolved', label: 'Resolved' },
          { value: 'snoozed', label: 'Snoozed', disabled: true },
        ]}
      />,
    );
    expect(html).toContain('role="radiogroup" aria-label="Status"');
    expect(count(html, /role="radio"/g)).toBe(3);
    expect(count(html, /aria-checked="true"/g)).toBe(1);
    expect(count(html, /tabindex="0"/g)).toBe(1);
    expect(html).toMatch(/aria-checked="true"[^>]*tabindex="0"/);
    expect(html).toContain('>3</span>');
  });
});

describe('ConfirmDialog and useConfirm', () => {
  it('useConfirm throws a clear error outside ConfirmProvider', () => {
    function Probe() {
      useConfirm();
      return null;
    }
    expect(() => render(<Probe />)).toThrow(/ConfirmProvider/);
  });

  it('useConfirm returns a function inside the provider', () => {
    function Probe() {
      return <span>{typeof useConfirm()}</span>;
    }
    const html = render(
      <ConfirmProvider>
        <Probe />
      </ConfirmProvider>,
    );
    expect(html).toContain('<span>function</span>');
  });

  it('a closed dialog renders nothing', () => {
    const html = render(<ConfirmDialog open={false} onOpenChange={() => {}} title="Delete?" onConfirm={() => {}} />);
    expect(html).not.toContain('Delete?');
  });
});
