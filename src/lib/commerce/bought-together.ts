/**
 * "Often bought together" ranking (store plan Phase 3). The database returns
 * product ids already ranked by shared real sales; this keeps that order for
 * the products that can be shown (published and priced, with a variant in
 * stock) and caps the list.
 */
export const SUGGESTION_LIMIT = 4;

export function pickSuggestions<T extends { id: string; variants: Array<{ inStock: boolean }> }>(rankedIds: string[], products: T[], limit = SUGGESTION_LIMIT): T[] {
  const byId = new Map(products.map((p) => [p.id, p]));
  const out: T[] = [];
  for (const id of rankedIds) {
    const p = byId.get(id);
    if (p && p.variants.some((v) => v.inStock) && !out.includes(p)) out.push(p);
    if (out.length === limit) break;
  }
  return out;
}
