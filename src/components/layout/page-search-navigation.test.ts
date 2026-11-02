import { describe, expect, it } from 'vitest';
import {
  filterPages,
  getPageTitleKey,
  navigationPages,
} from './page-search-navigation';

describe('workspace navigation', () => {
  it('includes all eleven live destinations', () => {
    expect(filterPages('', (key) => key)).toHaveLength(11);
    expect(navigationPages.map((page) => page.href)).toContain('/agents');
    expect(navigationPages.map((page) => page.href)).toContain('/flows');
    expect(navigationPages.map((page) => page.href)).toContain('/forms');
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
    expect(getPageTitleKey('/inbox-archive')).toBe('dashboard');
  });
});
