// Job router for click-to-WhatsApp ads. Handlers are lazy-imported so the
// worker loads Meta ads code only for its own jobs. Every tenant job runs
// inside withJobScope (src/lib/jobs/handlers.ts), so Graph calls go through
// leaseFetch and must never run inside an open database transaction.
import { getWorkerPrisma } from '@/lib/db/prisma';
import { PAGE_WEBHOOK_PROVIDER } from './leads';

export const META_ADS_JOB_TYPES = [
  'meta.page_webhook',
  'meta.leadgen_fetch',
  'meta.leads_sync',
  'meta.insights_sync',
  'meta.capi_event',
] as const;
export type MetaAdsJobType = (typeof META_ADS_JOB_TYPES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isMetaAdsJob(type: string): boolean {
  return type.startsWith('meta.');
}

/**
 * meta.page_webhook carries no tenant: load the receipt, skip it when it was
 * already processed, hand the payload to the leads handler (which resolves
 * each Page to its workspace), then mark it processed.
 */
export async function handleMetaPageWebhookJob(payload: Record<string, unknown>, assertLease: () => void = () => {}): Promise<void> {
  const receiptId = payload.receiptId;
  if (typeof receiptId !== 'string' || !UUID.test(receiptId)) throw new Error('Invalid job identifier');
  const prisma = getWorkerPrisma();
  const rows = await prisma.$queryRaw<{ payload: unknown; status: string }[]>`
    SELECT payload, status FROM webhook_receipts WHERE id=${receiptId}::uuid AND provider=${PAGE_WEBHOOK_PROVIDER}`;
  if (!rows[0] || rows[0].status === 'processed') return;
  assertLease();
  await (await import('./leads')).handlePageWebhookJob(rows[0].payload);
  assertLease();
  await prisma.$executeRaw`UPDATE webhook_receipts SET status='processed' WHERE id=${receiptId}::uuid`;
}

/** Tenant-scoped meta.* jobs. */
export async function handleMetaAdsJob(accountId: string, type: string, payload: Record<string, unknown>,
  attempt?: { attempts: number; maxAttempts: number }): Promise<void> {
  if (payload.accountId !== undefined && payload.accountId !== accountId) throw new Error('Meta ads job tenant mismatch');
  switch (type) {
    case 'meta.leadgen_fetch':
      return (await import('./leads')).handleLeadgenFetchJob(accountId, payload);
    case 'meta.leads_sync':
      return (await import('./leads')).handleLeadsSyncJob(accountId, payload);
    case 'meta.insights_sync':
      return (await import('./insights')).handleInsightsSyncJob(accountId, payload);
    case 'meta.capi_event':
      return (await import('./capi')).handleCapiEventJob(accountId, payload, attempt);
    default:
      // meta.page_webhook is routed before the tenant scope (handleMetaPageWebhookJob).
      throw new Error('Unsupported job type');
  }
}
