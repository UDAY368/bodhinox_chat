import type {
  DataError,
  QueryBuilder,
  QueryResult,
  QuerySpec,
  Row,
  FilterOperator,
  LegacyData,
} from './types';

export type QueryExecutor = (
  query: QuerySpec
) => Promise<QueryResult<LegacyData>>;
export function buildQuery<T = Row[]>(
  resource: string,
  execute: QueryExecutor
): QueryBuilder<T> {
  const spec: QuerySpec = { resource, operation: 'select', filters: [] };
  let unsupported: string | undefined;
  let shouldThrow = false;
  let pending: Promise<QueryResult<LegacyData>> | undefined;
  const builder = {
    select(projection = '*', options: Record<string, unknown> = {}) {
      spec.projection = projection;
      Object.assign(spec, options);
      if (spec.operation !== 'select') spec.returning = true;
      return builder;
    },
    insert(values: Row | Row[], options = {}) {
      spec.operation = 'insert';
      spec.values = values;
      Object.assign(spec, options);
      return builder;
    },
    update(values: Row, options = {}) {
      spec.operation = 'update';
      spec.values = values;
      Object.assign(spec, options);
      return builder;
    },
    upsert(values: Row | Row[], options = {}) {
      spec.operation = 'upsert';
      spec.values = values;
      Object.assign(spec, options);
      return builder;
    },
    delete(options = {}) {
      spec.operation = 'delete';
      Object.assign(spec, options);
      return builder;
    },
    or(expression: string) {
      (spec.or ??= []).push(expression);
      return builder;
    },
    match(values: Row) {
      for (const [field, value] of Object.entries(values))
        spec.filters.push({ field, op: 'eq', value });
      return builder;
    },
    filter(field: string, operator: string, value: unknown) {
      if (
        [
          'eq',
          'neq',
          'gt',
          'gte',
          'lt',
          'lte',
          'in',
          'is',
          'ilike',
          'like',
          'contains',
        ].includes(operator)
      )
        spec.filters.push({ field, op: operator as FilterOperator, value });
      else unsupported = `Unsupported filter operator: ${operator}`;
      return builder;
    },
    not(field: string, operator: string, value: unknown) {
      if (operator === 'eq') spec.filters.push({ field, op: 'neq', value });
      else unsupported = `Unsupported negated operator: ${operator}`;
      return builder;
    },
    order(
      field: string,
      options: {
        ascending?: boolean;
        nullsFirst?: boolean;
        referencedTable?: string;
        foreignTable?: string;
      } = {}
    ) {
      if (options.referencedTable || options.foreignTable)
        unsupported = 'Related-resource ordering is unsupported';
      (spec.orders ??= []).push({
        field,
        ascending: options.ascending !== false,
        nullsFirst: options.nullsFirst,
      });
      return builder;
    },
    range(from: number, to: number) {
      spec.offset = from;
      spec.limit = to - from + 1;
      return builder;
    },
    limit(limit: number) {
      spec.limit = limit;
      return builder;
    },
    single() {
      spec.cardinality = 'single';
      return builder;
    },
    maybeSingle() {
      spec.cardinality = 'maybeSingle';
      return builder;
    },
    returns() {
      return builder;
    },
    throwOnError() {
      shouldThrow = true;
      return builder;
    },
    then(
      resolve: (value: QueryResult<LegacyData>) => unknown,
      reject?: (reason: unknown) => unknown
    ) {
      pending ??= (
        unsupported
          ? Promise.resolve({
              data: null,
              error: { message: unsupported, code: 'UNSUPPORTED_QUERY' },
            })
          : execute(structuredClone(spec))
      ).catch((error: unknown) => ({
        data: null,
        error: {
          message:
            error instanceof Error ? error.message : 'Data request failed',
          code: (error as DataError)?.code,
        },
      }));
      return pending.then((result) => {
        if (shouldThrow && result.error)
          throw Object.assign(new Error(result.error.message), result.error);
        return resolve(result);
      }, reject);
    },
  };
  for (const op of [
    'eq',
    'neq',
    'gt',
    'gte',
    'lt',
    'lte',
    'in',
    'is',
    'ilike',
    'like',
    'contains',
  ] as FilterOperator[])
    Object.assign(builder, {
      [op]: (field: string, value: unknown) => {
        spec.filters.push({ field, op, value });
        return builder;
      },
    });
  return builder as unknown as QueryBuilder<T>;
}
