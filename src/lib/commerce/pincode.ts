/** An Indian pincode: six digits, never starting with 0. Pure, so the product page and the server share it. */
const PINCODE = /^[1-9][0-9]{5}$/;

export function parsePincode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const digits = value.replace(/\s/g, '');
  return PINCODE.test(digits) ? digits : null;
}

/**
 * True when some rate is zoned by state alone (states, no postal prefixes): a pincode cannot say whether it matches, so
 * "no rate matched" must read "confirmed at checkout", not "we don't deliver here".
 */
export function hasStateOnlyRate(rates: ReadonlyArray<{ country: string; postalPrefixes: readonly string[]; states?: readonly string[] }>): boolean {
  return rates.some((r) => r.country === 'IN' && r.postalPrefixes.length === 0 && (r.states?.length ?? 0) > 0);
}
