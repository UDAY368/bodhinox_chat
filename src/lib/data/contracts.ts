import inventory from '../../../prisma/schema-inventory.json';
import type { Filter, QuerySpec, Row, TenantContext } from './types';

export class ContractError extends Error {
  constructor(
    message: string,
    public code = 'INVALID_QUERY',
    public status = 400
  ) {
    super(message);
  }
}
export interface Column {
  name: string;
  type: string;
  nullable?: boolean;
  default?: string | null;
  reference?: { table: string; column: string; onDelete?: string } | null;
}
export interface Resource {
  table: string;
  slug: string;
  columns: Column[];
  read: string[];
  writable: string[];
  minWrite: 'agent' | 'admin';
  browser: boolean;
  browserWrite: boolean;
}
const tables = [
  'profiles',
  'contacts',
  'tags',
  'contact_tags',
  'custom_fields',
  'contact_custom_values',
  'contact_notes',
  'conversations',
  'messages',
  'whatsapp_config',
  'message_templates',
  'pipelines',
  'pipeline_stages',
  'deals',
  'broadcasts',
  'broadcast_recipients',
  'automations',
  'automation_steps',
  'automation_logs',
  'automation_pending_executions',
  'message_reactions',
  'flows',
  'flow_nodes',
  'flow_runs',
  'flow_run_events',
  'accounts',
  'account_invitations',
  'member_presence',
  'api_keys',
  'notifications',
  'webhook_endpoints',
  'ai_configs',
  'ai_knowledge_documents',
  'ai_knowledge_chunks',
  'ai_usage_log',
  'quick_replies',
] as const;
export const internalFields: ReadonlySet<string> = new Set([
  'inbound_created_meta_id',
]);
const sensitive = new Set([
  ...internalFields,
  'access_token',
  'verify_token',
  'verify_token_hash',
  'token_hash',
  'key_hash',
  'secret',
  'secret_encrypted',
  'signing_secret',
  'api_key_encrypted',
  'api_key',
  'embeddings_api_key',
  'embedding',
  'fts',
]);
const settings = new Set([
  'tags',
  'custom_fields',
  'whatsapp_config',
  'message_templates',
  'pipelines',
  'pipeline_stages',
  'accounts',
  'account_invitations',
  'api_keys',
  'webhook_endpoints',
  'ai_configs',
]);
const serverOnly = new Set([
  'api_keys',
  'account_invitations',
  'webhook_endpoints',
  'ai_knowledge_chunks',
]);
const browserReadOnly = new Set([
  // Dedicated automation routes enforce activation and scheduling validators.
  'automations',
  'automation_steps',
  'whatsapp_config',
  'ai_configs',
  'automation_logs',
  'automation_pending_executions',
  'flow_runs',
  'flow_run_events',
  'member_presence',
  'ai_usage_log',
  'broadcast_recipients',
]);
const immutable = new Set([
  'id',
  'created_at',
  'updated_at',
  'phone_normalized',
  'owner_user_id',
  'account_role',
  'role',
  'beta_features',
  'last_customer_message_at',
]);
const metadata = inventory.tables as unknown as Record<
  string,
  Column[] | { columns: Column[] }
>;
export const resources: Record<string, Resource> = Object.fromEntries(
  tables.map((table) => {
    const entry = metadata[table];
    const physicalColumns = Array.isArray(entry) ? entry : (entry?.columns ?? []);
    const columns: Column[] = table === 'conversations'
      ? [...physicalColumns, { name: 'last_customer_message_at', type: 'TIMESTAMPTZ', nullable: true }]
      : physicalColumns;
    return [
      table,
      {
        table,
        slug: table.replaceAll('_', '-'),
        columns,
        read: columns.map((c) => c.name).filter((name) => !sensitive.has(name)),
        writable: columns
          .map((c) => c.name)
          .filter((name) => !immutable.has(name) && !internalFields.has(name)),
        minWrite: settings.has(table) ? 'admin' : 'agent',
        browser: !serverOnly.has(table),
        browserWrite: !browserReadOnly.has(table),
      } satisfies Resource,
    ];
  })
);
export function getResource(name: string, browser = false): Resource {
  const resource = Object.hasOwn(resources, name) ? resources[name] : undefined;
  if (!resource || (browser && !resource.browser))
    throw new ContractError(
      'Unknown or unavailable CRM resource',
      'RESOURCE_NOT_FOUND',
      404
    );
  return resource;
}
export function resourceBySlug(slug: string): Resource {
  const resource = Object.values(resources).find(
    (r) => r.slug === slug && r.browser
  );
  if (!resource)
    throw new ContractError('Unknown CRM resource', 'RESOURCE_NOT_FOUND', 404);
  return resource;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateTenant(context: TenantContext) {
  if (!UUID.test(context.accountId))
    throw new ContractError(
      'A valid tenant scope is required',
      'TENANT_REQUIRED',
      401
    );
}
export function validateValue(column: Column, value: unknown): void {
  if (value === undefined)
    throw new ContractError(`Missing value for ${column.name}`);
  if (value === null) return;
  const type = column.type.toLowerCase();
  if (type.includes('json')) {
    if (JSON.stringify(value).length > 131072)
      throw new ContractError('JSON field is too large');
    return;
  }
  if (type.endsWith('[]')) {
    if (!Array.isArray(value) || value.length > 1000)
      throw new ContractError('Expected a bounded array');
    return;
  }
  if (type.includes('bool')) {
    if (typeof value !== 'boolean')
      throw new ContractError(`Expected boolean for ${column.name}`);
    return;
  }
  if (/int|numeric|decimal|real|double/.test(type)) {
    if (
      (typeof value !== 'number' && typeof value !== 'string') ||
      !Number.isFinite(Number(value))
    )
      throw new ContractError(`Expected number for ${column.name}`);
    return;
  }
  if (typeof value !== 'string' || value.length > 65536)
    throw new ContractError(`Expected bounded text for ${column.name}`);
  if (type.includes('uuid') && !UUID.test(value))
    throw new ContractError(`Invalid ID for ${column.name}`);
  if (/timestamp|date$/.test(type) && Number.isNaN(Date.parse(value)))
    throw new ContractError(`Invalid date for ${column.name}`);
}
export function columnFor(resource: Resource, name: string): Column {
  const column = resource.columns.find((c) => c.name === name);
  if (!column)
    throw new ContractError(`Unknown field ${name} on ${resource.table}`);
  return column;
}
const jsonTextFilters: Record<string, Record<string, readonly string[]>> = {
  flow_run_events: { payload: ['meta_message_id'] },
};
export function jsonTextFilter(
  resource: Resource,
  field: string
): { column: Column; key: string } | null {
  if (!field.includes('->>')) return null;
  const match = /^([a-z_][a-z0-9_]*)->>([a-z_][a-z0-9_]*)$/.exec(field);
  if (
    !match ||
    !(jsonTextFilters[resource.table]?.[match[1]] ?? []).includes(match[2])
  )
    throw new ContractError(
      'Unsupported JSON filter path',
      'UNSUPPORTED_QUERY'
    );
  const column = columnFor(resource, match[1]);
  if (!column.type.toLowerCase().includes('json'))
    throw new ContractError('Expected JSON filter field');
  return { column, key: match[2] };
}
export function validateFilter(
  resource: Resource,
  filter: Filter,
  context: TenantContext,
  browser = false
): void {
  if (
    !filter ||
    typeof filter.field !== 'string' ||
    typeof filter.op !== 'string' ||
    ![
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
    ].includes(filter.op)
  )
    throw new ContractError('Unsupported filter operator');
  if (
    Object.keys(filter).some((key) => !['field', 'op', 'value'].includes(key))
  )
    throw new ContractError('Unexpected filter property');
  const json = jsonTextFilter(resource, filter.field);
  if (json) {
    if (browser && !resource.read.includes(json.column.name))
      throw new ContractError('Unavailable JSON filter field');
    if (filter.op === 'contains')
      throw new ContractError('JSON text path does not support containment');
    if (filter.op === 'is') {
      if (filter.value !== null)
        throw new ContractError('JSON text paths only support null IS checks');
    } else if (filter.op === 'in') {
      if (!Array.isArray(filter.value) || filter.value.length > 1000)
        throw new ContractError('Invalid inclusion filter');
      filter.value.forEach((value) =>
        validateValue({ name: json.column.name, type: 'text' }, value)
      );
    } else
      validateValue({ name: json.column.name, type: 'text' }, filter.value);
    return;
  }
  // Related-field filters are checked again against a concrete relationship by the compiler.
  const parts = filter.field.split('.');
  if (parts.length > 2 || parts.some((p) => !/^[_a-z][_a-z0-9]*$/i.test(p)))
    throw new ContractError('Invalid filter field');
  const target = parts.length === 2 ? getResource(parts[0], browser) : resource;
  const field = parts.at(-1)!;
  const column = columnFor(target, field);
  if (browser && !target.read.includes(field))
    throw new ContractError('Unavailable filter field');
  if (
    field === 'account_id' &&
    filter.op === 'eq' &&
    filter.value !== context.accountId
  )
    throw new ContractError(
      'Cross-tenant filter rejected',
      'TENANT_MISMATCH',
      403
    );
  if (filter.op === 'in') {
    if (!Array.isArray(filter.value) || filter.value.length > 1000)
      throw new ContractError('Invalid inclusion filter');
    filter.value.forEach((v) => validateValue(column, v));
  } else if (filter.op === 'is') {
    if (filter.value !== null && typeof filter.value !== 'boolean')
      throw new ContractError('Invalid null/boolean filter');
  } else if (['ilike', 'like'].includes(filter.op)) {
    if (typeof filter.value !== 'string' || filter.value.length > 1000)
      throw new ContractError('Invalid search pattern');
  } else if (filter.op === 'contains') {
    if (
      !column.type.includes('[]') &&
      !column.type.toLowerCase().includes('json')
    )
      throw new ContractError('Containment only supports JSON/array fields');
    validateValue(column, filter.value);
  } else validateValue(column, filter.value);
}
export function validateQuery(
  name: string,
  input: Partial<QuerySpec>,
  context: TenantContext,
  browser = false,
  worker = false
): QuerySpec {
  validateTenant(context);
  const resource = getResource(name, browser);
  const accepted = [
    'resource',
    'operation',
    'projection',
    'filters',
    'or',
    'orders',
    'offset',
    'limit',
    'count',
    'head',
    'cardinality',
    'values',
    'onConflict',
    'ignoreDuplicates',
    'returning',
  ];
  if (Object.keys(input).some((k) => !accepted.includes(k)))
    throw new ContractError('Unexpected query property');
  const spec: QuerySpec = {
    ...input,
    resource: name,
    operation: input.operation ?? 'select',
    filters: input.filters ?? [],
    projection: input.projection ?? '*',
  };
  if (
    !['select', 'insert', 'update', 'upsert', 'delete'].includes(spec.operation)
  )
    throw new ContractError('Unsupported operation');
  if (typeof spec.projection !== 'string' || spec.projection.length > 4096)
    throw new ContractError('Invalid projection');
  if (!Array.isArray(spec.filters) || spec.filters.length > 30)
    throw new ContractError('Too many filters');
  spec.filters.forEach((f) => validateFilter(resource, f, context, browser));
  if (spec.orders && (!Array.isArray(spec.orders) || spec.orders.length > 5))
    throw new ContractError('Invalid sorting');
  for (const sort of spec.orders ?? []) {
    if (
      !sort ||
      Object.keys(sort).some(
        (key) => !['field', 'ascending', 'nullsFirst'].includes(key)
      ) ||
      typeof sort.ascending !== 'boolean' ||
      (sort.nullsFirst !== undefined && typeof sort.nullsFirst !== 'boolean')
    )
      throw new ContractError('Invalid sorting schema');
    columnFor(resource, sort.field);
    if (browser && !resource.read.includes(sort.field))
      throw new ContractError('Unavailable sorting field');
  }
  if (
    spec.or &&
    (!Array.isArray(spec.or) ||
      spec.or.length > 5 ||
      spec.or.some((s) => typeof s !== 'string' || s.length > 4096))
  )
    throw new ContractError('Invalid OR filter');
  for (const key of ['offset', 'limit'] as const)
    if (
      spec[key] !== undefined &&
      (!Number.isInteger(spec[key]) ||
        spec[key]! < 0 ||
        spec[key]! > (key === 'limit' ? 1000 : 1000000))
    )
      throw new ContractError('Pagination out of bounds');
  if (spec.cardinality && !['single', 'maybeSingle'].includes(spec.cardinality))
    throw new ContractError('Invalid cardinality');
  if (spec.count && !['exact', 'planned', 'estimated'].includes(spec.count))
    throw new ContractError('Invalid count mode');
  for (const key of ['head', 'returning', 'ignoreDuplicates'] as const)
    if (spec[key] !== undefined && typeof spec[key] !== 'boolean')
      throw new ContractError(`Invalid ${key} flag`);
  if (spec.operation !== 'select') {
    authorizeWrite(resource, context, browser);
    if (['insert', 'update', 'upsert'].includes(spec.operation)) {
      const rows = Array.isArray(spec.values) ? spec.values : [spec.values];
      if (!rows.length || rows.length > 500 || rows.some((v) => !v))
        throw new ContractError('Invalid mutation rows');
      rows.forEach((row) =>
        validateWrite(name, row!, context, browser, spec.operation, worker)
      );
    }
  }
  if (['update', 'delete'].includes(spec.operation) && !spec.filters.length)
    throw new ContractError('Mutation requires explicit record filters');
  if (resource.table === 'profiles' && spec.operation !== 'select') {
    if (
      !context.userId ||
      (['update', 'delete'].includes(spec.operation) &&
        !spec.filters.some(
          (f) =>
            f.field === 'user_id' && f.op === 'eq' && f.value === context.userId
        ))
    )
      throw new ContractError(
        'Profile mutations require the current user filter',
        'FORBIDDEN',
        403
      );
    if (spec.operation === 'delete')
      throw new ContractError(
        'Use the identity account deletion flow',
        'FORBIDDEN',
        403
      );
  }
  return spec;
}
export function authorizeWrite(
  resource: Resource,
  context: TenantContext,
  browser = false
) {
  const rank = { viewer: 0, agent: 1, admin: 2, owner: 3 };
  if (
    !context.role ||
    rank[context.role] < rank[resource.minWrite] ||
    (browser && !resource.browserWrite)
  )
    throw new ContractError(
      'Insufficient permission for this mutation',
      'FORBIDDEN',
      403
    );
}
export function validateWrite(
  name: string,
  row: Row,
  context: TenantContext,
  browser = false,
  operation = 'insert',
  worker = false
): Row {
  validateTenant(context);
  const resource = getResource(name, browser);
  authorizeWrite(resource, context, browser);
  if (!row || typeof row !== 'object' || Array.isArray(row))
    throw new ContractError('Expected record payload');
  for (const [field, value] of Object.entries(row)) {
    const column = columnFor(resource, field);
    // Roles stay immutable except on creation of server-managed invitations.
    // Membership changes must continue through the dedicated membership policy.
    const invitationRole = !browser && name === 'account_invitations' &&
      operation === 'insert' && field === 'role' &&
      typeof value === 'string' && ['admin', 'agent', 'viewer'].includes(value);
    if (
      !resource.writable.includes(field) &&
      !invitationRole &&
      !(field === 'id' && ['insert', 'upsert'].includes(operation)) &&
      !(!browser && worker && internalFields.has(field)) &&
      !(!browser && ['created_at', 'updated_at'].includes(field))
    )
      throw new ContractError(`Field ${field} cannot be changed`);
    if (browser && sensitive.has(field))
      throw new ContractError(`Field ${field} is server-managed`);
    if (
      name === 'profiles' &&
      !['full_name', 'avatar_url', 'user_id', 'account_id'].includes(field)
    )
      throw new ContractError(
        `Profile field ${field} is managed by identity services`
      );
    if (
      browser &&
      [
        'execution_count',
        'last_executed_at',
        'unread_count',
        'ai_reply_count',
        'total_recipients',
        'sent_count',
        'delivered_count',
        'read_count',
        'replied_count',
        'failed_count',
        'delivery_locked_at',
      ].includes(field)
    )
      throw new ContractError(`Field ${field} is server-managed`);
    if (field === 'account_id' && value !== context.accountId)
      throw new ContractError(
        'Cross-tenant payload rejected',
        'TENANT_MISMATCH',
        403
      );
    if (field === 'user_id' && browser && value !== context.userId)
      throw new ContractError(
        'Cannot impersonate another user',
        'FORBIDDEN',
        403
      );
    validateValue(column, value);
  }
  if (!Object.keys(row).length)
    throw new ContractError('Empty mutation payload');
  return row;
}
