/**
 * Options and variants as a matrix (shared by the product form and the server):
 * the seller types option names and values once (Size: S, M, L; Colour: Red,
 * Blue) and gets one row per combination. Pure functions only, no I/O.
 */

export const MAX_OPTION_NAMES = 4;
export const MAX_OPTION_VALUES = 30;
/** The most variants one product form may hold (rows of the matrix). */
export const MAX_VARIANTS = 100;

export interface ProductOption { name: string; values: string[] }

/** A combination's identity: option names and values compared case-insensitively, order of keys ignored. */
export function optionKey(values: Record<string, string>): string {
  return JSON.stringify(Object.entries(values)
    .map(([k, v]) => [k.trim().toLowerCase(), v.trim().toLowerCase()])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Options without blank names or values and without repeats (case-insensitive), in the order typed. */
export function cleanOptions(options: ProductOption[]): ProductOption[] {
  const seen = new Set<string>();
  const out: ProductOption[] = [];
  for (const o of options) {
    const name = o.name.trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const vs = new Set<string>();
    const values = o.values.map((v) => v.trim()).filter((v) => v && !vs.has(v.toLowerCase()) && vs.add(v.toLowerCase()));
    if (values.length) out.push({ name, values });
  }
  return out;
}

/** Every combination, first option slowest: [{Size:S,Colour:Red},{Size:S,Colour:Blue},...]. No options = one empty combination. */
export function optionCombos(options: ProductOption[]): Record<string, string>[] {
  let combos: Record<string, string>[] = [{}];
  for (const o of cleanOptions(options)) combos = combos.flatMap((c) => o.values.map((v) => ({ ...c, [o.name]: v })));
  return combos;
}

/** How many rows these options make (without building them). */
export const comboCount = (options: ProductOption[]) => cleanOptions(options).reduce((n, o) => n * o.values.length, 1);

/** The options a set of variants already uses: names in order of first use, values in order of first use. */
export function optionsOf(variants: { option_values: Record<string, string> }[]): ProductOption[] {
  const out: ProductOption[] = [];
  for (const v of variants) {
    for (const [name, value] of Object.entries(v.option_values)) {
      let o = out.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (!o) { o = { name, values: [] }; out.push(o); }
      if (!o.values.some((x) => x.toLowerCase() === value.toLowerCase())) o.values.push(value);
    }
  }
  return out;
}

/**
 * Map the new combinations onto existing rows: a row whose options match keeps
 * its place (id, SKU, price, stock); when a product goes from no options to
 * options, its single row becomes the first combination; anything else is a
 * new row from `fresh`. `removed` lists the old rows no combination kept.
 */
export function mapRows<R extends { option_values: Record<string, string> }>(combos: Record<string, string>[], rows: R[],
  fresh: (values: Record<string, string>) => R, pool: R[] = []): { rows: R[]; removed: R[] } {
  const byKey = new Map<string, R>();
  for (const r of [...pool, ...rows]) byKey.set(optionKey(r.option_values), r);
  const used = new Set<R>();
  // The product's one plain row (no options) becomes the first new combination, and the first row becomes the plain row when
  // every option is removed, keeping its id, SKU, price and stock.
  const plain = (v: Record<string, string>) => Object.keys(v).length === 0;
  let adopt = rows.length > 0 && ((rows.length === 1 && plain(rows[0].option_values)) || (combos.length === 1 && plain(combos[0]))) ? rows[0] : null;
  const out = combos.map((values) => {
    const match = byKey.get(optionKey(values));
    if (match && !used.has(match)) { used.add(match); return { ...match, option_values: values }; }
    if (adopt && !used.has(adopt)) { const row = adopt; adopt = null; used.add(row); return { ...row, option_values: values }; }
    return fresh(values);
  });
  return { rows: out, removed: rows.filter((r) => !used.has(r)) };
}

/** A readable SKU base from the product name and option values: "Cotton Kurta" + {Size: M} -> "COTTON-KURTA-M". */
export function skuBase(name: string, values: Record<string, string> = {}): string {
  const part = (text: string, max: number) => text.normalize('NFKD').replace(/\p{M}+/gu, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toUpperCase().slice(0, max).replace(/-+$/, '');
  const stem = part(name, 24) || 'ITEM';
  const tail = Object.values(values).map((v) => part(v, 10)).filter(Boolean);
  return [stem, ...tail].join('-').slice(0, 56).replace(/-+$/, '');
}

/** Candidates for a free SKU: the base, then base-2 ... base-<n>, each within 64 characters. */
export function skuCandidates(base: string, n = 20): string[] {
  const out = [base];
  for (let i = 2; i <= n; i++) {
    const suffix = `-${i}`;
    out.push(`${base.slice(0, 64 - suffix.length)}${suffix}`);
  }
  return out;
}
