import { rpcContracts } from '@/lib/repositories/rpc-contracts';
import type { QueryResult, Row, LegacyData } from './types';
export async function browserRpc(
  name: string,
  args: Row,
  fetcher: (url: string, init: RequestInit) => Promise<Response>
): Promise<QueryResult<LegacyData>> {
  const contract = Object.hasOwn(rpcContracts, name)
    ? rpcContracts[name]
    : undefined;
  if (!contract?.browser)
    return {
      data: null,
      error: {
        message: 'Unsupported browser operation',
        code: 'UNSUPPORTED_RPC',
      },
    };
  const response = await fetcher(`/api/crm/actions/${contract.slug}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
    cache: 'no-store',
  });
  try {
    return await response.json();
  } catch {
    return {
      data: null,
      error: { message: 'Invalid operation response', code: 'TRANSPORT_ERROR' },
    };
  }
}
