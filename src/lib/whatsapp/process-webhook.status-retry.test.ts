import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ applyProviderStatus: vi.fn(), enqueueJob: vi.fn() }));
class StatusAwaitingPersistenceError extends Error {
  constructor() { super('Provider status awaits local outbound persistence'); this.name = 'StatusAwaitingPersistenceError'; }
}
vi.mock('@/lib/repositories/routing', () => ({
  resolveWhatsAppAccount: async () => '11111111-1111-4111-8111-111111111111',
  resolveWabaAccount: async () => null,
}));
vi.mock('@/lib/whatsapp/ingest', () => ({ applyProviderStatus: h.applyProviderStatus, ingestInboundMessage: vi.fn() }));
vi.mock('@/lib/jobs/queue', () => ({ enqueueJob: h.enqueueJob }));

import { processWebhook, retryProviderStatus } from './process-webhook';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const status = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, status: 'delivered', timestamp: '1700000100', recipient_id: '15551230000', ...extra });
const delivery = (statuses: unknown[]) => ({
  entry: [{ id: 'WABA-1', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'pn-1' }, statuses } }] }],
}) as unknown as Parameters<typeof processWebhook>[0];

beforeEach(() => {
  vi.clearAllMocks();
  h.applyProviderStatus.mockResolvedValue(undefined);
  h.enqueueJob.mockResolvedValue('job-1');
});

describe('provider statuses awaiting outbound persistence', () => {
  it('applies the sibling statuses and defers only the unknown wamid to its own retry job', async () => {
    h.applyProviderStatus.mockImplementation(async (_a: string, s: { id: string }) => {
      if (s.id === 'wamid.UNKNOWN') throw new StatusAwaitingPersistenceError();
    });
    await processWebhook(delivery([status('wamid.A'), status('wamid.UNKNOWN'), status('wamid.B')]));
    expect(h.applyProviderStatus.mock.calls.map(c => c[1].id)).toEqual(['wamid.A', 'wamid.UNKNOWN', 'wamid.B']);
    expect(h.enqueueJob).toHaveBeenCalledTimes(1);
    const [type, payload, options] = h.enqueueJob.mock.calls[0];
    expect(type).toBe('whatsapp.status_retry');
    // The recipient's phone number is not needed to apply a status and stays out of the job row.
    expect(payload).toEqual({ accountId: ACCOUNT, status: { id: 'wamid.UNKNOWN', status: 'delivered', timestamp: '1700000100' } });
    expect(options).toMatchObject({ tenantId: ACCOUNT, dedupeKey: `provider-status:${ACCOUNT}:wamid.UNKNOWN:delivered` });
    expect(options.runAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('keeps the failure reason a deferred failed status needs', async () => {
    h.applyProviderStatus.mockRejectedValueOnce(new StatusAwaitingPersistenceError());
    await processWebhook(delivery([status('wamid.F', { status: 'failed',
      errors: [{ code: 131049, title: 'Not delivered', message: 'x', href: 'https://example.invalid', error_data: { details: 'Ecosystem' } }] })]));
    expect(h.enqueueJob.mock.calls[0][1].status).toEqual({ id: 'wamid.F', status: 'failed', timestamp: '1700000100',
      errors: [{ code: 131049, title: 'Not delivered', error_data: { details: 'Ecosystem' } }] });
  });

  it('still fails the delivery on any other status error so the worker retries it', async () => {
    h.applyProviderStatus.mockRejectedValueOnce(new Error('Status persistence failed'));
    await expect(processWebhook(delivery([status('wamid.A')]))).rejects.toThrow('Status persistence failed');
    expect(h.enqueueJob).not.toHaveBeenCalled();
  });

  it('fails the delivery when the retry job cannot be queued, so the status is never lost', async () => {
    h.applyProviderStatus.mockRejectedValueOnce(new StatusAwaitingPersistenceError());
    h.enqueueJob.mockRejectedValueOnce(new Error('queue down'));
    await expect(processWebhook(delivery([status('wamid.A')]))).rejects.toThrow('queue down');
  });
});

describe('retryProviderStatus', () => {
  const payload = { accountId: ACCOUNT, status: { id: 'wamid.X', status: 'read', timestamp: '1700000100' } };
  it('applies the stored status for its own tenant', async () => {
    await retryProviderStatus(ACCOUNT, payload);
    expect(h.applyProviderStatus).toHaveBeenCalledWith(ACCOUNT, payload.status);
  });
  it('propagates a still-missing row so the queue backs off and retries', async () => {
    h.applyProviderStatus.mockRejectedValueOnce(new StatusAwaitingPersistenceError());
    await expect(retryProviderStatus(ACCOUNT, payload)).rejects.toMatchObject({ name: 'StatusAwaitingPersistenceError' });
  });
  it('rejects a payload for another tenant or a malformed status', async () => {
    await expect(retryProviderStatus('22222222-2222-4222-8222-222222222222', payload)).rejects.toThrow('tenant mismatch');
    await expect(retryProviderStatus(ACCOUNT, { accountId: ACCOUNT, status: { id: 1 } })).rejects.toThrow('Invalid provider status retry payload');
    expect(h.applyProviderStatus).not.toHaveBeenCalled();
  });
});
