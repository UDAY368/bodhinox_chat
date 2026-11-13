// CSV import, step 2 (Contacts redesign): each column of the file is matched
// to a contact field, a custom field or nothing. The guess follows the header
// names the import always accepted (HEADER_ALIASES) and custom field names;
// the person importing can change every match before importing. Pure: shared
// by the import modal and its tests.
import { HEADER_ALIASES, parseCsv, parseTagCell, type ParsedContactRow } from './parse-contact-csv';

export const IMPORT_TARGETS = ['phone', 'name', 'firstName', 'lastName', 'email', 'company', 'city', 'tags', 'optedOut', 'blocked'] as const;
export type ImportFieldTarget = (typeof IMPORT_TARGETS)[number];
/** '' skips the column; `cf:<id>` saves it to that custom field. */
export type ImportTarget = '' | ImportFieldTarget | `cf:${string}`;

export interface CsvTable {
  headers: string[];
  rows: string[][];
}

const headerKey = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, '');
/** Drop the apostrophe our export puts before a formula-like cell. */
const unguard = (value: string) => value.replace(/^'(?=[=+\-@])/, '');

/** The file as a header row and data rows (blank lines dropped); null without a header and one data row. */
export function readCsvTable(text: string): CsvTable | null {
  const records = parseCsv(text.replace(/^﻿/, '')).filter((r) => r.some((cell) => cell.trim()));
  if (records.length < 2) return null;
  return { headers: records[0].map((h) => h.trim()), rows: records.slice(1) };
}

/** The first guess for each column: a contact field by its usual names, else a custom field of the same name, else nothing. Each target once. */
export function guessImportTargets(headers: string[], customFields: { id: string; field_name: string }[]): ImportTarget[] {
  const used = new Set<string>();
  return headers.map((header) => {
    const key = headerKey(header);
    if (!key) return '';
    const field = IMPORT_TARGETS.find((target) => !used.has(target) && (HEADER_ALIASES[target] as readonly string[]).includes(key));
    const custom = field ? null : customFields.find((f) => !used.has(`cf:${f.id}`) && headerKey(f.field_name) === key);
    const target: ImportTarget = field ?? (custom ? `cf:${custom.id}` : '');
    if (target) used.add(target);
    return target;
  });
}

export type MappingProblem = 'no_phone' | 'duplicate';

/** A matching the import can run: a phone column, and no field chosen twice. */
export function mappingProblem(targets: ImportTarget[]): MappingProblem | null {
  if (!targets.includes('phone')) return 'no_phone';
  const chosen = targets.filter(Boolean);
  return new Set(chosen).size === chosen.length ? null : 'duplicate';
}

/** The rows as the import sends them, read through the matching. */
export function rowsFromMapping(table: CsvTable, targets: ImportTarget[]): ParsedContactRow[] {
  const index = (target: ImportTarget) => targets.indexOf(target);
  const at = (values: string[], i: number) => (i >= 0 ? unguard(values[i]?.trim() ?? '') || undefined : undefined);
  const custom = targets.flatMap((t, i) => (t.startsWith('cf:') ? [{ id: t.slice(3), i }] : []));
  const phoneI = index('phone');
  return table.rows.map((values) => {
    const split = [at(values, index('firstName')), at(values, index('lastName'))].filter(Boolean).join(' ');
    const customValues: Record<string, string> = {};
    for (const { id, i } of custom) {
      const value = at(values, i);
      if (value) customValues[id] = value;
    }
    return {
      // Spreadsheets prefix numbers with an apostrophe to keep them as text.
      phone: (values[phoneI] ?? '').replace(/["']/g, '').trim(),
      name: at(values, index('name')) ?? (split || undefined),
      email: at(values, index('email')),
      company: at(values, index('company')),
      city: at(values, index('city')),
      tagNames: parseTagCell(at(values, index('tags'))),
      optedOut: at(values, index('optedOut')),
      blocked: at(values, index('blocked')),
      customValues,
      cells: Object.fromEntries(table.headers.flatMap((header, i) => (header ? [[header.toLowerCase(), values[i]?.trim() ?? '']] : []))),
    };
  });
}
