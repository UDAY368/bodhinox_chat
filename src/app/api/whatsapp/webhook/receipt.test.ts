import { createHmac } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { POST, GET } from './route';
import { persistWebhook } from '@/lib/jobs/queue';
import { verifyWebhookTokenHash } from '@/lib/repositories/routing';
vi.mock('@/lib/jobs/queue', () => ({
  persistWebhook: vi.fn(async () => 'receipt-id'),
}));
vi.mock('@/lib/repositories/routing', () => ({
  verifyWebhookTokenHash: vi.fn(async () => true),
}));
const body = JSON.stringify({ entry: [{ changes: [] }] });
function request(raw = body, valid = true) {
  return new Request('https://example.test/api/whatsapp/webhook', {
    method: 'POST',
    body: raw,
    headers: {
      'x-hub-signature-256': valid
        ? `sha256=${createHmac('sha256', process.env.META_APP_SECRET!).update(raw).digest('hex')}`
        : 'sha256=invalid',
    },
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(persistWebhook).mockResolvedValue('receipt-id');
});
it('checks the raw-body signature and rejects malformed envelopes before persistence', async () => {
  expect((await POST(request(body, false))).status).toBe(401);
  expect(vi.mocked(persistWebhook)).not.toHaveBeenCalled();
  expect((await POST(request('{"entry":"bad"}'))).status).toBe(400);
  expect(vi.mocked(persistWebhook)).not.toHaveBeenCalled();
});
it('acknowledges only after persistence and exposes a stable deduplicated receipt', async () => {
  const first = await POST(request());
  const second = await POST(request());
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({ receipt_id: 'receipt-id' });
  expect(await second.json()).toMatchObject({ receipt_id: 'receipt-id' });
  expect(vi.mocked(persistWebhook).mock.calls[0]).toEqual([
    body,
    JSON.parse(body),
  ]);
});
it('returns retryable failure when durable persistence fails', async () => {
  vi.mocked(persistWebhook).mockRejectedValueOnce(
    new Error('Database unavailable')
  );
  expect((await POST(request())).status).toBe(503);
});
it('verifies GET challenge using a digest rather than plaintext credentials', async () => {
  const result = await GET(
    new Request(
      'https://example.test/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=private-token&hub.challenge=challenge'
    )
  );
  expect(await result.text()).toBe('challenge');
  expect(vi.mocked(verifyWebhookTokenHash).mock.calls[0][0]).toMatch(
    /^[a-f0-9]{64}$/
  );
});
