// Instagram webhook persistence (Phase 11). One worker transaction stores the
// verified raw delivery as a webhook receipt (provider 'meta_instagram',
// dedupe_key 'meta_instagram:'+sha256(raw)) and the pre-scope job
// instagram.webhook (dedupe 'igwebhook:<receiptId>'), like persistPageWebhook
// (src/lib/meta-ads/leads.ts). The route calls it only while Instagram is on;
// a redelivery of the same bytes reuses the receipt and queues nothing new.
import { createHash } from 'node:crypto';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { LONG_RETRY_ATTEMPTS } from '@/lib/jobs/retry';
import { INSTAGRAM_WEBHOOK_JOB } from './jobs';

export const INSTAGRAM_WEBHOOK_PROVIDER = 'meta_instagram';
const MAX_WEBHOOK_BYTES = 2 * 1024 * 1024;

/** Returns the receipt id. */
export async function persistInstagramWebhook(rawBody: string, payload: Record<string, unknown>): Promise<string> {
  if (Buffer.byteLength(rawBody) > MAX_WEBHOOK_BYTES) throw new Error('Webhook exceeds size limit');
  const dedupeKey = `${INSTAGRAM_WEBHOOK_PROVIDER}:${createHash('sha256').update(rawBody).digest('hex')}`;
  return getWorkerPrisma().$transaction(async (tx) => {
    const receipt = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO webhook_receipts(provider,dedupe_key,payload)
      VALUES(${INSTAGRAM_WEBHOOK_PROVIDER},${dedupeKey},${JSON.stringify(payload)}::jsonb)
      ON CONFLICT(dedupe_key) DO UPDATE SET dedupe_key=EXCLUDED.dedupe_key RETURNING id::text AS id`;
    const id = receipt[0].id;
    await tx.$executeRaw`INSERT INTO jobs(type,payload,dedupe_key,max_attempts)
      VALUES(${INSTAGRAM_WEBHOOK_JOB},${JSON.stringify({ receiptId: id })}::jsonb,${`igwebhook:${id}`},${LONG_RETRY_ATTEMPTS})
      ON CONFLICT(dedupe_key) DO NOTHING`;
    return id;
  });
}
