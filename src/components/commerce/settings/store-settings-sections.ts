// The store settings sections, in side-list order, grouped by meaning. The selected one lives in the URL (?section=).

export const STORE_SECTION_GROUPS = [
  { id: "store", sections: ["general", "taxes"] },
  { id: "selling", sections: ["checkout", "shipping", "discounts"] },
  { id: "customers", sections: ["buyers", "notifications", "marketing"] },
  { id: "other", sections: ["advanced"] },
] as const;

export type StoreSection = (typeof STORE_SECTION_GROUPS)[number]["sections"][number];
export const STORE_SECTIONS: readonly StoreSection[] = STORE_SECTION_GROUPS.flatMap((g) => g.sections);
export const DEFAULT_STORE_SECTION: StoreSection = "general";

/** The section a ?section= value names, or null for none or an unknown value (phones then show the list). */
export function resolveStoreSection(value: string | null | undefined): StoreSection | null {
  return STORE_SECTIONS.includes(value as StoreSection) ? (value as StoreSection) : null;
}

/** The URL that selects a section on this page; null clears it. Other query parameters are kept. */
export function storeSectionHref(pathname: string, current: string, section: StoreSection | null): string {
  const params = new URLSearchParams(current);
  if (section) params.set("section", section); else params.delete("section");
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}
