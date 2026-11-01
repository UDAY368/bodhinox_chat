import type { DataClient } from '@/lib/data/types';

import { fetchAllInChunks, fetchAllPages } from '@/lib/data/paged-query';
import type { PageResult } from '@/lib/data/paged-query';
import type { Contact } from '@/types';
import { marketingSuppression } from '@/lib/contacts/consent';

export type CustomFieldOperator = 'is' | 'is_not' | 'contains';

export interface CustomFieldFilter {
  fieldId: string;
  operator: CustomFieldOperator;
  value: string;
}

export type AudienceType = 'all' | 'tags' | 'custom_field' | 'csv';

export interface CsvAudienceRow {
  phone: string;
  name?: string;
}

export interface AudienceConfig {
  type: AudienceType;
  tagIds?: string[];
  customField?: CustomFieldFilter;
  csvContacts?: CsvAudienceRow[];
  excludeTagIds?: string[];
}

/** Optional conservative scan bound for scheduled work; never silently truncate. */
function rowBudget(maxRows?: number) {
  let seen = 0;
  return async <T>(
    result: PromiseLike<PageResult<T>>
  ): Promise<PageResult<T>> => {
    const page = await result;
    seen += page.data?.length ?? 0;
    if (maxRows !== undefined && seen > maxRows)
      throw new Error(
        `Scheduled audience exceeds the ${maxRows}-row limit; use a narrower recipient filter`
      );
    return page;
  };
}

async function withContext<T>(
  label: string,
  run: () => Promise<T>
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to fetch ${label}: ${message}`);
  }
}

export function fetchTaggedContactIds(
  db: DataClient,
  tagIds: readonly string[],
  maxRows?: number
): Promise<Set<string>> {
  return withContext('contact tags', async () => {
    const bounded = rowBudget(maxRows);
    const rows = await fetchAllInChunks<{ contact_id: string }, string>(
      tagIds,
      (slice, from, to) =>
        bounded(
          db
            .from('contact_tags')
            .select('contact_id')
            .in('tag_id', slice)
            .order('id')
            .range(from, to)
        )
    );
    return new Set(rows.map((row) => row.contact_id));
  });
}

export function fetchCustomFieldContactIds(
  db: DataClient,
  filter: CustomFieldFilter,
  maxRows?: number
): Promise<Set<string>> {
  return withContext('custom field matches', async () => {
    const bounded = rowBudget(maxRows);
    const { fieldId, operator, value } = filter;
    const rows = await fetchAllPages<{ contact_id: string }>((from, to) => {
      let query = db
        .from('contact_custom_values')
        .select('contact_id')
        .eq('custom_field_id', fieldId);
      if (operator === 'is') query = query.eq('value', value);
      else if (operator === 'is_not') query = query.neq('value', value);
      else query = query.ilike('value', `%${value}%`);
      return bounded(query.order('id').range(from, to));
    });
    return new Set(rows.map((row) => row.contact_id));
  });
}

export function fetchContactsByIds(
  db: DataClient,
  ids: readonly string[],
  maxRows?: number
): Promise<Contact[]> {
  const bounded = rowBudget(maxRows);
  return withContext('contacts', () =>
    fetchAllInChunks<Contact, string>(ids, (slice, from, to) =>
      bounded(
        db
          .from('contacts')
          .select('*')
          .in('id', slice)
          .order('id')
          .range(from, to)
      )
    )
  );
}

export function fetchAllContacts(
  db: DataClient,
  maxRows?: number
): Promise<Contact[]> {
  const bounded = rowBudget(maxRows);
  return withContext('contacts', () =>
    fetchAllPages<Contact>((from, to) =>
      bounded(db.from('contacts').select('*').order('id').range(from, to))
    )
  );
}

async function fetchExcludedIds(
  db: DataClient,
  audience: AudienceConfig,
  maxRows?: number
): Promise<Set<string>> {
  if (!audience.excludeTagIds || audience.excludeTagIds.length === 0) {
    return new Set();
  }
  return fetchTaggedContactIds(db, audience.excludeTagIds, maxRows);
}

function hasCustomFieldFilter(
  audience: AudienceConfig
): audience is AudienceConfig & { customField: CustomFieldFilter } {
  return Boolean(audience.customField?.fieldId);
}

async function fetchAudienceContactIds(
  db: DataClient,
  audience: AudienceConfig,
  maxRows?: number
): Promise<Set<string> | null> {
  if (
    audience.type === 'tags' &&
    audience.tagIds &&
    audience.tagIds.length > 0
  ) {
    return fetchTaggedContactIds(db, audience.tagIds, maxRows);
  }
  if (audience.type === 'custom_field' && hasCustomFieldFilter(audience)) {
    return fetchCustomFieldContactIds(db, audience.customField, maxRows);
  }
  return null;
}

export async function resolveAudienceContacts(
  db: DataClient,
  audience: AudienceConfig,
  resolveCsv: (rows: CsvAudienceRow[]) => Promise<Contact[]>,
  options: { maxRows?: number } = {}
): Promise<Contact[]> {
  const excluded = await fetchExcludedIds(db, audience, options.maxRows);
  // Opted-out and blocked contacts are never an audience (lib/contacts/consent).
  const keep = (contact: Contact) =>
    !excluded.has(contact.id) && !marketingSuppression(contact);

  if (audience.type === 'all') {
    return (await fetchAllContacts(db, options.maxRows)).filter(keep);
  }
  if (audience.type === 'csv') {
    if (!audience.csvContacts) return [];
    return (await resolveCsv(audience.csvContacts)).filter(keep);
  }

  const ids = await fetchAudienceContactIds(db, audience, options.maxRows);
  if (!ids) return [];
  const wanted = [...ids].filter((id) => !excluded.has(id));
  if (wanted.length === 0) return [];
  return (await fetchContactsByIds(db, wanted, options.maxRows)).filter(keep);
}

export async function countAudience(
  db: DataClient,
  audience: AudienceConfig
): Promise<number | null> {
  if (audience.type === 'csv') {
    return audience.csvContacts && audience.csvContacts.length > 0
      ? audience.csvContacts.length
      : null;
  }

  if (audience.type === 'all') {
    const { count, error } = await db
      .from('contacts')
      .select('id', { count: 'exact', head: true })
      .is('opted_out_at', null)
      .is('blocked_at', null);
    if (error) throw new Error(`Failed to count contacts: ${error.message}`);
    const total = count ?? 0;
    const excluded = await fetchExcludedIds(db, audience);
    return Math.max(0, total - excluded.size);
  }

  if (audience.type === 'custom_field' && !audience.customField?.value) {
    return null;
  }

  const ids = await fetchAudienceContactIds(db, audience);
  if (!ids) return null;
  const excluded = await fetchExcludedIds(db, audience);
  let size = 0;
  for (const id of ids) if (!excluded.has(id)) size++;
  return size;
}
