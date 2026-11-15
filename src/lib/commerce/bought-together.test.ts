import { describe, expect, it } from 'vitest';
import { pickSuggestions } from './bought-together';

const p = (id: string, inStock = true) => ({ id, variants: [{ inStock }] });

describe('pickSuggestions', () => {
  it('keeps the database ranking, not the catalogue order', () => {
    expect(pickSuggestions(['c', 'a', 'b'], [p('a'), p('b'), p('c')]).map((x) => x.id)).toEqual(['c', 'a', 'b']);
  });
  it('drops ids that are not shown (draft, unpriced) and sold-out products', () => {
    expect(pickSuggestions(['x', 'a', 'b'], [p('a', false), p('b')]).map((x) => x.id)).toEqual(['b']);
  });
  it('caps at four', () => {
    const all = ['1', '2', '3', '4', '5', '6'];
    expect(pickSuggestions(all, all.map((id) => p(id)))).toHaveLength(4);
  });
  it('does not repeat a product', () => {
    expect(pickSuggestions(['a', 'a'], [p('a')])).toHaveLength(1);
  });
});
