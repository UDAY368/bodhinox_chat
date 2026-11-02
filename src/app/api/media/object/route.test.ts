import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ putMedia: vi.fn(async () => {}) }));
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => ({ accountId: ACCOUNT, userId: 'u-1', role: 'agent' }),
  assertMutation: async () => {},
}));
vi.mock('@/lib/storage/server', () => ({ getMedia: vi.fn(), putMedia: h.putMedia, removeMedia: vi.fn() }));

import { POST } from './route';

function upload(key: string) {
  const form = new FormData();
  form.set('bucket', 'chat-media');
  form.set('key', key);
  form.set('file', new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' }));
  return POST(new Request('http://localhost/api/media/object', { method: 'POST', body: form }));
}

beforeEach(() => h.putMedia.mockClear());

it('refuses member uploads into the inbound media folder, which the storage limit does not count', async () => {
  const res = await upload(`account-${ACCOUNT}/inbound/a.png`);
  expect(res.status).toBe(403);
  expect(h.putMedia).not.toHaveBeenCalled();
});

it('still accepts uploads elsewhere in the workspace', async () => {
  const res = await upload(`account-${ACCOUNT}/uploads/a.png`);
  expect(res.status).toBe(200);
  expect(h.putMedia).toHaveBeenCalledTimes(1);
});
