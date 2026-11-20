import { describe, expect, it } from 'vitest';

import en from '../../../messages/en.json';
import { CREATE_ENTRIES, filterCreateEntries, globalSearchUrl } from './page-search';

const label = (key: string) => (en.PageSearch.create as Record<string, string>)[key];

describe('global search helpers', () => {
  it('asks the server only from two characters, with the term encoded', () => {
    expect(globalSearchUrl(' a ')).toBeNull();
    expect(globalSearchUrl('#WA 10&x')).toBe('/api/search?q=%23WA%2010%26x');
  });

  it('filters the create shortcuts by their label', () => {
    expect(filterCreateEntries('', label)).toHaveLength(CREATE_ENTRIES.length);
    expect(filterCreateEntries('ORDER', label).map((e) => e.href)).toEqual(['/commerce/orders']);
    expect(filterCreateEntries('new b', label).map((e) => e.key)).toEqual(['booking', 'broadcast']);
    expect(filterCreateEntries('asha', label)).toEqual([]);
  });

  it('has a translated label for every group and shortcut', () => {
    for (const group of ['pages', 'contacts', 'orders', 'products', 'bookings', 'create'])
      expect((en.PageSearch.groups as Record<string, string>)[group]).toBeTruthy();
    for (const entry of CREATE_ENTRIES) expect(label(entry.key)).toBeTruthy();
  });
});
