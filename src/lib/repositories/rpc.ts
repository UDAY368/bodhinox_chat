import { Prisma } from '@prisma/client';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { ContractError } from '@/lib/data/contracts';
import type {
  QueryResult,
  Row,
  TenantContext,
  LegacyData,
} from '@/lib/data/types';
import { validateRpc } from './rpc-contracts';
import { executeMembershipRpc } from './memberships';
import { dataError } from '@/lib/data/errors';
import {
  loadPhoneMask,
  maskContactRow,
  maskedPhoneSearchSql,
} from '@/lib/inbox/masking-apply';

/**
 * filter_contacts_by_tags for a member whose numbers are masked: the same
 * page and order, but a phone search matches only a number's last digits and
 * every returned number is masked.
 */
async function maskedContactsByTags(
  tx: TenantTransaction,
  accountId: string,
  args: Row
): Promise<Row[]> {
  const search: string | null = args.p_search ?? null;
  const term = search
    ? Prisma.sql`AND (c.name ILIKE ${`%${search}%`} OR ${maskedPhoneSearchSql(Prisma.sql`c.phone`, search)} OR c.email ILIKE ${`%${search}%`})`
    : Prisma.empty;
  const rows = await tx.$queryRaw<{ result: Row }[]>(Prisma.sql`
    WITH matched AS (
      SELECT DISTINCT c.id, c.created_at FROM contacts c
      JOIN contact_tags ct ON ct.contact_id = c.id AND ct.account_id = c.account_id
      WHERE c.account_id = ${accountId}::uuid
        AND ct.tag_id IN (SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(args.p_tag_ids ?? [])}::jsonb))
        ${term}
    ), page AS (
      SELECT id, count(*) OVER() AS total_count FROM matched
      ORDER BY created_at DESC, id LIMIT ${args.p_limit}::int OFFSET ${args.p_offset}::int
    )
    SELECT jsonb_build_object('contact', to_jsonb(c), 'total_count', page.total_count) AS result
    FROM page JOIN contacts c ON c.id = page.id AND c.account_id = ${accountId}::uuid
    ORDER BY c.created_at DESC, c.id`);
  return rows.map(({ result }) => ({
    ...result,
    contact: maskContactRow(result.contact, true),
  }));
}

export async function executeRpc<T = LegacyData>(
  name: string,
  input: Row,
  context: TenantContext,
  browser = false,
  worker = false
): Promise<QueryResult<T>> {
  try {
    if (
      [
        'set_member_role',
        'remove_account_member',
        'transfer_account_ownership',
        'peek_invitation',
        'redeem_invitation',
      ].includes(name)
    ) {
      if (browser)
        throw new ContractError(
          'Operation requires its account endpoint',
          'UNSUPPORTED_RPC',
          404
        );
      return (await executeMembershipRpc(
        name,
        input,
        context
      )) as QueryResult<T>;
    }
    const { contract, args } = validateRpc(name, input, context, browser);
    return await withTenant(
      context,
      async (tx) => {
        if (
          name === 'mark_conversation_read' ||
          name === 'set_media_retention'
        ) {
          // Fixed actions intentionally expose no arbitrary counter/settings writes.
          const rows =
            name === 'mark_conversation_read'
              ? await tx.$queryRawUnsafe<{ id: string }[]>(
                  'UPDATE conversations SET unread_count=0,updated_at=NOW() WHERE account_id=$1::uuid AND id=$2::uuid RETURNING id',
                  context.accountId,
                  args.p_conversation_id
                )
              : await tx.$queryRawUnsafe<{ id: string }[]>(
                  'UPDATE whatsapp_config SET mirror_inbound_media=$2::boolean,updated_at=NOW() WHERE account_id=$1::uuid RETURNING id',
                  context.accountId,
                  args.p_enabled
                );
          if (!rows.length)
            throw new ContractError(
              'Record is unavailable in this organization',
              'RECORD_NOT_FOUND',
              404
            );
          return { data: null, error: null };
        }
        if (
          browser &&
          name === 'filter_contacts_by_tags' &&
          (await loadPhoneMask(tx, context))
        )
          return {
            data: (await maskedContactsByTags(tx, context.accountId, args)) as T,
            error: null,
          };
        const values: unknown[] = [];
        const parameters = Object.entries(contract.args).map(
          ([key, column]) => {
            const value = args[key];
            values.push(
              column.type.endsWith('[]') ? JSON.stringify(value ?? []) : value
            );
            const slot = `$${values.length}`;
            if (column.type.endsWith('[]')) {
              const element = column.type.slice(0, -2);
              return `ARRAY(SELECT ${element === 'jsonb' ? 'value' : `value::${element}`} FROM ${element === 'jsonb' ? 'jsonb_array_elements' : 'jsonb_array_elements_text'}(${slot}::jsonb))`;
            }
            return `${slot}::${column.type}`;
          }
        );
        const call = `public.${name}(${parameters.join(',')})`;
        if (contract.returnsVoid) {
          // PostgreSQL void has no Prisma-deserializable value. Execute the
          // fixed, parameterized function without decoding its result column.
          await tx.$executeRawUnsafe(`SELECT ${call}`, ...values);
          return { data: null, error: null };
        }
        const sql = contract.scalar
          ? `SELECT ${call} AS result`
          : `SELECT to_jsonb(result) AS result FROM ${call} result`;
        const result = await tx.$queryRawUnsafe<{ result: LegacyData }[]>(
          sql,
          ...values
        );
        return {
          data: (contract.scalar
            ? (result[0]?.result ?? null)
            : result.map((row) => row.result)) as T,
          error: null,
        };
      },
      worker ? getWorkerPrisma() : undefined
    );
  } catch (error) {
    return {
      data: null,
      error: {
        ...dataError(error),
      },
    };
  }
}
