import { requireSession, assertMutation } from '@/lib/auth/session';
import { ContractError, resourceBySlug } from '@/lib/data/contracts';
import { decodeQuery } from '@/lib/data/transport';
import { readJsonBody } from '@/lib/data/body';
import { executeQuery } from '@/lib/repositories/crm';
import type { Row } from '@/lib/data/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
async function handle(
  request: Request,
  { params }: { params: Promise<{ resource: string }> }
): Promise<Response> {
  try {
    const context = await requireSession(request);
    const resource = resourceBySlug((await params).resource);
    let values: Row | Row[] | undefined;
    if (request.method !== 'GET') {
      await assertMutation(request, context);
      if (['POST', 'PUT', 'PATCH'].includes(request.method))
        values = (await readJsonBody(request)) as Row | Row[];
    }
    const spec = decodeQuery(request, resource.table, values);
    const result = await executeQuery(spec, context, true);
    const status = result.error
      ? result.error.code === 'FORBIDDEN' ||
        result.error.code === 'TENANT_MISMATCH' ||
        result.error.code === 'RELATED_RECORD_FORBIDDEN'
        ? 403
        : result.error.code === 'DATABASE_ERROR'
          ? 500
          : result.error.code === 'plan_limit'
            ? 402
            : 400
      : 200;
    return Response.json(result, {
      status,
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    const status =
      error instanceof ContractError
        ? error.status
        : typeof (error as { status?: number })?.status === 'number'
          ? (error as { status: number }).status
          : 500;
    return Response.json(
      {
        data: null,
        error: {
          message:
            status === 500
              ? 'Data request failed'
              : error instanceof Error
                ? error.message
                : 'Authentication required',
          code:
            error instanceof ContractError
              ? error.code
              : status === 401
                ? 'UNAUTHENTICATED'
                : 'REQUEST_ERROR',
        },
      },
      { status, headers: { 'cache-control': 'no-store' } }
    );
  }
}
export {
  handle as GET,
  handle as POST,
  handle as PUT,
  handle as PATCH,
  handle as DELETE,
};
