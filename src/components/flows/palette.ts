export function filterPaletteTypes<T extends { label: string; description: string }>(items: readonly T[], query: string): T[] {
  const search = query.trim().toLocaleLowerCase()
  return items.filter(item => `${item.label} ${item.description}`.toLocaleLowerCase().includes(search))
}
