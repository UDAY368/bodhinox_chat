/**
 * Contact pickers (deal form, new order, counter sale): search the workspace's contacts by name or phone, a bounded page at a time.
 * Runs through the browser data API, so the query is tenant-scoped in SQL and a member whose
 * numbers are masked can match a number only by its last digits (src/lib/repositories/query.ts).
 * The contacts page has its own wider search (search-term.ts).
 */

import { createClient } from '@/lib/data/client';

export interface ContactOption {
  id: string;
  name: string | null;
  phone: string | null;
}

export const CONTACT_SEARCH_LIMIT = 20;

/**
 * The OR filter for a typed search: name contains the text, or the phone contains its digits
 * ("+91 98765" finds 919876543210). Characters that would break the filter or act as wildcards are
 * dropped. Null when nothing searchable is left.
 */
export function pickerSearchFilter(raw: string): string | null {
  const term = raw.trim().replace(/[%_,()\\*]/g, '').slice(0, 80);
  if (!term) return null;
  const digits = term.replace(/\D/g, '');
  const parts = [`name.ilike.%${term}%`];
  if (digits) parts.push(`phone.ilike.%${digits}%`);
  return parts.join(',');
}

/** Up to `limit` contacts matching the search (all contacts by name when it is empty). */
export async function searchContacts(raw: string, limit = CONTACT_SEARCH_LIMIT): Promise<ContactOption[]> {
  let query = createClient().from('contacts').select('id,name,phone').order('name').limit(Math.min(Math.max(limit, 1), 50));
  const filter = pickerSearchFilter(raw);
  if (filter) query = query.or(filter);
  const { data, error } = await query;
  if (error) throw new Error('contact search failed');
  return (data ?? []) as ContactOption[];
}
