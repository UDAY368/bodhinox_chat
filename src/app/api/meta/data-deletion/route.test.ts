// POST /api/meta/data-deletion: only a correctly signed request is recorded; the
// answer is { url, confirmation_code } pointing at the public status page.
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const record = vi.hoisted(() => vi.fn());
vi.mock('@/lib/meta/data-deletion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/meta/data-deletion')>()),
  recordDeletionRequest: record,
}));

import { POST } from './route';

const SECRET = 'test-only-app-secret';
function signed(payload: unknown, secret = SECRET): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${createHmac('sha256', secret).update(body).digest('base64url')}.${body}`;
}
const valid = signed({ algorithm: 'HMAC-SHA256', issued_at: 1_762_700_000, user_id: '1234567890' });
const form = (body: string) =>
  new Request('https://app.example.in/api/meta/data-deletion', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

describe('POST /api/meta/data-deletion', () => {
  const saved = { secret: process.env.META_APP_SECRET, app: process.env.APP_URL };
  beforeEach(() => {
    record.mockReset();
    process.env.META_APP_SECRET = SECRET;
    process.env.APP_URL = 'https://app.example.in';
  });
  afterEach(() => {
    process.env.META_APP_SECRET = saved.secret;
    process.env.APP_URL = saved.app;
    if (saved.secret === undefined) delete process.env.META_APP_SECRET;
    if (saved.app === undefined) delete process.env.APP_URL;
  });

  it('records a signed request and returns the status url and code', async () => {
    record.mockResolvedValue('c'.repeat(48));
    const res = await POST(form(`signed_request=${encodeURIComponent(valid)}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      url: `https://app.example.in/data-deletion?code=${'c'.repeat(48)}`,
      confirmation_code: 'c'.repeat(48),
    });
    expect(record).toHaveBeenCalledWith({ userId: '1234567890', issuedAt: 1_762_700_000 });
  });

  it('refuses an unsigned, forged or missing request without touching the database', async () => {
    for (const body of ['', 'signed_request=', `signed_request=${encodeURIComponent(signed({ algorithm: 'HMAC-SHA256', issued_at: 1, user_id: '1' }, 'forged'))}`]) {
      const res = await POST(form(body));
      expect(res.status).toBe(400);
    }
    delete process.env.META_APP_SECRET;
    expect((await POST(form(`signed_request=${encodeURIComponent(valid)}`))).status).toBe(400);
    expect(record).not.toHaveBeenCalled();
  });

  it('refuses an oversized body and answers 503 when storage fails', async () => {
    expect((await POST(form(`signed_request=${'a'.repeat(20_000)}`))).status).toBe(413);
    record.mockRejectedValue(new Error('db down'));
    const res = await POST(form(`signed_request=${encodeURIComponent(valid)}`));
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('db down');
  });
});
