import type { Tag } from '@/types';

/** Tags grouped by category (A–Z), uncategorised last as `category: null`; order within a group is kept. */
export function groupTagsByCategory(tags: Tag[]): { category: string | null; tags: Tag[] }[] {
  const groups = new Map<string | null, Tag[]>();
  for (const tag of tags) {
    const key = tag.category?.trim() || null;
    groups.set(key, [...(groups.get(key) ?? []), tag]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)))
    .map(([category, list]) => ({ category, tags: list }));
}
