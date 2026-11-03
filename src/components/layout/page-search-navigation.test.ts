import { describe, expect, it } from 'vitest';
import {
  filterPages,
  getPageTitleKey,
  navigationPages,
} from './page-search-navigation';

describe('workspace navigation', () => {
  it('includes all seventeen live destinations', () => {
    expect(filterPages('', (key) => key)).toHaveLength(17);
    const hrefs = navigationPages.map((page) => page.href);
    for (const href of ['/ads', '/agents', '/appointments', '/flows', '/forms', '/analytics', '/commerce/orders', '/commerce/products', '/commerce/payments'])
      expect(hrefs).toContain(href);
  });

  it('has a page title and a search label in every locale for every destination', async () => {
    for (const locale of ['en', 'es', 'pt', 'ko']) {
      const messages = (await import(`../../../messages/${locale}.json`)).default as Record<string, Record<string, unknown>>;
      for (const page of navigationPages) {
        expect(messages.Sidebar[page.labelKey], `${locale} Sidebar.${page.labelKey}`).toBeTypeOf('string');
        expect(messages.Header[page.labelKey], `${locale} Header.${page.labelKey}`).toBeTypeOf('string');
      }
    }
  });

  it('searches translated page labels and routes without case or whitespace sensitivity', () => {
    const label = (key: string) => (key === 'contacts' ? 'Contactos' : key);
    expect(filterPages('  CONTACTOS ', label).map((page) => page.href)).toEqual(
      ['/contacts']
    );
    expect(filterPages('/agents', label).map((page) => page.href)).toEqual([
      '/agents',
    ]);
    expect(filterPages('missing page', label)).toEqual([]);
  });

  it('resolves nested routes without confusing unrelated prefixes', () => {
    expect(getPageTitleKey('/agents/123')).toBe('aiAgents');
    expect(getPageTitleKey('/flows/new')).toBe('flows');
    expect(getPageTitleKey('/forms/123')).toBe('forms');
    expect(getPageTitleKey('/analytics')).toBe('analytics');
    expect(getPageTitleKey('/ads')).toBe('ads');
    expect(getPageTitleKey('/appointments')).toBe('appointments');
    expect(getPageTitleKey('/commerce/orders/42')).toBe('orders');
    expect(getPageTitleKey('/commerce')).toBe('dashboard');
    expect(getPageTitleKey('/inbox-archive')).toBe('dashboard');
  });
});
