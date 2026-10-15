import { requireSession, assertMutation } from '@/lib/auth/session';
import { ContractError } from '@/lib/data/contracts';
import { rpcContracts } from '@/lib/repositories/rpc-contracts';
import { executeRpc } from '@/lib/repositories/rpc';
import { readJsonBody } from '@/lib/data/body';
import type { Row } from '@/lib/data/types';
export async function POST(
  request: Request,
  { params }: { params: Promise<{ operation: string }> }
): Promise<Response> {
  try {
    const context = await requireSession(request);
    await assertMutation(request, context);
    const slug = (await params).operation;
    const entry = Object.entries(rpcContracts).find(
      ([, contract]) => contract.slug === slug && contract.browser
    );
    if (!entry)
      throw new ContractError('Unknown CRM operation', 'UNSUPPORTED_RPC', 404);
    const args = (await readJsonBody(request, 65536)) as Row;
    const result = await executeRpc(entry[0], args, context, true);
    return Response.json(result, {
      status: result.error
        ? result.error.code === 'RECORD_NOT_FOUND'
          ? 404
          : result.error.code === 'FORBIDDEN' ||
              result.error.code === 'TENANT_MISMATCH'
            ? 403
            : 400
        : 200,
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    const status =
      error instanceof ContractError
        ? error.status
        : ((error as { status?: number })?.status ?? 500);
    return Response.json(
      {
        data: null,
        error: {
          message:
            status === 500
              ? 'Operation failed'
              : error instanceof Error
                ? error.message
                : 'Operation rejected',
        },
      },
      { status, headers: { 'cache-control': 'no-store' } }
    );
  }
}
