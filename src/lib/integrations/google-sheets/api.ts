// Stage 5 (5G): Google Sheets HTTP calls. Every request goes to the fixed hosts
// in config.ts (never a URL from input), with a timeout. The request builders
// are pure so they can be tested without a network. Nothing here logs a cell
// value, a token or a spreadsheet id.

import { GOOGLE_SHEETS_HOSTS } from './config';

export const SHEETS_TIMEOUT_MS = 10_000;
/** Rows read when looking a value up (header row included). */
export const SHEETS_LOOKUP_ROWS = 2_000;

/** Google answered with an HTTP error: `status` says whether it was a refusal (4xx) or a server fault. */
export class SheetsHttpError extends Error {
  constructor(readonly status: number, readonly reason: string | null = null) {
    super(`Google Sheets request failed (${status})`);
    this.name = 'SheetsHttpError';
  }
}

export const SPREADSHEET_ID = /^[A-Za-z0-9_-]{20,100}$/;
/** Google's sheet name rules: 1-100 characters, none of [ ] * ? / \ : */
export const SHEET_NAME = /^[^[\]*?/\\:]{1,100}$/;
/** A column letter (A … ZZ). Anything else names a header cell in row 1. */
export const COLUMN_LETTER = /^[A-Z]{1,2}$/;

export function isSpreadsheetId(value: unknown): value is string {
  return typeof value === 'string' && SPREADSHEET_ID.test(value);
}

export function isSheetName(value: unknown): value is string {
  return typeof value === 'string' && SHEET_NAME.test(value) && value.trim() === value && value.length > 0;
}

/** A sheet name quoted for A1 notation ('My sheet' with quotes doubled). */
export function quoteSheet(sheet: string): string {
  return `'${sheet.replace(/'/g, "''")}'`;
}

/** Zero-based index of a column letter (A=0, Z=25, AA=26). */
export function columnIndex(letter: string): number {
  let n = 0;
  for (const ch of letter) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function columnLetter(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Resolves a column reference (letter or header text) against the header row; null when unknown. */
export function resolveColumn(column: string, header: readonly string[]): number | null {
  const ref = column.trim();
  if (COLUMN_LETTER.test(ref)) return columnIndex(ref);
  const wanted = ref.toLowerCase();
  const i = header.findIndex((h) => String(h ?? '').trim().toLowerCase() === wanted);
  return i >= 0 ? i : null;
}

/** Whether any column of the step needs the header row. */
export function needsHeader(columns: readonly string[]): boolean {
  return columns.some((c) => !COLUMN_LETTER.test(c.trim()));
}

export interface SheetsRequest {
  method: 'GET' | 'POST' | 'PUT';
  url: string;
  body?: unknown;
}

const base = (spreadsheetId: string) => `${GOOGLE_SHEETS_HOSTS.sheets}/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`;

/** Reads rows 1..`rows` of a sheet (values as displayed text). */
export function buildReadRequest(spreadsheetId: string, sheet: string, rows: number): SheetsRequest {
  const range = encodeURIComponent(`${quoteSheet(sheet)}!1:${rows}`);
  return { method: 'GET', url: `${base(spreadsheetId)}/values/${range}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE` };
}

/** Appends one row. RAW input: a value starting with "=" is stored as text, never run as a formula. */
export function buildAppendRequest(spreadsheetId: string, sheet: string, row: readonly string[]): SheetsRequest {
  const range = encodeURIComponent(`${quoteSheet(sheet)}!A1`);
  return {
    method: 'POST',
    url: `${base(spreadsheetId)}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    body: { majorDimension: 'ROWS', values: [row] },
  };
}

/** Writes cells of one row (1-based row number). RAW input. */
export function buildUpdateRequest(spreadsheetId: string, sheet: string, rowNumber: number,
  cells: ReadonlyArray<{ index: number; value: string }>): SheetsRequest {
  return {
    method: 'POST',
    url: `${base(spreadsheetId)}/values:batchUpdate`,
    body: {
      valueInputOption: 'RAW',
      data: cells.map((c) => ({ range: `${quoteSheet(sheet)}!${columnLetter(c.index)}${rowNumber}`, majorDimension: 'ROWS', values: [[c.value]] })),
    },
  };
}

/** The row array for an insert: each value under its column, blanks between. */
export function rowFor(cells: ReadonlyArray<{ index: number; value: string }>): string[] {
  const width = cells.reduce((m, c) => Math.max(m, c.index + 1), 0);
  const row = Array.from({ length: width }, () => '');
  for (const c of cells) row[c.index] = c.value;
  return row;
}

/** The 1-based number of the first data row (after the header) whose column equals `value` (trimmed, case-insensitive), or null. */
export function findRow(rows: readonly (readonly unknown[])[], index: number, value: string): number | null {
  const wanted = value.trim().toLowerCase();
  if (!wanted) return null;
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i]?.[index] ?? '').trim().toLowerCase() === wanted) return i + 1;
  }
  return null;
}

type Fetch = typeof fetch;

/** Sends one request with the access token. Throws SheetsHttpError on an HTTP error, a TypeError/AbortError on a network fault. */
export async function sheetsCall<T>(accessToken: string, request: SheetsRequest, fetcher: Fetch = fetch): Promise<T> {
  if (!request.url.startsWith(`${GOOGLE_SHEETS_HOSTS.sheets}/`)) throw new Error('Google Sheets host refused');
  const response = await fetcher(request.url, {
    method: request.method,
    headers: { Authorization: `Bearer ${accessToken}`, ...(request.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
    signal: AbortSignal.timeout(SHEETS_TIMEOUT_MS),
    redirect: 'error',
  });
  if (!response.ok) {
    const reason = await response.json().then((j: { error?: { status?: unknown } }) => (typeof j?.error?.status === 'string' ? j.error.status : null)).catch(() => null);
    throw new SheetsHttpError(response.status, reason);
  }
  return (await response.json().catch(() => ({}))) as T;
}

export interface TokenGrant {
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number;
  idToken: string | null;
  scopes: string[];
}

/** POSTs a form to Google's token endpoint (fixed host). Throws SheetsHttpError on an HTTP error. */
export async function tokenRequest(form: Record<string, string>, fetcher: Fetch = fetch): Promise<TokenGrant> {
  const response = await fetcher(`${GOOGLE_SHEETS_HOSTS.oauth}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(SHEETS_TIMEOUT_MS),
    redirect: 'error',
  });
  const json = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new SheetsHttpError(response.status, typeof json.error === 'string' ? json.error : null);
  if (typeof json.access_token !== 'string' || !json.access_token) throw new SheetsHttpError(502, 'no_access_token');
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === 'string' && json.refresh_token ? json.refresh_token : null,
    expiresInSeconds: typeof json.expires_in === 'number' && json.expires_in > 0 ? json.expires_in : 3600,
    idToken: typeof json.id_token === 'string' ? json.id_token : null,
    scopes: typeof json.scope === 'string' ? json.scope.split(/\s+/).filter(Boolean) : [],
  };
}

/** Best-effort token revocation at Google (fixed host). Never throws. */
export async function revokeToken(token: string, fetcher: Fetch = fetch): Promise<void> {
  try {
    await fetcher(`${GOOGLE_SHEETS_HOSTS.oauth}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(SHEETS_TIMEOUT_MS),
      redirect: 'error',
    });
  } catch {
    // The connection is removed here either way; the grant can also be removed in the Google account.
  }
}

/**
 * The email of an id_token received directly from Google's token endpoint over
 * TLS (OpenID Connect allows reading it without a signature check in that
 * case). Null unless it is a verified, well-formed address.
 */
export function idTokenEmail(idToken: string | null): string | null {
  if (!idToken) return null;
  const part = idToken.split('.')[1];
  if (!part) return null;
  try {
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { email?: unknown; email_verified?: unknown };
    const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
    if (claims.email_verified === false || email.length < 3 || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
    return email;
  } catch {
    return null;
  }
}
