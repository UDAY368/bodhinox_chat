import { describe, expect, it } from 'vitest';
import { chooseKept, DowngradeInputError, parseSelection, type ArchivableItem } from './downgrade';

const item = (id: string): ArchivableItem => ({ id, name: id, lastUsedAt: null, state: 'kept' });
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// Most recently used first.
const items = [item('a'), item('b'), item('c'), item('d')];

describe('chooseKept', () => {
  it('changes nothing within the limit or when unlimited', () => {
    expect(chooseKept(items, 4)).toEqual({ keep: ['a', 'b', 'c', 'd'], archive: [] });
    expect(chooseKept(items, null)).toEqual({ keep: ['a', 'b', 'c', 'd'], archive: [] });
  });

  it('keeps the most recently used without a choice', () => {
    expect(chooseKept(items, 2)).toEqual({ keep: ['a', 'b'], archive: ['c', 'd'] });
    expect(chooseKept(items, 0)).toEqual({ keep: [], archive: ['a', 'b', 'c', 'd'] });
  });

  it('keeps the admin choice first and fills free places by recent use', () => {
    expect(chooseKept(items, 2, ['d'])).toEqual({ keep: ['d', 'a'], archive: ['b', 'c'] });
    expect(chooseKept(items, 2, ['d', 'c', 'b'])).toEqual({ keep: ['d', 'c'], archive: ['a', 'b'] });
  });

  it('ignores chosen ids that are no longer in use or repeated', () => {
    expect(chooseKept(items, 2, ['gone', 'c', 'c'])).toEqual({ keep: ['c', 'a'], archive: ['b', 'd'] });
  });
});

describe('parseSelection', () => {
  it('accepts id lists per kind, de-duplicated and lower-cased', () => {
    expect(parseSelection({ segments: [ID(1), ID(1).toUpperCase()], flows: [] })).toEqual({ segments: [ID(1)], flows: [] });
    expect(parseSelection({})).toEqual({});
  });

  it.each([null, [], 'x', { tags: [ID(1)] }, { segments: 'x' }, { lists: ['not-a-uuid'] }, { automations: [1] },
    { segments: Array.from({ length: 1001 }, (_, i) => ID(i)) }])('rejects %j', (input) => {
    expect(() => parseSelection(input)).toThrow(DowngradeInputError);
  });
});
