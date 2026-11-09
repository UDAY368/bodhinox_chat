/**
 * The contacts page's free-text search as a filter `or` expression over name,
 * phone and email. The filter grammar splits on commas and brackets and has
 * no quoting, so those characters become `_` (ILIKE's any-one-character
 * wildcard): 'Sharma, Raj' and 'Acme (Pune' still match what was typed,
 * instead of failing the whole query.
 */
export function contactSearchFilter(term: string): string {
  const like = `%${term.trim().replace(/[,()]/g, '_')}%`;
  return `name.ilike.${like},phone.ilike.${like},email.ilike.${like}`;
}
