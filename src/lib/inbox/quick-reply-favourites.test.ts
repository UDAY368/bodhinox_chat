import { describe, expect, it } from 'vitest';
import { sortFavouritesFirst } from './quick-reply-favourites';

const items = ['a', 'b', 'c', 'd'].map((id) => ({ id }));

describe('sortFavouritesFirst', () => {
  it('moves favourites first and keeps order inside each group', () => {
    expect(sortFavouritesFirst(items, new Set(['d', 'b'])).map((i) => i.id)).toEqual(['b', 'd', 'a', 'c']);
    expect(sortFavouritesFirst(items, ['c']).map((i) => i.id)).toEqual(['c', 'a', 'b', 'd']);
  });
  it('returns a copy and ignores unknown ids', () => {
    const out = sortFavouritesFirst(items, new Set(['zzz']));
    expect(out).toEqual(items);
    expect(out).not.toBe(items);
    expect(sortFavouritesFirst([], ['a'])).toEqual([]);
  });
});
