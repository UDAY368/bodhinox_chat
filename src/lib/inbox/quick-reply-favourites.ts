// Favourite quick replies are per member. Pure helpers shared by the picker
// and the API; persistence lives in saved-filters-store.ts.

/**
 * Puts the member's favourites first, keeping the incoming order within each
 * group (the list arrives newest first). Returns a new array.
 */
export function sortFavouritesFirst<T extends { id: string }>(
  items: readonly T[],
  favourites: ReadonlySet<string> | readonly string[]
): T[] {
  const set = favourites instanceof Set ? favourites : new Set(favourites as readonly string[]);
  if (set.size === 0) return [...items];
  return [
    ...items.filter((item) => set.has(item.id)),
    ...items.filter((item) => !set.has(item.id)),
  ];
}
