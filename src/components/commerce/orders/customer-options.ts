/**
 * The customer picker's options: the latest search results, with the chosen customer kept at the top when a
 * new search no longer returns them (otherwise the select would look empty while a customer is still chosen).
 */
export function withChosenOption<T extends { id: string }>(options: readonly T[], chosen: T | null): T[] {
  if (!chosen || options.some((o) => o.id === chosen.id)) return [...options];
  return [chosen, ...options];
}
