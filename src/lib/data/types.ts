import type { createAuthClient } from '@/lib/auth/client';
import type { createStorageFacade } from '@/lib/storage/client';
import type { createRealtimeChannel } from '@/lib/realtime/client';
export type { RealtimeChannel } from '@/lib/realtime/client';

export interface DataError {
  message: string;
  code?: string;
  details?: string;
  hint?: string;
}
export interface QueryResult<T> {
  data: T | null;
  error: DataError | null;
  count?: number | null;
}
// One compatibility escape hatch for imported SDK DTO inference. Runtime
// resources/payloads still validate; new consumers should supply select<DTO>().
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LegacyData = any;
export type Row = Record<string, LegacyData>;
export type FilterOperator =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'is'
  | 'ilike'
  | 'like'
  | 'contains';
export interface Filter {
  field: string;
  op: FilterOperator;
  value: unknown;
}
export interface QuerySpec {
  resource: string;
  operation: 'select' | 'insert' | 'update' | 'upsert' | 'delete';
  projection?: string;
  filters: Filter[];
  or?: string[];
  orders?: { field: string; ascending: boolean; nullsFirst?: boolean }[];
  offset?: number;
  limit?: number;
  count?: 'exact' | 'planned' | 'estimated';
  head?: boolean;
  cardinality?: 'single' | 'maybeSingle';
  values?: Row | Row[];
  onConflict?: string;
  ignoreDuplicates?: boolean;
  returning?: boolean;
}
export interface QueryBuilder<T = Row[]> extends PromiseLike<QueryResult<T>> {
  // Transitional DTO default matches the removed SDK. New call sites should use
  // select<Contact>()/select<Conversation>(); runtime projections remain validated.
  select<R = LegacyData>(
    projection?: string,
    options?: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean }
  ): QueryBuilder<R[]>;
  insert(
    values: Row | Row[],
    options?: { count?: 'exact' }
  ): QueryBuilder<Row[]>;
  update(values: Row, options?: { count?: 'exact' }): QueryBuilder<Row[]>;
  upsert(
    values: Row | Row[],
    options?: {
      onConflict?: string;
      ignoreDuplicates?: boolean;
      count?: 'exact';
    }
  ): QueryBuilder<Row[]>;
  delete(options?: { count?: 'exact' }): QueryBuilder<Row[]>;
  eq(field: string, value: unknown): QueryBuilder<T>;
  neq(field: string, value: unknown): QueryBuilder<T>;
  gt(field: string, value: unknown): QueryBuilder<T>;
  gte(field: string, value: unknown): QueryBuilder<T>;
  lt(field: string, value: unknown): QueryBuilder<T>;
  lte(field: string, value: unknown): QueryBuilder<T>;
  in(field: string, values: unknown[]): QueryBuilder<T>;
  is(field: string, value: null | boolean): QueryBuilder<T>;
  ilike(field: string, value: string): QueryBuilder<T>;
  like(field: string, value: string): QueryBuilder<T>;
  contains(field: string, value: unknown): QueryBuilder<T>;
  or(expression: string): QueryBuilder<T>;
  filter(field: string, operator: string, value: unknown): QueryBuilder<T>;
  not(field: string, operator: string, value: unknown): QueryBuilder<T>;
  match(values: Row): QueryBuilder<T>;
  order(
    field: string,
    options?: {
      ascending?: boolean;
      nullsFirst?: boolean;
      referencedTable?: string;
      foreignTable?: string;
    }
  ): QueryBuilder<T>;
  range(from: number, to: number): QueryBuilder<T>;
  limit(count: number): QueryBuilder<T>;
  single<R = T extends Array<infer U> ? U : T>(): QueryBuilder<R>;
  maybeSingle<R = T extends Array<infer U> ? U : T>(): QueryBuilder<R>;
  returns<R>(): QueryBuilder<R>;
  throwOnError(): QueryBuilder<T>;
}
export interface DataClient {
  from<T = Row>(resource: string): QueryBuilder<T[]>;
  rpc<T = LegacyData>(name: string, args?: Row): Promise<QueryResult<T>>;
  auth: ReturnType<typeof createAuthClient>;
  storage: ReturnType<typeof createStorageFacade>;
  channel: typeof createRealtimeChannel;
  removeChannel(
    channel: ReturnType<typeof createRealtimeChannel>
  ): Promise<unknown>;
}
export interface TenantContext {
  accountId: string;
  userId?: string;
  role?: 'owner' | 'admin' | 'agent' | 'viewer';
}
