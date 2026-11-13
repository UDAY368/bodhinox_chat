import { describe, expect, it } from 'vitest';
import { pageItems } from './table-pagination';

describe('pageItems', () => {
  it('shows every page when there are seven or fewer', () => {
    expect(pageItems(0, 1)).toEqual([0]);
    expect(pageItems(3, 7)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('keeps first, last and the current neighbourhood with gaps', () => {
    expect(pageItems(0, 20)).toEqual([0, 1, 2, 3, 4, 'gap', 19]);
    expect(pageItems(9, 20)).toEqual([0, 'gap', 8, 9, 10, 'gap', 19]);
    expect(pageItems(19, 20)).toEqual([0, 'gap', 15, 16, 17, 18, 19]);
  });

  it('always shows the same number of buttons once pages overflow', () => {
    for (let p = 0; p < 30; p++) expect(pageItems(p, 30)).toHaveLength(7);
  });
});
