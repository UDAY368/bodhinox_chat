import { describe, expect, it } from 'vitest';
import { catalogueSearchPattern, decodeCatalogueCursor, encodeCatalogueCursor } from './storefront';

const ID = '11111111-1111-4111-8111-111111111111';

describe('storefront catalogue cursor', () => {
  it('round-trips the sort key of the last product on a page', () => {
    const cursor = { position: 3, name: 'Tulsi drops, 30 ml', id: ID };
    expect(decodeCatalogueCursor(encodeCatalogueCursor(cursor))).toEqual(cursor);
    expect(decodeCatalogueCursor(encodeCatalogueCursor({ position: 2_147_483_647, name: '', id: ID }))).toEqual({ position: 2_147_483_647, name: '', id: ID });
  });
  it.each([
    [undefined], [null], [''], [42], ['not base64 json'], [Buffer.from('[1,"a"]').toString('base64url')],
    [Buffer.from(JSON.stringify([-1, 'a', ID])).toString('base64url')], [Buffer.from(JSON.stringify([1.5, 'a', ID])).toString('base64url')],
    [Buffer.from(JSON.stringify([1, 'a', 'not-a-uuid'])).toString('base64url')], [Buffer.from(JSON.stringify([1, 7, ID])).toString('base64url')],
    ['x'.repeat(401)],
  ])('ignores a cursor it did not make: %j', (value) => {
    expect(decodeCatalogueCursor(value)).toBeNull();
  });
});

describe('catalogueSearchPattern', () => {
  it('matches the term anywhere, with LIKE wildcards taken literally', () => {
    expect(catalogueSearchPattern('  tulsi ')).toBe('%tulsi%');
    expect(catalogueSearchPattern(String.raw`100%_pure\x`)).toBe(String.raw`%100\%\_pure\\x%`);
  });
  it('means no search for an empty or non-text term, and caps a long one', () => {
    expect(catalogueSearchPattern('   ')).toBeNull();
    expect(catalogueSearchPattern(null)).toBeNull();
    expect(catalogueSearchPattern(['a'])).toBeNull();
    expect(catalogueSearchPattern('a'.repeat(200))).toBe(`%${'a'.repeat(80)}%`);
  });
});
