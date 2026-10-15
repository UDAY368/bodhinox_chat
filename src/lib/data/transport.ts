import { getResource, ContractError } from './contracts';
import type { QueryResult, QuerySpec, Row, LegacyData } from './types';
const queryKeys = [
  'projection',
  'filters',
  'or',
  'orders',
  'offset',
  'limit',
  'count',
  'head',
  'cardinality',
  'returning',
  'onConflict',
  'ignoreDuplicates',
] as const;
export function encodeQuery(spec: QuerySpec): {
  url: string;
  init: RequestInit;
} {
  const resource = getResource(spec.resource, true);
  const search = new URLSearchParams();
  for (const key of queryKeys)
    if (spec[key] !== undefined) search.set(key, JSON.stringify(spec[key]));
  const method = {
    select: 'GET',
    insert: 'POST',
    upsert: 'PUT',
    update: 'PATCH',
    delete: 'DELETE',
  }[spec.operation];
  // Legacy callers provided optimistic timestamps. Authority stays on the
  // server, while every other payload field still reaches strict validation.
  const clean = (row: Row) =>
    Object.fromEntries(
      Object.entries(row).filter(
        ([field]) => field !== 'created_at' && field !== 'updated_at'
      )
    );
  const values =
    spec.values === undefined
      ? undefined
      : Array.isArray(spec.values)
        ? spec.values.map(clean)
        : clean(spec.values);
  return {
    url: `/api/crm/${resource.slug}?${search}`,
    init: {
      method,
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      ...(['POST', 'PUT', 'PATCH'].includes(method)
        ? { body: JSON.stringify(values) }
        : {}),
    },
  };
}
export function decodeQuery(
  request: Request,
  resource: string,
  values?: Row | Row[]
): QuerySpec {
  const params = new URL(request.url).searchParams;
  const spec: QuerySpec = {
    resource,
    operation:
      (
        {
          GET: 'select',
          POST: 'insert',
          PUT: 'upsert',
          PATCH: 'update',
          DELETE: 'delete',
        } as const
      )[request.method as 'GET'] ?? 'select',
    filters: [],
  };
  for (const [key, value] of params) {
    if (!(queryKeys as readonly string[]).includes(key))
      throw new ContractError('Unexpected query parameter');
    if (params.getAll(key).length !== 1)
      throw new ContractError('Duplicate query parameter');
    try {
      Object.assign(spec, { [key]: JSON.parse(value) });
    } catch {
      throw new ContractError('Malformed query parameter');
    }
  }
  if (values !== undefined) spec.values = values;
  return spec;
}
export async function browserQuery(
  spec: QuerySpec,
  fetcher: (url: string, init: RequestInit) => Promise<Response>
): Promise<QueryResult<LegacyData>> {
  const { url, init } = encodeQuery(spec);
  const response = await fetcher(url, init);
  let body: QueryResult<LegacyData>;
  try {
    body = await response.json();
  } catch {
    return {
      data: null,
      error: { message: 'Invalid data response', code: 'TRANSPORT_ERROR' },
    };
  }
  if (!response.ok && !body.error)
    return {
      data: null,
      error: {
        message: `Data request failed (${response.status})`,
        code: 'TRANSPORT_ERROR',
      },
    };
  return body;
}
