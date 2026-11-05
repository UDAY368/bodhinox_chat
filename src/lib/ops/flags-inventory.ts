/**
 * Feature-flag inventory check (Phase 15). Every `*_ENABLED`, `*_DISABLED` or `*_DRY_RUN` environment
 * flag the application reads must be listed in docs/release/feature-flags.md, so a new kill switch or
 * gate cannot ship without its default, production value and owner being written down.
 */
export const FLAG_PATTERN = /(?:process\.)?env\.([A-Z0-9_]+_(?:ENABLED|DISABLED|DRY_RUN))\b/g;
export const FLAGS_INVENTORY_DOC = 'docs/release/feature-flags.md';

export function flagsInSource(source: string): string[] {
  return [...new Set([...source.matchAll(FLAG_PATTERN)].map((match) => match[1]))].sort();
}

/** Flags absent from the inventory document (matched as a whole `NAME` in backticks). */
export function flagsMissingFromInventory(flags: Iterable<string>, inventory: string): string[] {
  return [...new Set(flags)].filter((flag) => !inventory.includes(`\`${flag}\``)).sort();
}

/** Production source files only: tests may set flags that the application never reads. */
export function isInventoriedSource(file: string): boolean {
  const normalized = file.replace(/\\/g, '/');
  return /\.(ts|tsx)$/.test(normalized) && !/\.(test|spec)\.tsx?$/.test(normalized) && !normalized.includes('/test/');
}
