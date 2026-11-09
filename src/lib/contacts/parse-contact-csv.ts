/**
 * CSV parsing for the contacts import modal and campaign CSV audiences.
 * Shared + unit-tested so tag-column handling stays aligned with
 * phone/name/email/company.
 */

export interface ParsedContactRow {
  phone: string;
  name?: string;
  email?: string;
  company?: string;
  /** Tag names from the optional `tags` column (comma/semicolon separated). */
  tagNames: string[];
  /** Every cell by lower-cased header, for campaign variable mapping. */
  cells: Record<string, string>;
}

/** Split a CSV cell into unique tag names (case-insensitive de-dupe). */
export function parseTagCell(value: string | undefined): string[] {
  if (!value?.trim()) return [];

  const seen = new Set<string>();
  const names: string[] = [];

  for (const part of value.split(/[,;]/)) {
    const name = part.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }

  return names;
}

export interface ParseContactCsvResult {
  rows: ParsedContactRow[];
  /**
   * True when the CSV header includes a phone column (any alias in
   * HEADER_ALIASES.phone). `rows` is empty both when the column is missing
   * and when the file simply has no usable data rows; callers that need to
   * tell those apart (to pick the right error message) read this flag.
   */
  hasPhoneColumn: boolean;
  /** True when the CSV header includes a tags column. */
  hasTagsColumn: boolean;
  /** True when the CSV header includes a company column. */
  hasCompanyColumn: boolean;
  /** The lower-cased header used as the phone column ('' when none). */
  phoneColumn: string;
}

/**
 * Header names accepted for each field, compared after lower-casing and
 * dropping everything but letters and digits ('Phone Number', 'phone_number'
 * and 'PhoneNumber' are the same). First match in this order wins.
 */
export const HEADER_ALIASES = {
  phone: ['phone', 'phonenumber', 'phoneno', 'mobile', 'mobilenumber', 'mobileno', 'mobilephone', 'whatsapp', 'whatsappnumber',
    'whatsappno', 'cell', 'cellphone', 'cellnumber', 'contactnumber', 'contactno', 'telephone', 'tel', 'msisdn', 'number'],
  name: ['name', 'fullname', 'contactname', 'customername', 'customer', 'displayname'],
  firstName: ['firstname', 'givenname'],
  lastName: ['lastname', 'surname', 'familyname'],
  email: ['email', 'emailaddress', 'mail', 'emailid'],
  company: ['company', 'companyname', 'organization', 'organisation', 'business', 'businessname'],
  tags: ['tags', 'tag', 'labels', 'label'],
} as const;

const headerKey = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, '');

function findColumn(keys: string[], aliases: readonly string[]): number {
  for (const alias of aliases) {
    const index = keys.indexOf(alias);
    if (index >= 0) return index;
  }
  return -1;
}

/**
 * Our own export (and other tools) prefix a cell that starts with a formula
 * character with an apostrophe; drop that one apostrophe on the way back in.
 * Any other apostrophe ("O'Brien") is kept.
 */
const unguard = (value: string) => value.replace(/^'(?=[=+\-@])/, '');

const EMPTY: ParseContactCsvResult = {
  rows: [],
  hasPhoneColumn: false,
  hasTagsColumn: false,
  hasCompanyColumn: false,
  phoneColumn: '',
};

export function parseContactCsv(text: string): ParseContactCsvResult {
  const records = parseCsv(text.replace(/^﻿/, ''));
  if (records.length < 2) return EMPTY;

  const headers = records[0].map((h) => h.trim().toLowerCase());
  const keys = headers.map(headerKey);

  const phoneIdx = findColumn(keys, HEADER_ALIASES.phone);
  if (phoneIdx === -1) return EMPTY;

  const nameIdx = findColumn(keys, HEADER_ALIASES.name);
  const firstIdx = findColumn(keys, HEADER_ALIASES.firstName);
  const lastIdx = findColumn(keys, HEADER_ALIASES.lastName);
  const emailIdx = findColumn(keys, HEADER_ALIASES.email);
  const companyIdx = findColumn(keys, HEADER_ALIASES.company);
  const tagsIdx = findColumn(keys, HEADER_ALIASES.tags);

  const cell = (values: string[], idx: number) => (idx >= 0 ? unguard(values[idx]?.trim() ?? '') || undefined : undefined);
  const rows: ParsedContactRow[] = [];

  for (let i = 1; i < records.length; i++) {
    const values = records[i];

    // A row with no usable phone is pushed through rather than dropped
    // here — dedupeByPhone (shared with the webhook/manual-form paths)
    // already treats an empty normalized key as invalid, and counting
    // it there means the import result can tell the user "N contacts
    // had no phone" instead of the row just vanishing with the total
    // row count silently short of what's actually in the file.
    // Spreadsheets prefix numbers with an apostrophe to keep them as text.
    const phone = (values[phoneIdx] ?? '').replace(/["']/g, '').trim();
    const split = [cell(values, firstIdx), cell(values, lastIdx)].filter(Boolean).join(' ');

    rows.push({
      phone,
      name: cell(values, nameIdx) ?? (split || undefined),
      email: cell(values, emailIdx),
      company: cell(values, companyIdx),
      tagNames: parseTagCell(cell(values, tagsIdx)),
      cells: Object.fromEntries(
        headers.flatMap((header, idx) => (header ? [[header, values[idx]?.trim() ?? '']] : [])),
      ),
    });
  }

  return {
    rows,
    hasPhoneColumn: true,
    hasTagsColumn: tagsIdx >= 0,
    hasCompanyColumn: companyIdx >= 0,
    phoneColumn: headers[phoneIdx],
  };
}

/**
 * RFC 4180 parse of the whole file: quoted cells may hold the delimiter, a
 * doubled quote ("") and line breaks. The delimiter is ';' when the header
 * line has semicolons and no commas (spreadsheets in comma-decimal locales).
 */
export function parseCsv(text: string): string[][] {
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const delimiter = !firstLine.includes(',') && firstLine.includes(';') ? ';' : ',';
  const records: string[][] = [];
  let record: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"' && text[i + 1] === '"') {
        current += '"';
        i++;
      } else if (char === '"') inQuotes = false;
      else current += char;
    } else if (char === '"') inQuotes = true;
    else if (char === delimiter) {
      record.push(current.trim());
      current = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      record.push(current.trim());
      records.push(record);
      record = [];
      current = '';
    } else current += char;
  }
  record.push(current.trim());
  records.push(record);

  return records.filter((r) => r.some((value) => value !== ''));
}
