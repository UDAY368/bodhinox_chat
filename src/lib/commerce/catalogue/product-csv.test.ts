import { describe, expect, it } from 'vitest';
import {
  buildProductCsv, CsvError, guardCell, MAX_IMPORT_ROWS, parseCsv, parseProductCsv, planImport, toCsv, unguardCell, validateRow,
  type ExistingSku, type ImportRow, type RawRow,
} from './product-csv';

const raw = (cells: RawRow['cells'], rowNumber = 2): RawRow => ({ rowNumber, cells });
const ok = (cells: RawRow['cells']) => {
  const r = validateRow(raw(cells), 'INR');
  if (!('row' in r)) throw new Error(`expected a row, got ${JSON.stringify(r.errors)}`);
  return r.row;
};
const errs = (cells: RawRow['cells'], currency: string | null = 'INR') => {
  const r = validateRow(raw(cells), currency);
  return 'errors' in r ? r.errors.map((e) => `${e.field}:${e.code}`) : [];
};
const row = (sku: string, name: string | undefined, rowNumber: number, extra: Partial<ImportRow> = {}): ImportRow => ({ rowNumber, sku, name, ...extra });

describe('parseCsv', () => {
  it('reads quoted fields, doubled quotes, commas and newlines inside quotes', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\n"line1\nline2",z\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"'], ['line1\nline2', 'z']]);
  });
  it('strips a BOM, accepts CRLF, LF and CR, and skips blank lines', () => {
    expect(parseCsv('﻿a,b\r\n1,2\r\n\r\n3,4\r5,6')).toEqual([['a', 'b'], ['1', '2'], ['3', '4'], ['5', '6']]);
  });
  it('detects a semicolon delimiter from the header line', () => {
    expect(parseCsv('sku;name\nA1;Soap')).toEqual([['sku', 'name'], ['A1', 'Soap']]);
  });
  it('keeps empty cells and a trailing empty cell', () => {
    expect(parseCsv('a,b,c\n1,,\n')).toEqual([['a', 'b', 'c'], ['1', '', '']]);
  });
  it('refuses an unterminated quote, too many rows, too many columns and a huge cell', () => {
    expect(() => parseCsv('a,b\n"open,1')).toThrow(expect.objectContaining({ code: 'unterminated_quote' }));
    expect(() => parseCsv(`a\n${'x\n'.repeat(MAX_IMPORT_ROWS + 1)}`)).toThrow(expect.objectContaining({ code: 'too_many_rows' }));
    expect(() => parseCsv(`${Array.from({ length: 41 }, (_, i) => `c${i}`).join(',')}\n`)).toThrow(expect.objectContaining({ code: 'too_many_columns' }));
    expect(() => parseCsv(`a\n${'x'.repeat(20_001)}`)).toThrow(expect.objectContaining({ code: 'cell_too_long' }));
  });
  it('accepts exactly the row cap', () => {
    expect(parseCsv(`a\n${'x\n'.repeat(MAX_IMPORT_ROWS)}`)).toHaveLength(MAX_IMPORT_ROWS + 1);
  });
});

describe('parseProductCsv', () => {
  it('maps headers and aliases, numbers rows like a spreadsheet and counts ignored columns', () => {
    const file = parseProductCsv('SKU, Title ,Qty,Colour\nA1,Soap,5,red\nA2,Oil,,blue\n');
    expect(file.ignoredColumns).toBe(1);
    expect(file.rows).toEqual([
      { rowNumber: 2, cells: { sku: 'A1', name: 'Soap', stock: '5' } },
      { rowNumber: 3, cells: { sku: 'A2', name: 'Oil', stock: '' } },
    ]);
  });
  it('needs a SKU column and at least one data row', () => {
    expect(() => parseProductCsv('name\nSoap\n')).toThrow(expect.objectContaining({ code: 'missing_sku_column' }));
    expect(() => parseProductCsv('sku,name\n')).toThrow(CsvError);
  });
  it('takes the leading apostrophe of a guarded cell off again', () => {
    expect(parseProductCsv("sku,name\nA1,'=SUM(A1)\n").rows[0].cells.name).toBe('=SUM(A1)');
  });
});

describe('formula guard', () => {
  it.each(['=1+1', '+1', '-1', '@SUM(A1)', '\tcmd', '\rcmd'])('prefixes %j with an apostrophe', (cell) => {
    expect(guardCell(cell)).toBe(`'${cell}`);
  });
  it('leaves ordinary text and numbers alone', () => {
    expect(guardCell('Soap')).toBe('Soap');
    expect(guardCell(199)).toBe('199');
    expect(guardCell(null)).toBe('');
    expect(guardCell("it's =fine")).toBe("it's =fine");
  });
  it('guards every cell of the file, including quoted ones, and undoes it on the way back in', () => {
    const text = toCsv([['sku', 'name'], ['A1', '=HYPERLINK("http://x","y")'], ['A2', '-2+3'], ['A3', 'a,b']]);
    expect(text.startsWith('﻿')).toBe(true);
    expect(text).toContain("A1,\"'=HYPERLINK(\"\"http://x\"\",\"\"y\"\")\"");
    expect(text).toContain("A2,'-2+3");
    const back = parseCsv(text);
    expect(back[1]).toEqual(['A1', "'=HYPERLINK(\"http://x\",\"y\")"]);
    expect(unguardCell(back[1][1])).toBe('=HYPERLINK("http://x","y")');
    expect(back[3]).toEqual(['A3', 'a,b']);
  });
  it('never produces a cell that starts with a formula character in an export', () => {
    const csv = buildProductCsv([{
      sku: 'A1', name: '=cmd|"/c calc"!A1', description: '+1', category: '@x', tags: ['-t'], brand: '\tb', productType: null, status: 'draft',
      options: {}, priceMinor: 100, compareAtMinor: null, stock: 3, trackInventory: true, weightGrams: null, imageUrls: [],
    }], 'INR');
    for (const record of parseCsv(csv).slice(1)) for (const cell of record) expect(cell).not.toMatch(/^[=+\-@\t\r]/);
  });
});

describe('validateRow', () => {
  it('turns a full row into the fixed shape with money in minor units', () => {
    const r = ok({ sku: 'A-1', name: ' Soap ', description: 'Nice', category: 'Care', tags: 'Bath| Gift ,bath', brand: 'Acme', product_type: 'Soap',
      status: 'Published', options: 'Size=M|Color=Red', price: '1,234.50', compare_at_price: '1500', stock: '12', track_inventory: 'no',
      weight_grams: '250', image_urls: 'https://a.example/1.jpg|https://a.example/2.jpg' });
    expect(r).toMatchObject({ sku: 'A-1', name: 'Soap', tags: ['bath', 'gift'], brand: 'Acme', productType: 'Soap', status: 'published',
      options: { Size: 'M', Color: 'Red' }, priceMinor: 123450, compareAtMinor: 150000, stock: 12, trackInventory: false, weightGrams: 250,
      imageUrls: ['https://a.example/1.jpg', 'https://a.example/2.jpg'] });
  });
  it('leaves blank cells undefined', () => {
    expect(ok({ sku: 'A1', name: '', price: '' })).toEqual({ rowNumber: 2, sku: 'A1' });
  });
  it('uses the store currency exponent', () => {
    expect(validateRow(raw({ sku: 'A1', price: '1500' }), 'JPY')).toMatchObject({ row: { priceMinor: 1500 } });
    expect(errs({ sku: 'A1', price: '15.5' }, 'JPY')).toEqual(['price:invalid']);
  });
  it('names the column and a code for every problem, collecting all of them', () => {
    expect(errs({ sku: 'bad sku!', name: 'x'.repeat(201), price: '-5', stock: '1.5', status: 'live', tags: 'a'.repeat(41), options: 'Size',
      track_inventory: 'maybe', weight_grams: '-1', image_urls: 'http://insecure.example/a.png' })).toEqual([
      'sku:invalid', 'name:too_long', 'tags:invalid', 'status:invalid', 'options:invalid', 'price:invalid', 'stock:invalid', 'track_inventory:invalid',
      'weight_grams:invalid', 'image_urls:invalid']);
    expect(errs({})).toEqual(['sku:required']);
  });
  it('refuses a price when the store has no currency yet', () => {
    expect(errs({ sku: 'A1', price: '10' }, null)).toEqual(['price:store_not_configured']);
  });
  it('refuses control characters, duplicate option names, more than ten images and credentials in a URL', () => {
    expect(errs({ sku: 'A1', name: 'a\u0001b' })).toEqual(['name:invalid']);
    expect(errs({ sku: 'A1', brand: 'a\nb' })).toEqual(['brand:invalid']);
    expect(errs({ sku: 'A1', options: 'Size=M|Size=L' })).toEqual(['options:invalid']);
    expect(errs({ sku: 'A1', image_urls: Array.from({ length: 11 }, (_, i) => `https://a.example/${i}.png`).join('|') })).toEqual(['image_urls:invalid']);
    expect(errs({ sku: 'A1', image_urls: 'https://user:pw@a.example/x.png' })).toEqual(['image_urls:invalid']);
  });
  it('never echoes cell contents in an error', () => {
    const r = validateRow(raw({ sku: 'SECRET value', price: 'SECRET' }), 'INR');
    expect(JSON.stringify(r)).not.toContain('SECRET');
  });
});

describe('planImport', () => {
  const existing = new Map<string, ExistingSku>([
    ['A1', { productId: 'p1', variantId: 'v1' }],
    ['A2', { productId: 'p1', variantId: 'v2' }],
    ['B1', { productId: 'p2', variantId: 'v3' }],
  ]);

  it('matches by SKU only: known SKUs update, unknown SKUs create', () => {
    const plan = planImport([row('A1', 'Soap', 2), row('Z9', 'New thing', 3)], existing);
    expect(plan.planned.map((p) => [p.row.sku, p.kind, p.key])).toEqual([['A1', 'update', 'p:p1'], ['Z9', 'create', 'n:new thing']]);
    expect(plan.counts).toEqual({ create: 1, update: 1, newProducts: 1 });
  });
  it('treats an empty workspace as all new: another workspace SKUs are never in the map', () => {
    const plan = planImport([row('A1', 'Soap', 2)], new Map());
    expect(plan.planned[0]).toMatchObject({ kind: 'create', key: 'n:soap' });
  });
  it('groups rows of one name into one new product, first and last marked, product fields merged', () => {
    const plan = planImport([
      row('S-S', 'Tee', 2, { options: { Size: 'S' } }),
      row('S-M', ' tee ', 3, { options: { Size: 'M' }, description: 'Cotton', brand: 'Acme', status: 'published' }),
      row('S-L', 'TEE', 4, { options: { Size: 'L' } }),
    ], new Map());
    expect(plan.counts).toEqual({ create: 3, update: 0, newProducts: 1 });
    expect(plan.planned.map((p) => [p.first, p.last])).toEqual([[true, false], [false, false], [false, true]]);
    expect(plan.planned[0].patch).toMatchObject({ name: 'Tee', description: 'Cotton', brand: 'Acme' });
    expect(plan.planned.every((p) => p.status === 'published')).toBe(true);
  });
  it('attaches a new SKU to the existing product when its sibling SKU is known', () => {
    const plan = planImport([row('A1', 'Soap', 2), row('A3', 'soap', 3)], existing);
    expect(plan.planned.map((p) => [p.row.sku, p.kind, p.key])).toEqual([['A1', 'update', 'p:p1'], ['A3', 'create', 'p:p1']]);
    expect(plan.counts.newProducts).toBe(0);
  });
  it('refuses a repeated SKU, and a new SKU without a name; the rest still plan', () => {
    const plan = planImport([row('A1', 'Soap', 2), row('A1', 'Soap', 3), row('N1', undefined, 4), row('A2', undefined, 5)], existing);
    expect(plan.errors).toEqual([{ row: 3, field: 'sku', code: 'duplicate_sku' }, { row: 4, field: 'name', code: 'name_required' }]);
    expect(plan.planned.map((p) => p.row.sku)).toEqual(['A1', 'A2']);
  });
  it('is stable when run again after a partial apply: written SKUs become updates of the same product', () => {
    const rows = [row('N1', 'Hat', 2), row('N2', 'Hat', 3), row('N3', 'Hat', 4)];
    const first = planImport(rows, new Map());
    expect(first.counts).toEqual({ create: 3, update: 0, newProducts: 1 });
    // The first two rows were written (product p9) before a crash.
    const after = new Map<string, ExistingSku>([['N1', { productId: 'p9', variantId: 'v1' }], ['N2', { productId: 'p9', variantId: 'v2' }]]);
    const second = planImport(rows, after);
    expect(second.counts).toEqual({ create: 1, update: 2, newProducts: 0 });
    expect(second.planned.map((p) => p.key)).toEqual(['p:p9', 'p:p9', 'p:p9']);
  });
  it('keeps products apart when the names differ and uses the first status given', () => {
    const plan = planImport([row('X1', 'One', 2, { status: 'archived' }), row('Y1', 'Two', 3), row('X2', 'One', 4, { status: 'published' })], new Map());
    expect(plan.counts.newProducts).toBe(2);
    expect(plan.planned.find((p) => p.row.sku === 'X2')?.status).toBe('archived');
    expect(plan.planned.find((p) => p.row.sku === 'Y1')?.status).toBeUndefined();
  });
});

describe('buildProductCsv', () => {
  it('writes one row per variant with major-unit prices, joined tags, options and images', () => {
    const csv = buildProductCsv([{
      sku: 'A1', name: 'Soap', description: 'Line 1\nLine 2', category: 'Care > Bath', tags: ['a', 'b'], brand: 'Acme', productType: null, status: 'published',
      options: { Size: 'M' }, priceMinor: 123450, compareAtMinor: null, stock: null, trackInventory: false, weightGrams: 200, imageUrls: ['https://a.example/1.png'],
    }], 'INR');
    const [header, line] = parseCsv(csv);
    expect(header[0]).toBe('sku');
    expect(Object.fromEntries(header.map((h, i) => [h, line[i]]))).toMatchObject({
      sku: 'A1', description: 'Line 1\nLine 2', category: 'Care > Bath', tags: 'a|b', status: 'published', options: 'Size=M', price: '1234.50',
      compare_at_price: '', stock: '', track_inventory: 'no', weight_grams: '200', image_urls: 'https://a.example/1.png',
    });
  });
  it('round-trips through the importer', () => {
    const csv = buildProductCsv([{
      sku: 'A1', name: 'Soap', description: '-dash first', category: null, tags: ['a'], brand: null, productType: 'Bar', status: 'draft',
      options: { Size: 'M' }, priceMinor: 500, compareAtMinor: 800, stock: 4, trackInventory: true, weightGrams: null, imageUrls: [],
    }], 'INR');
    const { rows } = parseProductCsv(csv);
    expect(ok(rows[0].cells)).toMatchObject({ sku: 'A1', name: 'Soap', description: '-dash first', tags: ['a'], productType: 'Bar', options: { Size: 'M' },
      priceMinor: 500, compareAtMinor: 800, stock: 4, trackInventory: true });
  });
  it('writes only the header for an empty catalogue', () => {
    expect(parseCsv(buildProductCsv([], 'INR'))).toHaveLength(1);
  });
});
