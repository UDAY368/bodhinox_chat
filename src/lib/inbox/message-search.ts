import { Prisma } from '@prisma/client';

/**
 * Message full-text search. messages_search_idx (migration
 * 20261102120500_messages_search_index) is a GIN index on exactly this
 * expression, so queries must build the vector with messageSearchVector():
 *
 *   WHERE m.account_id=${accountId}::uuid
 *     AND ${messageSearchVector('m')} @@ websearch_to_tsquery('simple', ${query})
 *
 * The 'simple' config does no stemming, so every language matches token for
 * token. Run it inside withTenant; RLS still scopes rows to the account.
 */

export const MAX_MESSAGE_SEARCH_LENGTH = 200;
const ALIAS = /^[a-z_][a-z0-9_]{0,30}$/;

/** The indexed tsvector expression for a messages table alias. */
export function messageSearchVector(alias = 'messages'): Prisma.Sql {
  if (!ALIAS.test(alias)) throw new Error('Invalid table alias');
  return Prisma.raw(`to_tsvector('simple'::regconfig, COALESCE(${alias}.content_text, ''))`);
}

/**
 * Normalise user input for websearch_to_tsquery: trims, collapses whitespace,
 * caps the length. Returns null when nothing searchable is left.
 */
export function normalizeMessageSearch(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const text = input.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE_SEARCH_LENGTH).trim();
  return /[\p{L}\p{N}]/u.test(text) ? text : null;
}
