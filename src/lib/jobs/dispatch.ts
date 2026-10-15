import { withTenant } from '@/lib/db/tenant';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
export class UncertainDispatchError extends Error { constructor() { super('Provider outcome needs reconciliation before another send'); this.name = 'UncertainDispatchError'; } }

/** A persisted send intent prevents automatic retry after a crash or ambiguous provider timeout. */
export async function dispatchOnce<T>(accountId: string, key: string, send: () => Promise<T>,
  options: { retryRejected?: boolean } = {}): Promise<T> {
  const context = { accountId, role: 'owner' as const };
  const idempotencyKey = `${accountId}:${key}`;
  const claim = await withTenant(context, tx => tx.$queryRaw<{ id: string }[]>`
    INSERT INTO outbound_intents(account_id,idempotency_key,status) VALUES(${accountId}::uuid,${idempotencyKey},'dispatching')
    ON CONFLICT(idempotency_key) DO UPDATE SET status='dispatching',last_error=NULL,updated_at=NOW()
      WHERE outbound_intents.status='failed' AND ${options.retryRejected === true}
    RETURNING id`, getWorkerPrisma());
  if (!claim.length) {
    const existing = await withTenant(context, tx => tx.$queryRaw<{ status: string; result: T }[]>`SELECT status,result FROM outbound_intents WHERE account_id=${accountId}::uuid AND idempotency_key=${idempotencyKey}`, getWorkerPrisma());
    if (existing[0]?.status === 'accepted') return existing[0].result;
    throw new UncertainDispatchError();
  }
  try {
    const result = await send();
    await withTenant(context, tx => tx.$executeRaw`UPDATE outbound_intents SET status='accepted',result=${JSON.stringify(result)}::jsonb,updated_at=NOW() WHERE id=${claim[0].id}::uuid`, getWorkerPrisma());
    return result;
  } catch (error) {
    const rejected = error instanceof MetaApiError && error.httpStatus >= 400 && error.httpStatus < 500;
    await withTenant(context, tx => tx.$executeRaw`UPDATE outbound_intents SET status=${rejected ? 'failed' : 'unknown'},last_error=${rejected ? 'Provider rejected the request' : 'Provider outcome uncertain'},updated_at=NOW() WHERE id=${claim[0].id}::uuid`, getWorkerPrisma());
    if (!rejected) throw new UncertainDispatchError();
    throw error;
  }
}
