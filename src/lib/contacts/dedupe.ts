import type { DataClient } from "@/lib/data/types";
import {
  normalizePhone,
  parseInternationalPhone,
  phonesMatch,
  phoneVariants,
} from "@/lib/whatsapp/phone-utils";

/**
 * Contact de-duplication helpers, shared by the WhatsApp webhook, the
 * manual contact form, and CSV import so all paths agree on what
 * "same number" means (issue #212).
 *
 * The canonical key is `normalizePhone` (digits-only) — the same form
 * the DB stores in the generated `contacts.phone_normalized` column
 * and enforces unique per account. `phonesMatch` adds trunk-prefix
 * tolerance (last-8-digit match) for the softer "possible duplicate"
 * surfaces.
 */

/** Canonical de-dup key for a phone string (digits only). */
export function normalizeKey(phone: string): string {
  return normalizePhone(phone);
}

/** Minimal shape we need back from a contacts lookup. */
export interface ExistingContact {
  id: string;
  phone: string;
  name?: string | null;
  [key: string]: unknown;
}

/**
 * Find an existing contact in `accountId` whose phone matches `phone`,
 * or null. Query only normalized identity/trunk variants, then prefer
 * the exact identity before tolerating a variant from that small set.
 */
export async function findExistingContact(
  db: DataClient,
  accountId: string,
  phone: string,
): Promise<ExistingContact | null> {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;

  const { data, error } = await db
    .from("contacts")
    .select("*")
    .eq("account_id", accountId)
    .in("phone_normalized", phoneVariants(normalized));

  if (error || !data) return null;

  return pickBestPhoneMatch(data as ExistingContact[], phone);
}

/** Exact normalized identity wins; only explicit trunk variants are tolerated. */
export function pickBestPhoneMatch<T extends { phone: string }>(candidates: T[], phone: string): T | null {
  const key = normalizeKey(phone);
  if (!key) return null;
  const variants = new Set(phoneVariants(key));
  return candidates.find(c => normalizeKey(c.phone) === key)
    ?? candidates.find(c => variants.has(normalizeKey(c.phone)) && phonesMatch(c.phone, phone))
    ?? null;
}

/**
 * True when an existing contact is an *exact* normalized match for
 * `phone` (vs only a fuzzy trunk-variant match). The form hard-blocks
 * exact matches but only warns on fuzzy ones.
 */
export function isExactMatch(existing: ExistingContact, phone: string): boolean {
  return normalizeKey(existing.phone) === normalizeKey(phone);
}

/**
 * True for a Postgres unique-constraint violation (SQLSTATE 23505).
 * Used as the backstop when the DB unique index rejects a racing or
 * format-equal insert that slipped past the in-app check.
 */
export function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return (error as { code?: string }).code === "23505";
}

/**
 * De-duplicate parsed CSV rows by normalized phone, keeping the first
 * occurrence of each. Rows whose phone is not a usable international
 * number are dropped too, but counted separately as `invalid` rather
 * than folded into `duplicates` — they never duplicated anything, and
 * the import result should say so instead of telling the user a
 * contact with a real, unique number was skipped as a dupe.
 *
 * "Usable" means `parseInternationalPhone` accepts it: a leading `+`
 * and country code are required. A CSV of national-format numbers
 * ("4155551212") is the bulk version of issue #586 — every row would
 * be stored and later delivered to the wrong country — so those rows
 * are reported as invalid here, before anything is written.
 */
export function dedupeByPhone<T extends { phone: string }>(
  rows: T[],
): { unique: T[]; duplicates: number; invalid: number } {
  const seen = new Set<string>();
  const unique: T[] = [];
  let duplicates = 0;
  let invalid = 0;

  for (const row of rows) {
    const key = parseInternationalPhone(row.phone);
    if (!key) {
      invalid++;
      continue;
    }
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    unique.push(row);
  }

  return { unique, duplicates, invalid };
}
