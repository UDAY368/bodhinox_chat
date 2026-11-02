import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import { buildInboxSearchUrl, InboxSearch, localDayStart } from './inbox-search';
import { messageElementSelector, nextJumpStep } from './use-jump-to-message';

vi.mock('@/components/settings/numbers/use-whatsapp-numbers', () => ({
  useWhatsAppNumbers: () => ({ numbers: [], loading: false, reload: async () => [] }),
  numberLabel: () => 'n',
}));

const empty = { whatsappConfigId: null, status: '' as const, assignee: '' as const, from: '', to: '' };

describe('buildInboxSearchUrl', () => {
  it('sends only the set filters, with the end date as the next local midnight', () => {
    expect(buildInboxSearchUrl('late order', empty)).toBe('/api/inbox/search?q=late+order');
    const url = new URL(buildInboxSearchUrl('x', {
      whatsappConfigId: '33333333-3333-4333-8333-333333333333', status: 'open', assignee: 'me', from: '2026-11-01', to: '2026-11-01',
    }, 'CUR'), 'http://localhost');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: 'x', whatsapp_config_id: '33333333-3333-4333-8333-333333333333', status: 'open', assignee: 'me',
      from: new Date(2026, 10, 1).toISOString(), to: new Date(2026, 10, 2).toISOString(), cursor: 'CUR',
    });
  });

  it('ignores malformed dates', () => {
    expect(localDayStart('11/01/2026')).toBeNull();
    expect(buildInboxSearchUrl('x', { ...empty, from: 'bad' })).toBe('/api/inbox/search?q=x');
  });
});

describe('InboxSearch', () => {
  it('renders the query box, filters and the idle hint', () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={{}} onError={() => undefined} getMessageFallback={({ key }) => key}>
        <InboxSearch onOpen={() => undefined} />
      </NextIntlClientProvider>
    );
    expect(html).toContain('type="search"');
    expect(html).toContain('value="unassigned"');
    expect(html).toContain('type="date"');
    expect(html).toContain('hint');
    expect(html).not.toContain('whatsapp_config_id');
  });
});

describe('jump to message', () => {
  const base = { found: false, ready: true, loading: false, hasOlder: true, pagesLoaded: 0, maxPages: 3 };
  it('waits, scrolls, loads older pages, then gives up', () => {
    expect(nextJumpStep({ ...base, ready: false, found: true })).toBe('wait');
    expect(nextJumpStep({ ...base, found: true })).toBe('scroll');
    expect(nextJumpStep({ ...base, loading: true })).toBe('wait');
    expect(nextJumpStep(base)).toBe('load');
    expect(nextJumpStep({ ...base, pagesLoaded: 3 })).toBe('give_up');
    expect(nextJumpStep({ ...base, hasOlder: false })).toBe('give_up');
  });

  it('builds a quoted attribute selector', () => {
    expect(messageElementSelector('abc')).toBe('[data-message-id="abc"]');
    expect(messageElementSelector('a"]b')).toBe('[data-message-id="a\\"]b"]');
  });
});
