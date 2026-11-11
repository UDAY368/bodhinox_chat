import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INBOX_FILTERS,
  filtersInScope,
  isDefaultInboxFilters,
  MAX_SAVED_FILTER_TAGS,
  parseInboxFilters,
  parseSavedFilterName,
  sameInboxFilters,
  savedViewChannel,
  viewsForScope,
} from './saved-filters';

const TAG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TAG2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('parseInboxFilters', () => {
  it('keeps a valid filter set', () => {
    const value = { filter: 'unassigned', session: 'active', tagIds: [TAG], company: 'Acme', numberId: TAG2, search: 'refund', channel: 'whatsapp' };
    expect(parseInboxFilters(value)).toEqual(value);
    const instagram = { ...value, numberId: null, channel: 'instagram' };
    expect(parseInboxFilters(instagram)).toEqual(instagram);
  });

  it('reads a view saved before the channel inboxes', () => {
    // No channel and no number: any channel.
    expect(parseInboxFilters({ filter: 'open' }).channel).toBeNull();
    // A number filter only matched WhatsApp conversations, so the view is WhatsApp's.
    expect(parseInboxFilters({ numberId: TAG2 })).toMatchObject({ numberId: TAG2, channel: 'whatsapp' });
    expect(parseInboxFilters({ numberId: 'none' })).toMatchObject({ numberId: 'none', channel: 'whatsapp' });
  });

  it('refuses an unknown channel and a number on an Instagram view', () => {
    expect(parseInboxFilters({ channel: 'sms' }).channel).toBeNull();
    expect(parseInboxFilters({ channel: 'any' }).channel).toBeNull();
    expect(parseInboxFilters({ channel: 'instagram', numberId: TAG2 })).toMatchObject({ channel: 'instagram', numberId: null });
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
    expect(parsed).toEqual({ filter: 'open', session: 'all', tagIds: [TAG], company: 'Acme', numberId: 'none', search: 'hi', channel: 'whatsapp' });
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
    expect(sameInboxFilters(a, { ...b, channel: 'instagram' })).toBe(false);
  });
  it('recognises the default set', () => {
    expect(isDefaultInboxFilters({ ...DEFAULT_INBOX_FILTERS })).toBe(true);
    expect(isDefaultInboxFilters({ ...DEFAULT_INBOX_FILTERS, session: 'expired' })).toBe(false);
    expect(isDefaultInboxFilters({ ...DEFAULT_INBOX_FILTERS, channel: 'instagram' })).toBe(false);
  });
});

describe('views per inbox', () => {
  const view = (id: string, channel: 'whatsapp' | 'instagram' | null) =>
    ({ id, filters: { ...DEFAULT_INBOX_FILTERS, filter: 'open' as const, channel } });
  const views = [view('wa', 'whatsapp'), view('ig', 'instagram'), view('any', null)];

  it('offers every view in the All view and only matching or any-channel views in a channel inbox', () => {
    expect(viewsForScope(views, 'all').map((v) => v.id)).toEqual(['wa', 'ig', 'any']);
    expect(viewsForScope(views, 'whatsapp').map((v) => v.id)).toEqual(['wa', 'any']);
    expect(viewsForScope(views, 'instagram').map((v) => v.id)).toEqual(['ig', 'any']);
  });

  it('applies an any-channel view as the channel inbox it is opened in', () => {
    const any = views[2].filters;
    expect(filtersInScope(any, 'all')).toBe(any);
    expect(filtersInScope(any, 'instagram').channel).toBe('instagram');
    expect(sameInboxFilters(filtersInScope(any, 'whatsapp'), { ...any, channel: 'whatsapp' })).toBe(true);
  });
});

describe('savedViewChannel', () => {
  it('names the channel a view is saved under, as parseInboxFilters reads it back', () => {
    expect(savedViewChannel('whatsapp', null, null)).toBe('whatsapp');
    expect(savedViewChannel('instagram', null, null)).toBe('instagram');
    expect(savedViewChannel('all', null, null)).toBeNull();
    expect(savedViewChannel('all', 'instagram', null)).toBe('instagram');
    // A number filter in the All view: the view is WhatsApp's, so a saved
    // view still matches the inbox state it was saved from (no duplicate Save).
    const current = { ...DEFAULT_INBOX_FILTERS, numberId: TAG2, channel: savedViewChannel('all', null, TAG2) };
    expect(current.channel).toBe('whatsapp');
    expect(sameInboxFilters(parseInboxFilters(JSON.parse(JSON.stringify(current))), current)).toBe(true);
    expect(sameInboxFilters(parseInboxFilters({ ...current, channel: null }), current)).toBe(true);
  });
});
