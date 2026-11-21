/**
 * Pure helpers for the product page's pickers (no React, no storage): which
 * option values can still be bought given the other chosen options, what a
 * tap on a value picks, and the most of one variant a buyer can add.
 */
export interface OptionVariant { id: string; options: Record<string, string>; inStock: boolean; available: number | null }

/** The most of one line a cart holds (the server's CART_LIMITS.maxQty). */
export const LINE_MAX = 99;

/**
 * A value of one option, given the other options already picked:
 * 'in_stock' some matching variant can be bought; 'sold_out' matching variants exist but none can;
 * 'none' no variant has this value with the other picks.
 */
export type ValueState = 'in_stock' | 'sold_out' | 'none';

const matchesOthers = (v: OptionVariant, picked: Record<string, string>, name: string, value: string, names: readonly string[]) =>
  v.options[name] === value && names.every((n) => n === name || picked[n] === undefined || v.options[n] === picked[n]);

export function valueState(variants: readonly OptionVariant[], names: readonly string[], picked: Record<string, string>, name: string, value: string): ValueState {
  const matching = variants.filter((v) => matchesOthers(v, picked, name, value, names));
  if (!matching.length) return 'none';
  return matching.some((v) => v.inStock) ? 'in_stock' : 'sold_out';
}

/** The variant the picks name exactly, or null. */
export function variantFor<T extends OptionVariant>(variants: readonly T[], names: readonly string[], picked: Record<string, string>): T | null {
  return variants.find((v) => names.every((n) => v.options[n] === picked[n])) ?? null;
}

/**
 * The picks after tapping `value` of `name`: kept as they are when that combination exists, otherwise the options of
 * a variant with this value (an in-stock one first), so the page always names a real variant.
 */
export function pickValue(variants: readonly OptionVariant[], names: readonly string[], picked: Record<string, string>, name: string, value: string): Record<string, string> {
  const next = { ...picked, [name]: value };
  if (variantFor(variants, names, next)) return next;
  const withValue = variants.filter((v) => v.options[name] === value);
  const best = withValue.find((v) => v.inStock && matchesOthers(v, picked, name, value, names)) ?? withValue.find((v) => v.inStock) ?? withValue[0];
  return best ? { ...best.options } : next;
}

/** The most of this variant one cart line can hold: the stock left (null = no limit), at most LINE_MAX, never below 0. */
export function qtyCap(available: number | null | undefined): number {
  if (available === null || available === undefined) return LINE_MAX;
  return Math.max(0, Math.min(LINE_MAX, Math.floor(available)));
}

/** A wanted quantity kept between 1 and the cap (0 when nothing is left). */
export function clampQty(qty: number, available: number | null | undefined): number {
  const cap = qtyCap(available);
  return cap === 0 ? 0 : Math.min(cap, Math.max(1, Math.floor(qty)));
}
