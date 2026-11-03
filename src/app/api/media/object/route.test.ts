import { beforeEach, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const h = vi.hoisted(() => ({
  putMedia: vi.fn(async () => {}),
  removeMedia: vi.fn(async () => {}),
  guard: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
  role: 'agent',
  userId: 'u-1',
}));
vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => ({ accountId: ACCOUNT, userId: h.userId, role: h.role }),
  assertMutation: async () => {},
}));
vi.mock('@/lib/storage/server', () => ({ getMedia: vi.fn(), putMedia: h.putMedia, removeMedia: h.removeMedia }));
vi.mock('@/lib/db/tenant', () => ({ withTenant: async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock('@/lib/inbox/media-library', async (original) => ({
  ...(await original<typeof import('@/lib/inbox/media-library')>()),
  assertDirectObjectChange: h.guard,
}));

import { MediaLibraryError } from '@/lib/inbox/media-library';
import { DELETE, POST } from './route';

function upload(key: string, upsert = false, bucket = 'chat-media') {
  const form = new FormData();
  form.set('bucket', bucket);
  form.set('key', key);
  form.set('upsert', String(upsert));
  form.set('file', new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' }));
  return POST(new Request('http://localhost/api/media/object', { method: 'POST', body: form }));
}
const remove = (paths: string[], bucket = 'chat-media') =>
  DELETE(new Request('http://localhost/api/media/object', { method: 'DELETE', body: JSON.stringify({ bucket, paths }) }));

beforeEach(async () => {
  h.putMedia.mockClear();
  h.removeMedia.mockClear();
  h.guard.mockReset();
  h.role = 'agent';
  h.userId = 'u-1';
  // The real prefix rule, so the route test does not need a database for it.
  const real = await vi.importActual<typeof import('@/lib/inbox/media-library')>('@/lib/inbox/media-library');
  h.guard.mockImplementation(async (_tx, accountId, _bucket, key) => {
    const root = `account-${accountId}/`;
    if (String(key).startsWith(`${root}library/`) || String(key).startsWith(`${root}inbound/`))
      throw new real.MediaLibraryError('Library and inbound media can only be changed through the media library', 'forbidden', 403);
  });
});

it('refuses member uploads into the inbound media folder, which the storage limit does not count', async () => {
  const res = await upload(`account-${ACCOUNT}/inbound/a.png`);
  expect(res.status).toBe(403);
  expect(h.putMedia).not.toHaveBeenCalled();
});

it('refuses uploads and overwrites in the library folder, which belongs to /api/media/library', async () => {
  for (const upsert of [false, true]) {
    const res = await upload(`account-${ACCOUNT}/library/a.png`, upsert);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('forbidden');
  }
  expect(h.putMedia).not.toHaveBeenCalled();
});

it('still accepts uploads elsewhere in the workspace', async () => {
  const res = await upload(`account-${ACCOUNT}/uploads/a.png`);
  expect(res.status).toBe(200);
  expect(h.putMedia).toHaveBeenCalledTimes(1);
  expect(h.guard).toHaveBeenCalledWith(expect.anything(), ACCOUNT, 'chat-media', `account-${ACCOUNT}/uploads/a.png`, { userId: 'u-1', role: 'agent' });
});

it('refuses deleting library or inbound media and removes nothing when any path is refused', async () => {
  for (const folder of ['library', 'inbound']) {
    const res = await remove([`account-${ACCOUNT}/uploads/ok.png`, `account-${ACCOUNT}/${folder}/x.png`]);
    expect(res.status).toBe(403);
  }
  expect(h.removeMedia).not.toHaveBeenCalled();
});

it('surfaces the guard refusal for referenced or retained objects as 409', async () => {
  h.guard.mockRejectedValueOnce(new MediaLibraryError('This file is still in use', 'in_use', 409));
  const res = await remove([`account-${ACCOUNT}/uploads/used.png`]);
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: { message: 'This file is still in use', code: 'in_use' } });
  expect(h.removeMedia).not.toHaveBeenCalled();
});

it('deletes an unguarded object', async () => {
  const res = await remove([`account-${ACCOUNT}/uploads/a.png`]);
  expect(res.status).toBe(200);
  expect(h.removeMedia).toHaveBeenCalledWith(expect.objectContaining({ accountId: ACCOUNT }), 'chat-media', `account-${ACCOUNT}/uploads/a.png`);
});

it('rejects path tricks before the guard runs', async () => {
  const res = await remove([`account-${ACCOUNT}/./library/a.png`]);
  expect(res.status).toBe(400);
  expect(h.guard).not.toHaveBeenCalled();
  expect(h.removeMedia).not.toHaveBeenCalled();
});

it('refuses viewers before any lookup', async () => {
  h.role = 'viewer';
  expect((await remove([`account-${ACCOUNT}/uploads/a.png`])).status).toBe(400);
  expect(h.guard).not.toHaveBeenCalled();
  expect(h.removeMedia).not.toHaveBeenCalled();
});

it('lets a member replace their own avatar without the media library guard', async () => {
  h.userId = '22222222-2222-4222-8222-222222222222';
  const res = await upload(`${h.userId}/avatar.png`, true, 'avatars');
  expect(res.status).toBe(200);
  expect(h.guard).not.toHaveBeenCalled();
  expect(h.putMedia).toHaveBeenCalledTimes(1);
});
