// Pure helpers shared by contact search and global search: the typed term as
// SQL patterns, and the keyset cursor. No database access here.
import { AudienceFilterError } from '@/lib/audience/filter';

/** Longest search term accepted (longer is a 400). */
export const MAX_QUERY_LENGTH = 100;

/** The digits of a term, for matching phone numbers whatever their spacing or prefix. */
export function searchDigits(term: string): string {
  return term.replace(/\D/g, '');
}

/** A term that is only a phone number: digits with optional + ( ) . - and spaces. */
export function isPhoneTerm(term: string): boolean {
  return /^\+?[\d\s().-]+$/.test(term.trim()) && searchDigits(term).length > 0;
}

/** `%term%` for ILIKE, with the LIKE wildcards in the term matched literally. */
export function containsPattern(term: string): string {
  return `%${term.trim().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/** The term as typed for an order reference ("#1042" and "1042" both match), lower-cased. */
export function referenceTerm(term: string): string {
  return term.trim().replace(/^#/, '').toLowerCase();
}

/** The trimmed q parameter; over MAX_QUERY_LENGTH is a 400. */
export function parseQuery(raw: string | null): string {
  const q = (raw ?? '').trim();
  if (q.length > MAX_QUERY_LENGTH) throw new AudienceFilterError('Search is too long');
  return q;
}

/** A positive integer limit capped at `max`; absent means `fallback`; anything else is a 400. */
export function parseLimit(raw: string | null | undefined, fallback: number, max: number): number {
  if (raw === null || raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new AudienceFilterError('Invalid limit');
  return Math.min(n, max);
}

/** Position after the last row of a page: its creation time (microsecond text, or null) and id. */
export interface SearchCursor {
  at: string | null;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export function encodeCursor(cursor: SearchCursor): string {
  return Buffer.from(JSON.stringify([cursor.at, cursor.id]), 'utf8').toString('base64url');
}

/** The cursor a page handed out; anything else is a 400. */
export function decodeCursor(raw: string): SearchCursor {
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(value) && value.length === 2) {
      const [at, id] = value as unknown[];
      if ((at === null || (typeof at === 'string' && TIMESTAMP.test(at))) && typeof id === 'string' && UUID.test(id))
        return { at, id: id.toLowerCase() };
    }
  } catch {
    // fall through
  }
  throw new AudienceFilterError('Invalid cursor');
}
