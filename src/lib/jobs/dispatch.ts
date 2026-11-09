import { withTenant } from '@/lib/db/tenant';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { NoNumberError } from '@/lib/whatsapp/numbers';
import { assertLiveEffects } from '@/lib/runtime/dry-run-guard';
export class UncertainDispatchError extends Error { constructor() { super('Provider outcome needs reconciliation before another send'); this.name = 'UncertainDispatchError'; } }
/**
 * Thrown by a checkpointed stage that failed before it could have sent or queued anything (a pure
 * read failed). The stage's checkpoint is released and the job retries normally, instead of the
 * failure being treated as an uncertain dispatch. Never throw it after a send may have happened.
 */
export class NotDispatchedError extends Error { constructor(message: string) { super(message); this.name = 'NotDispatchedError'; } }

/**
 * Errors that are always raised before any provider call: a number or
 * conversation the send cannot use (NoNumberError, including an Instagram
 * conversation on a WhatsApp path) and an Instagram request refused by its
 * local input checks. Nothing reached the provider, so the intent is 'failed'
 * (never retried automatically; a later attempt without retryRejected still
 * reports it as uncertain) rather than 'unknown'.
 */
function refusedBeforeProvider(error: unknown): boolean {
  // By name: importing lib/instagram/graph here would pull the Graph clients into every sender's module graph.
  return error instanceof NoNumberError || (error instanceof Error && error.name === 'InstagramGraphInputError');
}

/** A persisted send intent prevents automatic retry after a crash or ambiguous provider timeout. */
export async function dispatchOnce<T>(accountId: string, key: string, send: () => Promise<T>,
  options: { retryRejected?: boolean } = {}): Promise<T> {
  // Before the intent is claimed: a dry run neither records nor sends anything.
  assertLiveEffects('dispatch');
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
    const rejected = (error instanceof MetaApiError && error.httpStatus >= 400 && error.httpStatus < 500) || refusedBeforeProvider(error);
    await withTenant(context, tx => tx.$executeRaw`UPDATE outbound_intents SET status=${rejected ? 'failed' : 'unknown'},last_error=${rejected ? (refusedBeforeProvider(error) ? 'Refused before sending' : 'Provider rejected the request') : 'Provider outcome uncertain'},updated_at=NOW() WHERE id=${claim[0].id}::uuid`, getWorkerPrisma());
    if (!rejected) throw new UncertainDispatchError();
    throw error;
  }
}
