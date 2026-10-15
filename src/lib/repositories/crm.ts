import { withTenant } from '@/lib/db/tenant';
import { getWorkerPrisma } from '@/lib/db/prisma';
import {
  ContractError,
  getResource,
  validateQuery,
} from '@/lib/data/contracts';
import type {
  QueryResult,
  QuerySpec,
  Row,
  TenantContext,
  LegacyData,
} from '@/lib/data/types';
import { compileMutation, compileSelect, resourceReferences } from './query';
import { dataError } from '@/lib/data/errors';

export interface SqlTransaction {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
}
export function shapeResult(
  rows: Row[],
  spec: QuerySpec,
  count?: number
): QueryResult<LegacyData> {
  if (spec.cardinality) {
    if (rows.length > 1 || (spec.cardinality === 'single' && rows.length !== 1))
      return {
        data: null,
        error: { message: 'Expected exactly one record', code: 'PGRST116' },
        count: count ?? null,
      };
    return {
      data: spec.head ? null : (rows[0] ?? null),
      error: null,
      count: count ?? null,
    };
  }
  return {
    data:
      spec.head || (spec.operation !== 'select' && !spec.returning)
        ? null
        : rows,
    error: null,
    count: count ?? null,
  };
}
export async function validateReferences(
  tx: SqlTransaction,
  spec: QuerySpec,
  context: TenantContext,
  worker = false
): Promise<void> {
  if (!spec.values) return;
  const rows = Array.isArray(spec.values) ? spec.values : [spec.values];
  for (const column of resourceReferences(spec.resource)) {
    const reference = column.reference!;
    const target = getResource(reference.table.replace(/^public\./, ''));
    if (column.name === 'account_id') continue;
    const values = [
      ...new Set(
        rows
          .map((row) => row[column.name])
          .filter((value) => value !== undefined && value !== null)
      ),
    ];
    for (const value of values) {
      // A tree insert creates parents and children in the same statement.
      // The database composite FK still enforces account and automation scope.
      if (spec.operation === 'insert' && target.table === spec.resource) {
        const pending = rows.find((row) => row[reference.column] === value);
        if (pending) {
          if (
            spec.resource === 'automation_steps' &&
            rows.some(
              (row) =>
                row[column.name] === value &&
                row.automation_id !== pending.automation_id
            )
          )
            throw new ContractError(
              'Parent step belongs to another automation',
              'RELATED_RECORD_FORBIDDEN',
              403
            );
          continue;
        }
      }
      const scope =
        target.table === 'accounts'
          ? 'id'
          : target.table === 'profiles'
            ? null
            : 'account_id';
      const text = scope
        ? `SELECT 1 FROM "${target.table}" WHERE "${reference.column}" = $1::uuid AND "${scope}" = $2::uuid LIMIT 1`
        : `SELECT 1 FROM profiles p JOIN account_memberships m ON m.user_id=p.user_id WHERE p."${reference.column}"=$1::uuid AND m.account_id=$2::uuid LIMIT 1`;
      const found = await tx.$queryRawUnsafe<Row[]>(
        text,
        value,
        context.accountId
      );
      if (!found.length)
        throw new ContractError(
          `Related ${column.name} is outside this tenant or does not exist`,
          'RELATED_RECORD_FORBIDDEN',
          403
        );
    }
  }
  const userFields = getResource(spec.resource).columns.filter(
    (c) =>
      c.reference?.table === 'auth.users' || c.reference?.table === 'auth_users'
  );
  for (const field of userFields)
    for (const row of rows)
      if (row[field.name] != null) {
        // Retained author/audit identity survives membership removal. Only the
        // trusted worker boundary may reuse a persisted historical author;
        // assignment/sender/recipient checks below still require membership.
        if (
          worker &&
          ['user_id', 'created_by', 'created_by_user_id'].includes(field.name)
        )
          continue;
        const found = await tx.$queryRawUnsafe<Row[]>(
          'SELECT 1 FROM account_memberships WHERE user_id=$1::uuid AND account_id=$2::uuid LIMIT 1',
          row[field.name],
          context.accountId
        );
        if (!found.length)
          throw new ContractError(
            `User ${field.name} is not a tenant member`,
            'RELATED_RECORD_FORBIDDEN',
            403
          );
      }
  // Some upstream assignment IDs and JSON configuration references had no FK.
  // Validate these deliberately rather than relying on incomplete source metadata.
  const memberFields: Record<string, string[]> = {
    conversations: ['assigned_agent_id'],
    ai_configs: ['handoff_agent_id'],
    messages: ['sender_id'],
  };
  const ensureMember = async (value: unknown, field: string) => {
    if (value == null) return;
    const found = await tx.$queryRawUnsafe<Row[]>(
      'SELECT 1 FROM account_memberships WHERE user_id=$1::uuid AND account_id=$2::uuid LIMIT 1',
      value,
      context.accountId
    );
    if (!found.length)
      throw new ContractError(
        `User ${field} is not a tenant member`,
        'RELATED_RECORD_FORBIDDEN',
        403
      );
  };
  const ensureRecord = async (
    table:
      'tags' | 'pipelines' | 'pipeline_stages' | 'custom_fields' | 'contacts',
    value: unknown,
    field: string
  ) => {
    if (value == null) return;
    const found = await tx.$queryRawUnsafe<Row[]>(
      `SELECT 1 FROM "${table}" WHERE id=$1::uuid AND account_id=$2::uuid LIMIT 1`,
      value,
      context.accountId
    );
    if (!found.length)
      throw new ContractError(
        `Related ${field} is outside this tenant or does not exist`,
        'RELATED_RECORD_FORBIDDEN',
        403
      );
  };
  for (const row of rows) {
    for (const field of memberFields[spec.resource] ?? [])
      await ensureMember(row[field], field);
    if (spec.resource === 'message_reactions' && row.actor_id) {
      if (row.actor_type === 'agent')
        await ensureMember(row.actor_id, 'actor_id');
      else if (row.actor_type === 'customer')
        await ensureRecord('contacts', row.actor_id, 'actor_id');
    }
    const configs =
      spec.resource === 'automation_steps'
        ? [row.step_config]
        : spec.resource === 'automations'
          ? [row.trigger_config]
          : spec.resource === 'flow_nodes'
            ? [row.config]
            : [];
    for (const config of configs)
      if (config && typeof config === 'object' && !Array.isArray(config)) {
        for (const [field, table] of [
          ['tag_id', 'tags'],
          ['pipeline_id', 'pipelines'],
          ['stage_id', 'pipeline_stages'],
          ['custom_field_id', 'custom_fields'],
        ] as const)
          await ensureRecord(table, config[field], field);
        for (const field of ['agent_id', 'assign_to'])
          await ensureMember(config[field], field);
        if (config.subject === 'tag')
          await ensureRecord('tags', config.subject_key, 'subject_key');
        if (
          typeof config.field === 'string' &&
          config.field.startsWith('custom:')
        )
          await ensureRecord('custom_fields', config.field.slice(7), 'field');
      }
  }
  // Preserve the pipeline/stage invariant in addition to tenant membership.
  if (spec.resource === 'deals')
    for (const row of rows)
      if (row.stage_id && row.pipeline_id) {
        const found = await tx.$queryRawUnsafe<Row[]>(
          'SELECT 1 FROM pipeline_stages WHERE id=$1::uuid AND pipeline_id=$2::uuid AND account_id=$3::uuid',
          row.stage_id,
          row.pipeline_id,
          context.accountId
        );
        if (!found.length)
          throw new ContractError('Stage is not part of the selected pipeline');
      }
}
export async function executeInTransaction(
  tx: SqlTransaction,
  input: QuerySpec,
  context: TenantContext,
  browser = false,
  worker = false
): Promise<QueryResult<LegacyData>> {
  const spec = validateQuery(input.resource, input, context, browser, worker);
  // Validate caller fields first; only then add the authoritative mutation time.
  if (
    spec.values &&
    getResource(spec.resource).columns.some(
      (column) => column.name === 'updated_at'
    )
  ) {
    const updatedAt = new Date().toISOString();
    const stamp = (row: Row) => ({ ...row, updated_at: updatedAt });
    spec.values = Array.isArray(spec.values)
      ? spec.values.map(stamp)
      : stamp(spec.values);
  }
  let count: number | undefined;
  if (spec.count && spec.operation === 'select') {
    const query = compileSelect(spec, context, browser, true);
    const result = await tx.$queryRawUnsafe<{ count: number }[]>(
      query.text,
      ...query.values
    );
    count = result[0]?.count ?? 0;
  }
  if (spec.operation !== 'select')
    await validateReferences(tx, spec, context, worker);
  const query =
    spec.operation === 'select'
      ? compileSelect(
          {
            ...spec,
            limit: spec.cardinality ? Math.min(spec.limit ?? 2, 2) : spec.limit,
          },
          context,
          browser
        )
      : compileMutation(spec, context, browser);
  const raw = await tx.$queryRawUnsafe<{ result: Row }[]>(
    query.text,
    ...query.values
  );
  if (spec.count && spec.operation !== 'select') count = raw.length;
  return shapeResult(
    raw.map((row) => row.result),
    spec,
    count
  );
}
export async function executeQuery(
  spec: QuerySpec,
  context: TenantContext,
  browser = false,
  worker = false
): Promise<QueryResult<LegacyData>> {
  try {
    return await withTenant(
      context,
      (tx) =>
        executeInTransaction(
          tx as unknown as SqlTransaction,
          spec,
          context,
          browser,
          worker
        ),
      worker ? getWorkerPrisma() : undefined
    );
  } catch (error) {
    return { data: null, error: dataError(error) };
  }
}
