import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ queryRaw: vi.fn(), executeRaw: vi.fn() }));
const handlers = vi.hoisted(() => ({
  page: vi.fn(), fetch: vi.fn(), sync: vi.fn(), insights: vi.fn(), capi: vi.fn(), objects: vi.fn(), change: vi.fn(),
}));
vi.mock('@/lib/db/prisma', () => ({
  getWorkerPrisma: () => ({
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => db.queryRaw(strings.join('?'), values),
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => db.executeRaw(strings.join('?'), values),
  }),
}));
vi.mock('./leads', () => ({
  PAGE_WEBHOOK_PROVIDER: 'meta_page',
  handlePageWebhookJob: handlers.page,
  handleLeadgenFetchJob: handlers.fetch,
  handleLeadsSyncJob: handlers.sync,
}));
vi.mock('./insights', () => ({ handleInsightsSyncJob: handlers.insights }));
vi.mock('./capi', () => ({ handleCapiEventJob: handlers.capi }));
vi.mock('./manage', () => ({ handleAdObjectsSyncJob: handlers.objects, handleAdChangeJob: handlers.change }));
import { handleMetaAdsJob, handleMetaPageWebhookJob, isMetaAdsJob } from './jobs';

const ACCOUNT = '6f1c2d3e-0000-4000-8000-0000000000aa';
const RECEIPT = '6f1c2d3e-0000-4000-8000-0000000000dd';

beforeEach(() => vi.clearAllMocks());

describe('meta ads job router', () => {
  it('routes each tenant job type to its handler', async () => {
    await handleMetaAdsJob(ACCOUNT, 'meta.leadgen_fetch', { leadId: 'x' });
    await handleMetaAdsJob(ACCOUNT, 'meta.leads_sync', {});
    await handleMetaAdsJob(ACCOUNT, 'meta.insights_sync', {});
    await handleMetaAdsJob(ACCOUNT, 'meta.capi_event', { capiEventId: 'e' }, { attempts: 2, maxAttempts: 5 });
    await handleMetaAdsJob(ACCOUNT, 'meta.ad_objects_sync', {});
    await handleMetaAdsJob(ACCOUNT, 'meta.ad_change', { changeId: 'c' }, { attempts: 1, maxAttempts: 4 });
    expect(handlers.objects).toHaveBeenCalledWith(ACCOUNT);
    expect(handlers.change).toHaveBeenCalledWith(ACCOUNT, { changeId: 'c' }, { attempts: 1, maxAttempts: 4 });
    expect(handlers.fetch).toHaveBeenCalledWith(ACCOUNT, { leadId: 'x' });
    expect(handlers.sync).toHaveBeenCalledWith(ACCOUNT, {});
    expect(handlers.insights).toHaveBeenCalledWith(ACCOUNT, {});
    expect(handlers.capi).toHaveBeenCalledWith(ACCOUNT, { capiEventId: 'e' }, { attempts: 2, maxAttempts: 5 });
  });

  it('rejects unknown types, the account-less webhook type and a tenant mismatch', async () => {
    await expect(handleMetaAdsJob(ACCOUNT, 'meta.nope', {})).rejects.toThrow('Unsupported job type');
    await expect(handleMetaAdsJob(ACCOUNT, 'meta.page_webhook', {})).rejects.toThrow('Unsupported job type');
    await expect(handleMetaAdsJob(ACCOUNT, 'meta.insights_sync', { accountId: RECEIPT })).rejects.toThrow('tenant mismatch');
    expect(handlers.insights).not.toHaveBeenCalled();
    expect(isMetaAdsJob('meta.capi_event')).toBe(true);
    expect(isMetaAdsJob('metadata.x')).toBe(false);
  });
});

describe('meta.page_webhook', () => {
  it('processes a pending receipt once and marks it processed', async () => {
    db.queryRaw.mockResolvedValueOnce([{ payload: { object: 'page' }, status: 'pending' }]);
    await handleMetaPageWebhookJob({ receiptId: RECEIPT });
    expect(db.queryRaw.mock.calls[0][1]).toEqual([RECEIPT, 'meta_page']);
    expect(handlers.page).toHaveBeenCalledWith({ object: 'page' });
    expect(db.executeRaw.mock.calls[0][0]).toContain("SET status='processed'");
  });

  it('skips a processed or missing receipt', async () => {
    db.queryRaw.mockResolvedValueOnce([{ payload: {}, status: 'processed' }]).mockResolvedValueOnce([]);
    await handleMetaPageWebhookJob({ receiptId: RECEIPT });
    await handleMetaPageWebhookJob({ receiptId: RECEIPT });
    expect(handlers.page).not.toHaveBeenCalled();
    expect(db.executeRaw).not.toHaveBeenCalled();
  });

  it('leaves the receipt pending when processing fails, and rejects a bad id', async () => {
    db.queryRaw.mockResolvedValueOnce([{ payload: {}, status: 'pending' }]);
    handlers.page.mockRejectedValueOnce(new Error('db down'));
    await expect(handleMetaPageWebhookJob({ receiptId: RECEIPT })).rejects.toThrow('db down');
    expect(db.executeRaw).not.toHaveBeenCalled();
    await expect(handleMetaPageWebhookJob({ receiptId: "x' OR 1=1" })).rejects.toThrow('Invalid job identifier');
  });
});
