import { describe, expect, it } from 'vitest';
import { cleanOptions, comboCount, mapRows, optionCombos, optionKey, optionsOf, skuBase, skuCandidates } from './variant-matrix';

type Row = { option_values: Record<string, string>; id: string | null; sku: string };
const fresh = (values: Record<string, string>): Row => ({ option_values: values, id: null, sku: '' });

describe('options matrix', () => {
  it('builds every combination, first option slowest', () => {
    expect(optionCombos([{ name: 'Size', values: ['S', 'M'] }, { name: 'Colour', values: ['Red', 'Blue'] }])).toEqual([
      { Size: 'S', Colour: 'Red' }, { Size: 'S', Colour: 'Blue' }, { Size: 'M', Colour: 'Red' }, { Size: 'M', Colour: 'Blue' },
    ]);
    expect(optionCombos([])).toEqual([{}]);
    expect(comboCount([{ name: 'Size', values: ['S', 'M', 'L'] }, { name: 'Colour', values: ['Red', 'Blue'] }])).toBe(6);
  });

  it('drops blank and repeated names and values before combining', () => {
    expect(cleanOptions([{ name: ' Size ', values: ['S', ' s', '', 'M'] }, { name: 'size', values: ['X'] }, { name: 'Empty', values: [] }]))
      .toEqual([{ name: 'Size', values: ['S', 'M'] }]);
  });

  it('compares combinations without case or key order', () => {
    expect(optionKey({ Size: 'M', Colour: 'Red' })).toBe(optionKey({ colour: 'red', size: 'm' }));
    expect(optionKey({ Size: 'M' })).not.toBe(optionKey({ Size: 'L' }));
  });

  it('reads the options back from existing variants in order of first use', () => {
    expect(optionsOf([{ option_values: { Size: 'M', Colour: 'Red' } }, { option_values: { Size: 'L', Colour: 'red' } }, { option_values: { Size: 'M', Colour: 'Blue' } }]))
      .toEqual([{ name: 'Size', values: ['M', 'L'] }, { name: 'Colour', values: ['Red', 'Blue'] }]);
  });

  it('keeps existing rows, adds new combinations and reports removed rows', () => {
    const rows: Row[] = [{ option_values: { Size: 'S' }, id: 'a', sku: 'A' }, { option_values: { Size: 'M' }, id: 'b', sku: 'B' }];
    const out = mapRows(optionCombos([{ name: 'Size', values: ['M', 'L'] }]), rows, fresh);
    expect(out.rows.map((r) => [r.id, r.option_values.Size])).toEqual([['b', 'M'], [null, 'L']]);
    expect(out.removed.map((r) => r.id)).toEqual(['a']);
  });

  it('turns the plain row into the first combination when options are added, and back when all are removed', () => {
    const plain: Row[] = [{ option_values: {}, id: 'p', sku: 'P' }];
    const added = mapRows(optionCombos([{ name: 'Size', values: ['S', 'M'] }]), plain, fresh);
    expect(added.rows.map((r) => r.id)).toEqual(['p', null]);
    expect(added.rows[0].option_values).toEqual({ Size: 'S' });
    expect(added.removed).toEqual([]);
    const back = mapRows(optionCombos([]), added.rows, fresh);
    expect(back.rows).toHaveLength(1);
    expect(back.rows[0]).toMatchObject({ id: 'p', option_values: {} });
    expect(back.removed.map((r) => r.id)).toEqual([null]);
  });

  it('restores an archived variant when its combination comes back', () => {
    const pool: Row[] = [{ option_values: { Size: 'XL' }, id: 'old', sku: 'OLD' }];
    const out = mapRows(optionCombos([{ name: 'Size', values: ['S', 'XL'] }]), [{ option_values: { Size: 'S' }, id: 's', sku: 'S' }], fresh, pool);
    expect(out.rows.map((r) => r.id)).toEqual(['s', 'old']);
  });
});

describe('generated SKUs', () => {
  it('reads like the product and its values and stays within the SKU rules', () => {
    expect(skuBase('Cotton Kurta', { Size: 'M', Colour: 'Navy Blue' })).toBe('COTTON-KURTA-M-NAVY-BLUE');
    expect(skuBase('  ', {})).toBe('ITEM');
    expect(skuBase('Café crème — 250g')).toBe('CAFE-CREME-250G');
    const long = skuBase('x'.repeat(100), { a: 'y'.repeat(50), b: 'z'.repeat(50) });
    expect(long.length).toBeLessThanOrEqual(56);
    for (const c of skuCandidates(long, 20)) expect(c).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
  });

  it('offers numbered alternatives', () => {
    expect(skuCandidates('TEA', 3)).toEqual(['TEA', 'TEA-2', 'TEA-3']);
  });
});
