/**
 * CSV → broadcast audience.
 *
 * The broadcast wizard's "Upload CSV" audience type needs a
 * `{ phone, name }[]` list, which is a narrower shape than the
 * contacts importer's. Rather than re-parse, this reuses the shared
 * `parseContactCsv` + `dedupeByPhone` so a CSV that imports cleanly on
 * the Contacts page also broadcasts cleanly (issue #512).
 *
 * De-duplication happens HERE, on the normalized number, because the
 * downstream contact upsert inserts against a UNIQUE index on
 * (account_id, phone_normalized) (migration 022). Two spellings of the
 * same number in one file ("+1 555-0100" and "15550100") would
 * otherwise reach that index as separate inserts and fail the whole
 * broadcast with a constraint error.
 *
 * Pure and unit-tested: the wizard is a client component and
 * `vitest.config.ts` runs `environment: "node"` with no jsdom, so the
 * logic has to live outside the component to be testable.
 */

import { dedupeByPhone } from '@/lib/contacts/dedupe';
import { parseContactCsv } from '@/lib/contacts/parse-contact-csv';
import { parseInternationalPhone } from '@/lib/whatsapp/phone-utils';

/** The shape the wizard hands to `createAndSendBroadcast`. */
export interface BroadcastCsvContact {
  phone: string;
  name?: string;
  /** Other columns by lower-cased header (only with `withValues`), for CSV-column variables. */
  values?: Record<string, string>;
}

/** Most columns a campaign CSV may carry into template variables (matches the server cap). */
export const MAX_CSV_VALUE_COLUMNS = 20;

export type BroadcastCsvError =
  /** No `phone` header — the one column we can't work without. */
  | 'missing_phone_column'
  /** Header was fine, but not one row carried a usable number. */
  | 'no_valid_rows';

export type ParseBroadcastCsvResult =
  | {
      ok: true;
      contacts: BroadcastCsvContact[];
      /** Rows dropped as same-number repeats. */
      duplicates: number;
      /**
       * Rows dropped because the number is blank or lacks a leading `+`
       * and country code (issue #586). The wizard warns about these so
       * a CSV of national-format numbers doesn't silently shrink.
       */
      invalid: number;
    }
  | { ok: false; error: BroadcastCsvError };

/**
 * `withValues` keeps every other column (as `values`) for CSV-column
 * template variables; `keepDuplicates` keeps repeated numbers as their
 * own rows (the server then sends once per row). Both default off.
 */
export function parseBroadcastCsv(
  text: string,
  options: { withValues?: boolean; keepDuplicates?: boolean } = {},
): ParseBroadcastCsvResult {
  const { rows, hasPhoneColumn, phoneColumn } = parseContactCsv(text);

  if (!hasPhoneColumn) return { ok: false, error: 'missing_phone_column' };

  const { unique, duplicates, invalid } = dedupeByPhone(rows);
  if (unique.length === 0) return { ok: false, error: 'no_valid_rows' };
  // Same validity rule as dedupe, without collapsing repeats.
  const kept = options.keepDuplicates ? rows.filter((row) => parseInternationalPhone(row.phone)) : unique;

  return {
    ok: true,
    // Without `withValues`, drop email/company/tags: `name` is then the
    // only CSV value template variables can use.
    contacts: kept.map(({ phone, name, cells }) => {
      const contact: BroadcastCsvContact = name ? { phone, name } : { phone };
      if (options.withValues) {
        // Headers longer than the server's 64-character key limit cannot be variables.
        contact.values = Object.fromEntries(
          Object.entries(cells).filter(([header]) => header !== phoneColumn && header.length <= 64).slice(0, MAX_CSV_VALUE_COLUMNS),
        );
      }
      return contact;
    }),
    duplicates: options.keepDuplicates ? 0 : duplicates,
    invalid,
  };
}

/** Column names usable as CSV-column variables, from the first parsed row. */
export function csvValueColumns(contacts: BroadcastCsvContact[]): string[] {
  return Object.keys(contacts[0]?.values ?? {});
}
