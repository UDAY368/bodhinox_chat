import { withTenant } from '@/lib/db/tenant';
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
