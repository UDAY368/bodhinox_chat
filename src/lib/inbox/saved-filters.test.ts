import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INBOX_FILTERS,
  isDefaultInboxFilters,
  MAX_SAVED_FILTER_TAGS,
  parseInboxFilters,
  parseSavedFilterName,
  sameInboxFilters,
} from './saved-filters';

const TAG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TAG2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('parseInboxFilters', () => {
  it('keeps a valid filter set', () => {
    const value = { filter: 'unassigned', session: 'active', tagIds: [TAG], company: 'Acme', numberId: TAG2, search: 'refund' };
    expect(parseInboxFilters(value)).toEqual(value);
  });

  it('falls back to defaults for junk input', () => {
    expect(parseInboxFilters(null)).toEqual(DEFAULT_INBOX_FILTERS);
    expect(parseInboxFilters([1, 2])).toEqual(DEFAULT_INBOX_FILTERS);
    expect(parseInboxFilters({ filter: 'drop table', session: 'forever', tagIds: 'x', company: 7, numberId: 'abc', search: {} }))
      .toEqual(DEFAULT_INBOX_FILTERS);
  });

  it('drops unknown keys, bad and duplicate tags, and trims text', () => {
    const parsed = parseInboxFilters({
      filter: 'open', tagIds: [TAG, TAG.toUpperCase(), 'nope', 3], company: '  Acme  ', search: '  hi ', extra: 'x', numberId: 'none',
    });
    expect(parsed).toEqual({ filter: 'open', session: 'all', tagIds: [TAG], company: 'Acme', numberId: 'none', search: 'hi' });
    expect('extra' in parsed).toBe(false);
  });

  it('caps tags and text length', () => {
    const tags = Array.from({ length: 80 }, (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`);
    const parsed = parseInboxFilters({ tagIds: tags, search: 'x'.repeat(500), company: 'y'.repeat(500) });
    expect(parsed.tagIds).toHaveLength(MAX_SAVED_FILTER_TAGS);
    expect(parsed.search).toHaveLength(200);
    expect(parsed.company).toHaveLength(200);
  });
});

describe('parseSavedFilterName', () => {
  it.each([[' Mine ', 'Mine'], ['x'.repeat(80), 'x'.repeat(80)]])('accepts %j', (input, out) => {
    expect(parseSavedFilterName(input)).toBe(out);
  });
  it.each([[''], ['   '], ['x'.repeat(81)], [null], [5]])('rejects %j', (input) => {
    expect(parseSavedFilterName(input)).toBeNull();
  });
});

describe('sameInboxFilters', () => {
  it('ignores tag order and surrounding search whitespace', () => {
    const a = { ...DEFAULT_INBOX_FILTERS, tagIds: [TAG, TAG2], search: 'hi ' };
    const b = { ...DEFAULT_INBOX_FILTERS, tagIds: [TAG2, TAG], search: 'hi' };
    expect(sameInboxFilters(a, b)).toBe(true);
    expect(sameInboxFilters(a, { ...b, filter: 'open' })).toBe(false);
    expect(sameInboxFilters(a, { ...b, numberId: 'none' })).toBe(false);
  });
  it('recognises the default set', () => {
    expect(isDefaultInboxFilters({ ...DEFAULT_INBOX_FILTERS })).toBe(true);
    expect(isDefaultInboxFilters({ ...DEFAULT_INBOX_FILTERS, session: 'expired' })).toBe(false);
  });
});
