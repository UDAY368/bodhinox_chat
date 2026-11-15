/**
 * Product CSV import and export, the pure part (no database): the parser, the
 * row validator, the spreadsheet-formula guard, the import plan and the
 * export writer. product-csv-import.ts applies a plan to the database.
 *
 * One row per variant. A row matches a variant by SKU inside the workspace
 * only; rows with the same product name (or whose SKUs already belong to one
 * product) are the variants of one product. A blank cell means "leave as it
 * is" on an update and "not set" on a create, so a file can never wipe a field.
 * Errors name the row, the column and a code, never the cell contents.
 */
import { currencyExponent, minorToDecimalString, MoneyError, parseMoney } from '../money';
import { CatalogueError, MAX_IMAGES, parseOptionValues, parseTags, PRODUCT_STATUSES, SKU, type ProductStatus } from './products';

export const MAX_CSV_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 5000;
/** Files up to this many rows apply inside the request; larger ones are queued for the worker. */
export const INLINE_MAX_ROWS = 200;
/** Rows applied per worker transaction. */
export const IMPORT_CHUNK = 100;
export const MAX_REPORTED_ERRORS = 200;
export const MAX_EXPORT_ROWS = 50_000;
const MAX_COLUMNS = 40;
const MAX_CELL = 20_000;

export type CsvErrorCode = 'empty' | 'too_large' | 'too_many_rows' | 'too_many_columns' | 'cell_too_long' | 'unterminated_quote' | 'missing_sku_column';
export class CsvError extends Error {
  constructor(readonly code: CsvErrorCode) {
    super(code);
    this.name = 'CsvError';
  }
}

export interface RowError { row: number; field: string; code: string }

// ------------------------------------------------------------ writing

/** A cell as the next spreadsheet will read it: a leading = + - @ tab or CR gets an apostrophe in front, so it can never run as a formula. */
export function guardCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

/** The reverse of guardCell for a re-imported export. */
export function unguardCell(value: string): string {
  return /^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value;
}

const quote = (text: string) => (/[",\r\n]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text);

/** Rows of cells as CSV text: every cell guarded, quoted where needed, CRLF line ends, a BOM so Excel reads UTF-8. */
export function toCsv(rows: readonly (readonly unknown[])[]): string {
  return `﻿${rows.map((r) => r.map((c) => quote(guardCell(c))).join(',')).join('\r\n')}\r\n`;
}

// ------------------------------------------------------------ parsing

/** RFC 4180 parsing: quoted fields, doubled quotes, newlines inside quotes, CRLF/LF/CR, a leading BOM. Throws CsvError. */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const head = text.split(/\r\n|\n|\r/, 1)[0] ?? '';
  const count = (ch: string) => head.split(ch).length - 1;
  const delimiter = count(',') >= count(';') && count(',') >= count('\t') ? ',' : count(';') >= count('\t') ? ';' : '\t';
  const records: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false, wasQuoted = false;
  const endCell = () => {
    if (cell.length > MAX_CELL) throw new CsvError('cell_too_long');
    row.push(cell);
    cell = '';
    wasQuoted = false;
    if (row.length > MAX_COLUMNS) throw new CsvError('too_many_columns');
  };
  const endRow = () => {
    endCell();
    if (row.length > 1 || row[0] !== '') records.push(row); // a blank line is skipped
    row = [];
    if (records.length > MAX_IMPORT_ROWS + 1) throw new CsvError('too_many_rows');
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
      if (cell.length > MAX_CELL) throw new CsvError('cell_too_long');
    } else if (ch === '"' && cell === '' && !wasQuoted) { quoted = true; wasQuoted = true; }
    else if (ch === delimiter) endCell();
    else if (ch === '\r' || ch === '\n') { if (ch === '\r' && text[i + 1] === '\n') i++; endRow(); }
    else cell += ch;
  }
  if (quoted) throw new CsvError('unterminated_quote');
  if (cell !== '' || row.length) endRow();
  return records;
}

export const COLUMNS = ['sku', 'name', 'description', 'category', 'tags', 'brand', 'product_type', 'status', 'options', 'price',
  'compare_at_price', 'stock', 'track_inventory', 'weight_grams', 'image_urls'] as const;
export type Column = (typeof COLUMNS)[number];

const ALIASES: Record<string, Column> = {
  variant_sku: 'sku', title: 'name', product_name: 'name', product: 'name', type: 'product_type', category_name: 'category',
  compare_at: 'compare_at_price', compare_price: 'compare_at_price', quantity: 'stock', qty: 'stock', on_hand: 'stock',
  images: 'image_urls', image_url: 'image_urls', tracked: 'track_inventory', weight: 'weight_grams',
};
const headerKey = (h: string) => h.trim().toLowerCase().replace(/[\s-]+/g, '_');

export interface RawRow { rowNumber: number; cells: Partial<Record<Column, string>> }
export interface ParsedFile { rows: RawRow[]; ignoredColumns: number }

/** Header row plus data rows. Unknown columns are ignored (counted); a SKU column is required. Row numbers are spreadsheet rows (the header is row 1). */
export function parseProductCsv(text: string): ParsedFile {
  const records = parseCsv(text);
  if (records.length < 2) throw new CsvError('empty');
  const header = records[0].map((h) => { const k = headerKey(h); return (COLUMNS as readonly string[]).includes(k) ? (k as Column) : ALIASES[k] ?? null; });
  if (!header.includes('sku')) throw new CsvError('missing_sku_column');
  const rows: RawRow[] = [];
  for (const [index, record] of records.slice(1).entries()) {
    const cells: Partial<Record<Column, string>> = {};
    header.forEach((column, i) => {
      if (column && cells[column] === undefined) cells[column] = unguardCell((record[i] ?? '').trim());
    });
    rows.push({ rowNumber: index + 2, cells });
  }
  return { rows, ignoredColumns: header.filter((h) => h === null).length };
}

// ------------------------------------------------------------ validating

export interface ImportRow {
  rowNumber: number;
  sku: string;
  /** undefined = the cell was blank. */
  name?: string;
  description?: string;
  category?: string;
  tags?: string[];
  brand?: string;
  productType?: string;
  status?: ProductStatus;
  options?: Record<string, string>;
  priceMinor?: number;
  compareAtMinor?: number;
  stock?: number;
  trackInventory?: boolean;
  weightGrams?: number;
  imageUrls?: string[];
}

const CONTROL = /[\u0000-\u001f\u007f]/;
const YES = new Set(['yes', 'y', 'true', '1']), NO = new Set(['no', 'n', 'false', '0']);

function line(value: string, max: number): string | null {
  return CONTROL.test(value) || value.length > max ? null : value.replace(/\s+/g, ' ');
}

/** One row to the fixed import shape, or its errors. `currency` is the store currency (null before store settings exist). */
export function validateRow(raw: RawRow, currency: string | null): { row: ImportRow } | { errors: RowError[] } {
  const c = raw.cells;
  const errors: RowError[] = [];
  const fail = (field: string, code: string) => errors.push({ row: raw.rowNumber, field, code });
  const out: ImportRow = { rowNumber: raw.rowNumber, sku: '' };
  const present = (k: Column) => (c[k] ?? '') !== '';

  const sku = c.sku ?? '';
  if (!sku) fail('sku', 'required');
  else if (!SKU.test(sku)) fail('sku', 'invalid');
  else out.sku = sku;

  if (present('name')) {
    if (c.name!.length > 200) fail('name', 'too_long');
    else if (CONTROL.test(c.name!)) fail('name', 'invalid');
    else out.name = c.name!.trim();
  }
  if (present('description')) {
    if (c.description!.length > 5000) fail('description', 'too_long');
    else out.description = c.description;
  }
  if (present('category')) {
    if (c.category!.length > 200 || CONTROL.test(c.category!)) fail('category', 'invalid');
    else out.category = c.category;
  }
  if (present('tags')) {
    try { out.tags = parseTags(c.tags!.split(/[|,]/).map((t) => t.trim()).filter(Boolean)); } catch { fail('tags', 'invalid'); }
  }
  for (const [column, key] of [['brand', 'brand'], ['product_type', 'productType']] as const) {
    if (!present(column)) continue;
    const value = line(c[column]!, 80);
    if (value) out[key] = value; else fail(column, 'invalid');
  }
  if (present('status')) {
    const status = c.status!.toLowerCase();
    if ((PRODUCT_STATUSES as readonly string[]).includes(status)) out.status = status as ProductStatus; else fail('status', 'invalid');
  }
  if (present('options')) {
    try {
      const pairs = c.options!.split('|').map((part) => {
        const at = part.indexOf('=');
        if (at < 1) throw new CatalogueError('invalid', 'options');
        return [part.slice(0, at).trim(), part.slice(at + 1).trim()] as const;
      });
      out.options = parseOptionValues(Object.fromEntries(pairs));
      if (Object.keys(out.options).length !== pairs.length) fail('options', 'invalid');
    } catch { fail('options', 'invalid'); }
  }
  for (const [column, key] of [['price', 'priceMinor'], ['compare_at_price', 'compareAtMinor']] as const) {
    if (!present(column)) continue;
    if (!currency) { fail(column, 'store_not_configured'); continue; }
    try { out[key] = parseMoney(c[column]!, currency); } catch (e) { if (e instanceof MoneyError) fail(column, 'invalid'); else throw e; }
  }
  if (present('stock')) {
    if (/^\d{1,7}$/.test(c.stock!) && Number(c.stock) <= 1_000_000) out.stock = Number(c.stock); else fail('stock', 'invalid');
  }
  if (present('track_inventory')) {
    const v = c.track_inventory!.toLowerCase();
    if (YES.has(v)) out.trackInventory = true; else if (NO.has(v)) out.trackInventory = false; else fail('track_inventory', 'invalid');
  }
  if (present('weight_grams')) {
    if (/^\d{1,7}$/.test(c.weight_grams!) && Number(c.weight_grams) <= 1_000_000) out.weightGrams = Number(c.weight_grams); else fail('weight_grams', 'invalid');
  }
  if (present('image_urls')) {
    const urls = c.image_urls!.split('|').map((u) => u.trim()).filter(Boolean);
    const good = urls.length <= MAX_IMAGES && urls.every((u) => {
      try { const p = new URL(u); return u.length <= 2048 && p.protocol === 'https:' && !p.username && !p.password; } catch { return false; }
    });
    if (good && urls.length) out.imageUrls = urls; else fail('image_urls', 'invalid');
  }
  return errors.length ? { errors } : { row: out };
}

// ------------------------------------------------------------ planning

export interface ExistingSku { productId: string; variantId: string }

/** The product-level fields of a group, merged from its rows (the first non-blank value of each). */
export interface ProductPatch {
  name?: string; description?: string; category?: string; tags?: string[]; brand?: string; productType?: string; imageUrls?: string[];
}

export interface PlannedRow {
  row: ImportRow;
  /** A new variant (the SKU is not in the workspace yet) or an existing one. */
  kind: 'create' | 'update';
  /** 'p:<product id>' for an existing product, 'n:<name>' for one this file creates. */
  key: string;
  /** The first row of its product: carries the product fields. */
  first: boolean;
  /** The last row of its product: the status is applied after it. */
  last: boolean;
  patch: ProductPatch;
  status?: ProductStatus;
}

export interface ImportPlan {
  planned: PlannedRow[];
  errors: RowError[];
  /** New variants, existing variants and new products this file would create. */
  counts: { create: number; update: number; newProducts: number };
}

const nameKey = (name: string) => name.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Which rows create and which update, and which rows belong together. Pure and
 * stateless: applied again after an interruption, the rows already written are
 * found by SKU and the same plan comes out, so nothing is created twice.
 */
export function planImport(rows: readonly ImportRow[], existing: ReadonlyMap<string, ExistingSku>): ImportPlan {
  const errors: RowError[] = [];
  const seen = new Set<string>();
  const nameToProduct = new Map<string, string>();
  const valid: ImportRow[] = [];
  for (const row of rows) {
    if (seen.has(row.sku)) { errors.push({ row: row.rowNumber, field: 'sku', code: 'duplicate_sku' }); continue; }
    seen.add(row.sku);
    valid.push(row);
    const e = existing.get(row.sku);
    if (e && row.name && !nameToProduct.has(nameKey(row.name))) nameToProduct.set(nameKey(row.name), e.productId);
  }
  const planned: PlannedRow[] = [];
  const groups = new Map<string, PlannedRow[]>();
  for (const row of valid) {
    const e = existing.get(row.sku);
    let key: string;
    if (e) key = `p:${e.productId}`;
    else if (!row.name) { errors.push({ row: row.rowNumber, field: 'name', code: 'name_required' }); continue; }
    else key = nameToProduct.has(nameKey(row.name)) ? `p:${nameToProduct.get(nameKey(row.name))}` : `n:${nameKey(row.name)}`;
    const item: PlannedRow = { row, kind: e ? 'update' : 'create', key, first: false, last: false, patch: {} };
    planned.push(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  for (const members of groups.values()) {
    members[0].first = true;
    members[members.length - 1].last = true;
    const patch: ProductPatch = {};
    for (const { row } of members) {
      patch.name ??= row.name;
      patch.description ??= row.description;
      patch.category ??= row.category;
      patch.tags ??= row.tags;
      patch.brand ??= row.brand;
      patch.productType ??= row.productType;
      patch.imageUrls ??= row.imageUrls;
    }
    members[0].patch = patch;
    const status = members.find((m) => m.row.status)?.row.status;
    for (const m of members) m.status = status;
  }
  const create = planned.filter((p) => p.kind === 'create').length;
  return {
    planned,
    errors: errors.sort((a, b) => a.row - b.row),
    counts: { create, update: planned.length - create, newProducts: [...groups.keys()].filter((k) => k.startsWith('n:')).length },
  };
}

// ------------------------------------------------------------ export

export interface ExportRow {
  sku: string;
  name: string;
  description: string | null;
  category: string | null;
  tags: readonly string[];
  brand: string | null;
  productType: string | null;
  status: string;
  options: Record<string, string>;
  priceMinor: number | null;
  compareAtMinor: number | null;
  /** On hand; null for a made-to-order variant. */
  stock: number | null;
  trackInventory: boolean;
  weightGrams: number | null;
  imageUrls: readonly string[];
}

/** The catalogue as CSV text: one row per variant, product fields repeated, prices in major units of the store currency. */
export function buildProductCsv(rows: readonly ExportRow[], currency: string | null): string {
  const money = (minor: number | null) => (minor === null || !currency ? '' : minorToDecimalString(minor, currency));
  if (currency) currencyExponent(currency);
  return toCsv([
    [...COLUMNS],
    ...rows.map((r) => [
      r.sku, r.name, r.description ?? '', r.category ?? '', r.tags.join('|'), r.brand ?? '', r.productType ?? '', r.status,
      Object.entries(r.options).map(([k, v]) => `${k}=${v}`).join('|'), money(r.priceMinor), money(r.compareAtMinor),
      r.stock ?? '', r.trackInventory ? 'yes' : 'no', r.weightGrams ?? '', r.imageUrls.join('|'),
    ]),
  ]);
}
