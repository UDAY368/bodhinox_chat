// Placeholders in flow text (Stage 5). Pure and client-safe (no server
// imports), so the engine, the dry run and the builder's preview fill text
// the same way.
//
//   {{workspace.key}}             a non-secret workspace value (filled first)
//   {{vars.key}}                  a run variable (an answer or an API value)
//   {{contact.name|email|phone|company|username}}
//                                 the contact's stored field (username: the
//                                 Instagram username of this conversation)
//   {{custom.<custom field id>}}  the contact's custom field value
//   {{vars.key|fallback}}         any of the three above with a fallback for
//                                 a missing or empty value (fallback ≤ 100
//                                 characters, no braces or pipe)
//
// One pass over the text: a value that itself looks like a placeholder is
// never expanded again, so captured customer input cannot pull in workspace
// values, other variables or contact data. Workspace values are expanded
// first, as before Stage 5 (an admin wrote them).
/** {{workspace.key}}, exactly as lib/workspace/attributes.ts fillWorkspace (server-only there): unknown keys render empty. */
function fillWorkspace(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{\s*workspace\.([a-z][a-z0-9_]*)\s*\}\}/g, (_, key: string) => (Object.hasOwn(values, key) ? values[key] : ""));
}

export const CONTACT_PLACEHOLDER_FIELDS = ["name", "email", "phone", "company", "username"] as const;
export type ContactPlaceholderField = (typeof CONTACT_PLACEHOLDER_FIELDS)[number];

/** The contact values a text may use; absent keys render as empty (or their fallback). */
export interface PlaceholderContact {
  fields?: Partial<Record<ContactPlaceholderField, string | null>>;
  /** Custom field values by custom field id. */
  custom?: Readonly<Record<string, string | null | undefined>>;
}

// Written exactly as before Stage 5 for {{vars.x}} (no spaces), so existing text renders byte for byte the same.
const PLACEHOLDER = /\{\{(?:(vars)\.([a-zA-Z0-9_]+)|(contact)\.([a-z]+)|(custom)\.([0-9a-fA-F-]{36}))(?:\|([^{}|]{0,100}))?\}\}/g;
const CONTACT_OR_CUSTOM = /\{\{(?:contact|custom)\./;

/** Whether a text uses contact or custom field placeholders (so the contact must be loaded). */
export function usesContactPlaceholders(text: string): boolean {
  return CONTACT_OR_CUSTOM.test(text);
}

/** Custom field ids a text refers to. */
export function customPlaceholderIds(text: string): string[] {
  const ids = new Set<string>();
  for (const m of text.matchAll(PLACEHOLDER)) if (m[5] === "custom") ids.add(m[6].toLowerCase());
  return [...ids];
}

/**
 * Fills a text: workspace values first, then one pass over vars, contact and
 * custom placeholders. A missing value renders as its fallback, else empty
 * (the behaviour before Stage 5 for {{vars.x}}).
 */
export function fillPlaceholders(
  template: string,
  vars: Readonly<Record<string, unknown>>,
  workspace: Record<string, string> = {},
  contact: PlaceholderContact = {},
): string {
  if (!template) return "";
  return fillWorkspace(template, workspace).replace(PLACEHOLDER, (...m: Array<string | undefined>) => {
    const fallback = m[7];
    let value: unknown;
    if (m[1]) value = Object.hasOwn(vars, m[2]!) ? vars[m[2]!] : undefined;
    else if (m[3]) {
      if (!(CONTACT_PLACEHOLDER_FIELDS as readonly string[]).includes(m[4]!)) return fallback?.trim() ?? "";
      value = contact.fields?.[m[4] as ContactPlaceholderField];
    } else {
      const id = m[6]!.toLowerCase();
      value = contact.custom && Object.hasOwn(contact.custom, id) ? contact.custom[id] : undefined;
    }
    const text = value === undefined || value === null ? "" : String(value);
    return text === "" && fallback !== undefined ? fallback.trim() : text;
  });
}
