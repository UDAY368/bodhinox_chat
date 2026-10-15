import {
  columnFor,
  ContractError,
  getResource,
  resources,
  validateFilter,
  jsonTextFilter,
  type Column,
  type Resource,
} from '@/lib/data/contracts';
import type { Filter, QuerySpec, TenantContext } from '@/lib/data/types';

export interface CompiledQuery {
  text: string;
  values: unknown[];
}
interface Relation {
  target: Resource;
  sourceField: string;
  targetField: string;
  many: boolean;
}
interface Projection {
  field?: string;
  alias?: string;
  relation?: string;
  inner?: boolean;
  children?: Projection[];
}
const identifier = (value: string) => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value))
    throw new ContractError('Invalid identifier');
  return `"${value}"`;
};
function split(value: string): string[] {
  const out: string[] = [];
  let depth = 0,
    start = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '(') depth++;
    if (value[i] === ')') depth--;
    if (depth < 0 || depth > 6) throw new ContractError('Invalid nested query');
    if (value[i] === ',' && depth === 0) {
      out.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (depth !== 0) throw new ContractError('Unbalanced query');
  out.push(value.slice(start).trim());
  return out;
}
function projections(value: string): Projection[] {
  return split(value).map((token) => {
    const nested = token.indexOf('(');
    if (nested < 0) return { field: token };
    if (!token.endsWith(')'))
      throw new ContractError('Invalid relation projection');
    const head = token.slice(0, nested);
    const colon = head.indexOf(':');
    const alias = colon < 0 ? undefined : head.slice(0, colon);
    if (alias) identifier(alias);
    const relationship = colon < 0 ? head : head.slice(colon + 1);
    const [relation, ...modifiers] = relationship.split('!');
    identifier(relation);
    return {
      alias,
      relation,
      inner: modifiers.includes('inner'),
      children: projections(token.slice(nested + 1, -1)),
    };
  });
}
function relation(source: Resource, targetName: string): Relation {
  const target = getResource(targetName);
  const preferred: Record<string, string> = {
    'deals:profiles': 'assigned_to',
    'deals:pipeline_stages': 'stage_id',
    'conversations:profiles': 'assigned_agent_id',
    'contact_notes:profiles': 'user_id',
    'automation_logs:contacts': 'contact_id',
  };
  const choice = preferred[`${source.table}:${targetName}`];
  const forward = source.columns.filter(
    (c) =>
      c.reference?.table.replace(/^public\./, '') === targetName ||
      c.name === choice
  );
  const field = choice
    ? forward.find((c) => c.name === choice)
    : forward.length === 1
      ? forward[0]
      : undefined;
  if (field)
    return {
      target,
      sourceField: field.name,
      targetField:
        field.reference?.column ??
        (targetName === 'profiles' && field.name === 'user_id'
          ? 'user_id'
          : 'id'),
      many: false,
    };
  const backward = target.columns.filter(
    (c) => c.reference?.table.replace(/^public\./, '') === source.table
  );
  if (backward.length === 1)
    return {
      target,
      sourceField: backward[0].reference!.column,
      targetField: backward[0].name,
      many: true,
    };
  throw new ContractError(
    `Unsupported relationship ${source.table} -> ${targetName}`,
    'UNSUPPORTED_QUERY'
  );
}
const conflicts: Record<string, string[]> = {
  contact_tags: ['contact_id,tag_id'],
  contact_custom_values: ['contact_id,custom_field_id'],
  messages: ['conversation_id,message_id'],
  message_reactions: ['message_id,actor_type,actor_id'],
  message_templates: ['user_id,name,language', 'account_id,name,language'],
  member_presence: ['user_id'],
};
class Compiler {
  values: unknown[] = [];
  nextAlias = 0;
  constructor(
    readonly context: TenantContext,
    readonly browser: boolean
  ) {}
  parameter(value: unknown, column?: Column): string {
    const index = this.values.push(
      column?.type.toLowerCase().includes('json')
        ? JSON.stringify(value)
        : Array.isArray(value)
          ? JSON.stringify(value)
          : value
    );
    const type = column?.type.toLowerCase();
    if (Array.isArray(value) && type?.endsWith('[]')) {
      const element = type.includes('uuid')
        ? 'uuid'
        : type.includes('jsonb')
          ? 'jsonb'
          : 'text';
      return `ARRAY(SELECT ${element === 'jsonb' ? 'value' : `value::${element}`} FROM ${element === 'jsonb' ? 'jsonb_array_elements' : 'jsonb_array_elements_text'}($${index}::jsonb))`;
    }
    const cast = type?.includes('json')
      ? 'jsonb'
      : type?.includes('uuid')
        ? 'uuid'
        : type?.includes('timestamp') || type === 'timestamptz'
          ? 'timestamptz'
          : type === 'date'
            ? 'date'
            : type?.includes('bool')
              ? 'boolean'
              : type?.includes('int')
                ? 'bigint'
                : type && /^(numeric|decimal|real|double)/.test(type)
                  ? 'numeric'
                  : type?.startsWith('vector(')
                    ? 'vector'
                    : undefined;
    return `$${index}${cast ? `::${cast}` : ''}`;
  }
  scope(resource: Resource, alias: string): string {
    if (resource.table === 'accounts')
      return `${alias}."id" = ${this.parameter(this.context.accountId, { name: 'id', type: 'UUID' })}`;
    if (resource.table === 'profiles')
      return `EXISTS (SELECT 1 FROM account_memberships membership WHERE membership.user_id = ${alias}.user_id AND membership.account_id = ${this.parameter(this.context.accountId, { name: 'account_id', type: 'UUID' })})`;
    columnFor(resource, 'account_id');
    return `${alias}."account_id" = ${this.parameter(this.context.accountId, { name: 'account_id', type: 'UUID' })}`;
  }
  field(resource: Resource, alias: string, name: string): string {
    columnFor(resource, name);
    if (this.browser && !resource.read.includes(name))
      throw new ContractError('Unavailable projection field');
    if (resource.table === 'profiles' && name === 'account_role')
      return `(SELECT role FROM account_memberships membership WHERE membership.user_id = ${alias}.user_id AND membership.account_id = ${this.parameter(this.context.accountId, { name: 'account_id', type: 'UUID' })})`;
    if (resource.table === 'profiles' && name === 'account_id')
      return this.parameter(this.context.accountId, {
        name: 'account_id',
        type: 'UUID',
      });
    if (
      resource.table === 'profiles' &&
      name === 'email' &&
      ['agent', 'viewer'].includes(this.context.role ?? 'viewer')
    )
      return `CASE WHEN ${alias}.user_id = ${this.parameter(this.context.userId ?? null, { name: 'user_id', type: 'UUID' })} THEN ${alias}.email ELSE NULL END`;
    return `${alias}.${identifier(name)}`;
  }
  projection(resource: Resource, alias: string, nodes: Projection[]): string {
    const entries: string[] = [];
    for (const node of nodes) {
      if (node.field) {
        const fields =
          node.field === '*'
            ? this.browser
              ? resource.read
              : resource.columns.map((c) => c.name)
            : [node.field];
        for (const field of fields) {
          identifier(field);
          entries.push(
            `'${field}', to_jsonb(${this.field(resource, alias, field)})`
          );
        }
      } else {
        const link = relation(resource, node.relation!);
        if (this.browser && !link.target.browser)
          throw new ContractError('Unavailable nested resource');
        const related = `r${++this.nextAlias}`;
        const object = this.projection(link.target, related, node.children!);
        const where = `${related}.${identifier(link.targetField)} = ${alias}.${identifier(link.sourceField)} AND ${this.scope(link.target, related)}`;
        const nested = link.many
          ? `COALESCE((SELECT jsonb_agg(${object}) FROM ${identifier(link.target.table)} ${related} WHERE ${where}), '[]'::jsonb)`
          : `(SELECT ${object} FROM ${identifier(link.target.table)} ${related} WHERE ${where} LIMIT 1)`;
        entries.push(`'${node.alias ?? node.relation}', ${nested}`);
      }
    }
    // PostgreSQL functions have a 100-argument limit; merge objects in bounded groups.
    const parts = [];
    for (let i = 0; i < entries.length; i += 40)
      parts.push(`jsonb_build_object(${entries.slice(i, i + 40).join(', ')})`);
    return parts.join(' || ') || `'{}'::jsonb`;
  }
  filter(resource: Resource, alias: string, filter: Filter): string {
    validateFilter(resource, filter, this.context, this.browser);
    if (filter.field.includes('.')) {
      const [table, field] = filter.field.split('.');
      const link = relation(resource, table);
      const related = `r${++this.nextAlias}`;
      return `EXISTS (SELECT 1 FROM ${identifier(link.target.table)} ${related} WHERE ${related}.${identifier(link.targetField)} = ${alias}.${identifier(link.sourceField)} AND ${this.scope(link.target, related)} AND ${this.filter(link.target, related, { ...filter, field })})`;
    }
    const json = jsonTextFilter(resource, filter.field);
    const column = json
      ? { name: json.column.name, type: 'text' }
      : columnFor(resource, filter.field);
    const field = json
      ? `(${this.field(resource, alias, json.column.name)} ->> ${this.parameter(json.key)})`
      : this.field(resource, alias, filter.field);
    if (filter.op === 'is')
      return `${field} IS ${filter.value === null ? 'NULL' : filter.value ? 'TRUE' : 'FALSE'}`;
    if (filter.value === null && ['eq', 'neq'].includes(filter.op))
      return `${field} IS ${filter.op === 'neq' ? 'NOT ' : ''}NULL`;
    if (filter.op === 'in') {
      const values = filter.value as unknown[];
      return values.length
        ? `${field} IN (${values.map((v) => this.parameter(v, column)).join(',')})`
        : 'FALSE';
    }
    const operators = {
      eq: '=',
      neq: '<>',
      gt: '>',
      gte: '>=',
      lt: '<',
      lte: '<=',
      ilike: 'ILIKE',
      like: 'LIKE',
      contains: '@>',
    };
    const value =
      ['ilike', 'like'].includes(filter.op) && typeof filter.value === 'string'
        ? filter.value.replaceAll('*', '%')
        : filter.value;
    return `${field} ${operators[filter.op as keyof typeof operators]} ${this.parameter(value, column)}`;
  }
  expression(
    resource: Resource,
    alias: string,
    input: string,
    depth = 0
  ): string {
    if (depth > 5) throw new ContractError('Filter nesting too deep');
    return `(${split(input)
      .map((token) => {
        if (token.startsWith('and(') && token.endsWith(')'))
          return `(${split(token.slice(4, -1))
            .map((part) => this.expression(resource, alias, part, depth + 1))
            .join(' AND ')})`;
        const match =
          /^([a-z_][a-z0-9_]*)\.(eq|neq|gt|gte|lt|lte|is|ilike|like)\.(.*)$/i.exec(
            token
          );
        if (!match)
          throw new ContractError(
            'Unsupported OR expression',
            'UNSUPPORTED_QUERY'
          );
        let value: unknown = match[3];
        if (match[2] === 'is')
          value =
            value === 'null'
              ? null
              : value === 'true'
                ? true
                : value === 'false'
                  ? false
                  : value;
        return this.filter(resource, alias, {
          field: match[1],
          op: match[2] as Filter['op'],
          value,
        });
      })
      .join(' OR ')})`;
  }
  conditions(resource: Resource, alias: string, spec: QuerySpec): string {
    const conditions = [
      this.scope(resource, alias),
      ...spec.filters.map((f) => this.filter(resource, alias, f)),
      ...(spec.or ?? []).map((s) => this.expression(resource, alias, s)),
    ];
    if (resource.table === 'notifications' && this.context.userId)
      conditions.push(
        `${alias}.user_id = ${this.parameter(this.context.userId, { name: 'user_id', type: 'UUID' })}`
      );
    for (const node of projections(spec.projection ?? '*'))
      if (node.inner) {
        const link = relation(resource, node.relation!);
        const related = `r${++this.nextAlias}`;
        conditions.push(
          `EXISTS (SELECT 1 FROM ${identifier(link.target.table)} ${related} WHERE ${related}.${identifier(link.targetField)} = ${alias}.${identifier(link.sourceField)} AND ${this.scope(link.target, related)})`
        );
      }
    return conditions.join(' AND ');
  }
}
export function compileSelect(
  spec: QuerySpec,
  context: TenantContext,
  browser = false,
  count = false
): CompiledQuery {
  const c = new Compiler(context, browser);
  const resource = getResource(spec.resource, browser);
  const object = count
    ? 'COUNT(*)::int AS count'
    : `${c.projection(resource, 't', projections(spec.projection ?? '*'))} AS result`;
  let text = `SELECT ${object} FROM ${identifier(resource.table)} t WHERE ${c.conditions(resource, 't', spec)}`;
  if (!count) {
    if (spec.orders?.length)
      text += ` ORDER BY ${spec.orders.map((o) => `${c.field(resource, 't', o.field)} ${o.ascending ? 'ASC' : 'DESC'}${o.nullsFirst === undefined ? '' : o.nullsFirst ? ' NULLS FIRST' : ' NULLS LAST'}`).join(',')}`;
    text += ` LIMIT ${c.parameter(spec.limit ?? 1000)} OFFSET ${c.parameter(spec.offset ?? 0)}`;
  }
  return { text, values: c.values };
}
export function compileMutation(
  spec: QuerySpec,
  context: TenantContext,
  browser = false
): CompiledQuery {
  const c = new Compiler(context, browser);
  const resource = getResource(spec.resource, browser);
  let statement: string;
  if (spec.operation === 'delete')
    statement = `DELETE FROM ${identifier(resource.table)} t WHERE ${c.conditions(resource, 't', spec)} RETURNING *`;
  else if (spec.operation === 'update') {
    const row = spec.values as Record<string, unknown>;
    statement = `UPDATE ${identifier(resource.table)} t SET ${Object.entries(
      row
    )
      .filter(([key]) => key !== 'account_id')
      .map(
        ([key, value]) =>
          `${identifier(key)} = ${c.parameter(value, columnFor(resource, key))}`
      )
      .join(',')} WHERE ${c.conditions(resource, 't', spec)} RETURNING *`;
  } else {
    const rows = (
      Array.isArray(spec.values) ? spec.values : [spec.values!]
    ).map((row) => ({
      ...row,
      ...(resource.columns.some((c) => c.name === 'account_id')
        ? { account_id: context.accountId }
        : {}),
      ...(resource.columns.some((c) => c.name === 'user_id') &&
      context.userId &&
      !row.user_id
        ? { user_id: context.userId }
        : {}),
    }));
    const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    keys.forEach((key) => columnFor(resource, key));
    statement = `INSERT INTO ${identifier(resource.table)} (${keys.map(identifier).join(',')}) VALUES ${rows.map((row) => `(${keys.map((key) => (Object.hasOwn(row, key) ? c.parameter(row[key], columnFor(resource, key)) : 'DEFAULT')).join(',')})`).join(',')}`;
    if (spec.operation === 'upsert') {
      const conflict = (
        resource.table === 'message_templates' &&
        spec.onConflict === 'user_id,name,language'
          ? 'account_id,name,language'
          : (spec.onConflict ?? 'id')
      )
        .split(',')
        .map((k) => k.trim());
      conflict.forEach((key) => columnFor(resource, key));
      if (
        conflict.join(',') !== 'id' &&
        !conflict.includes('account_id') &&
        !(conflicts[resource.table] ?? []).includes(conflict.join(','))
      )
        throw new ContractError('Unsupported conflict key');
      const updates = keys.filter(
        (key) => !conflict.includes(key) && key !== 'account_id' && key !== 'id'
      );
      statement += ` ON CONFLICT (${conflict.map(identifier).join(',')}) ${spec.ignoreDuplicates || !updates.length ? 'DO NOTHING' : `DO UPDATE SET ${updates.map((key) => `${identifier(key)} = EXCLUDED.${identifier(key)}`).join(',')}`}`;
    }
    statement += ' RETURNING *';
  }
  const text = `WITH changed AS (${statement}) SELECT ${c.projection(resource, 't', projections(spec.projection ?? '*'))} AS result FROM changed t`;
  return { text, values: c.values };
}
export function resourceReferences(name: string) {
  return getResource(name).columns.filter(
    (c) =>
      c.reference &&
      Object.hasOwn(resources, c.reference.table.replace(/^public\./, ''))
  );
}
