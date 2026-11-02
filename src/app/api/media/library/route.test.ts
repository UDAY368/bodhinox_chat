import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const MEDIA = '44444444-4444-4444-8444-444444444444';
const h = vi.hoisted(() => ({
  role: 'agent', limited: false, mutationOk: true,
  listLibraryMedia: vi.fn(), getStorageUsage: vi.fn(), addToLibrary: vi.fn(), prepareLibraryDelete: vi.fn(),
  putMedia: vi.fn(), removeMedia: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => ({ userId: USER, accountId: ACCOUNT, role: h.role, sessionId: 's' }),
  assertMutation: async () => {
    if (!h.mutationOk) {
      const { UnauthorizedError } = await import('@/lib/auth/errors');
      throw new UnauthorizedError();
    }
  },
}));
vi.mock('@/lib/data/server', () => ({ createClient: async () => ({}) }));
vi.mock('@/lib/rate-limit', () => ({
  RATE_LIMITS: { send: { limit: 60, windowMs: 60_000 } },
  checkRateLimit: () => ({ success: !h.limited }),
  rateLimitResponse: () => Response.json({}, { status: 429 }),
}));
vi.mock('@/lib/db/tenant', () => ({ withTenant: async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({ tx: true }) }));
vi.mock('@/lib/storage/server', () => ({ putMedia: h.putMedia, removeMedia: h.removeMedia }));
vi.mock('@/lib/inbox/media-library', async (original) => ({
  ...(await original<typeof import('@/lib/inbox/media-library')>()),
  listLibraryMedia: h.listLibraryMedia, getStorageUsage: h.getStorageUsage, addToLibrary: h.addToLibrary,
  prepareLibraryDelete: h.prepareLibraryDelete,
}));

import { encodeCursor, MediaLibraryError } from '@/lib/inbox/media-library';
import { GET, POST } from './route';
import { DELETE } from './[id]/route';

const usage = { used_bytes: 10, library_bytes: 5, library_count: 1, limit_bytes: null };
const item = { id: MEDIA, url: '/api/media/object?bucket=chat-media&key=x', kind: 'image', filename: 'a.png' };
const upload = (file: File | null, extra: Record<string, string> = {}) => {
  const form = new FormData();
  if (file) form.set('file', file);
  for (const [k, v] of Object.entries(extra)) form.set(k, v);
  return new Request('http://localhost/api/media/library', { method: 'POST', body: form });
};
const params = { params: Promise.resolve({ id: MEDIA }) };
const del = () => DELETE(new Request(`http://localhost/api/media/library/${MEDIA}`, { method: 'DELETE' }), params);

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'agent';
  h.limited = false;
  h.mutationOk = true;
  h.listLibraryMedia.mockResolvedValue({ items: [item], next_cursor: 'next' });
  h.getStorageUsage.mockResolvedValue(usage);
  h.addToLibrary.mockResolvedValue(item);
  h.putMedia.mockResolvedValue(undefined);
  h.removeMedia.mockResolvedValue(undefined);
  h.prepareLibraryDelete.mockResolvedValue({ outcome: 'remove', bucket: 'chat-media', objectKey: `account-${ACCOUNT}/library/1-a.png` });
});

describe('GET /api/media/library', () => {
  it('lists the first page with the storage meter for any member', async () => {
    h.role = 'viewer';
    const res = await GET(new Request('http://localhost/api/media/library?kind=image&q=menu'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ items: [item], next_cursor: 'next', usage, can_upload: false });
    expect(h.listLibraryMedia).toHaveBeenCalledWith({ tx: true }, ACCOUNT, { kind: 'image', q: 'menu', cursor: null, limit: 30 }, { userId: USER, role: 'viewer' });
  });

  it('skips the meter on later pages', async () => {
    const cursor = encodeCursor('2026-11-02T10:00:00.000001Z', MEDIA);
    const res = await GET(new Request(`http://localhost/api/media/library?cursor=${cursor}&limit=5`));
    const body = await res.json();
    expect(body.usage).toBeUndefined();
    expect(body.can_upload).toBe(true);
    expect(h.getStorageUsage).not.toHaveBeenCalled();
    expect(h.listLibraryMedia.mock.calls[0][2]).toMatchObject({ cursor: { id: MEDIA }, limit: 5 });
  });

  it('rejects a bad kind, cursor or limit', async () => {
    for (const q of ['kind=sticker', 'cursor=zzz', 'limit=500']) {
      const res = await GET(new Request(`http://localhost/api/media/library?${q}`));
      expect(res.status).toBe(400);
    }
    expect(h.listLibraryMedia).not.toHaveBeenCalled();
  });
});

describe('POST /api/media/library', () => {
  it('stores the file under the account library folder and adds it', async () => {
    const res = await POST(upload(new File([new Uint8Array([1, 2, 3])], 'Menu Card.png', { type: 'image/png' }), { bucket: 'avatars', key: 'evil' }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ item });
    const [ctx, bucket, path, bytes, type] = h.putMedia.mock.calls[0];
    expect(ctx).toMatchObject({ accountId: ACCOUNT, userId: USER, role: 'agent' });
    expect(bucket).toBe('chat-media');
    expect(path).toMatch(new RegExp(`^account-${ACCOUNT}/library/\\d+-Menu_Card\\.png$`));
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(type).toBe('image/png');
    expect(h.addToLibrary).toHaveBeenCalledWith({ tx: true }, ACCOUNT, path, 'Menu Card.png', { userId: USER, role: 'agent' });
  });

  it('refuses viewers before reading the body', async () => {
    h.role = 'viewer';
    const res = await POST(upload(new File(['x'], 'a.txt', { type: 'text/plain' })));
    expect(res.status).toBe(403);
    expect(h.putMedia).not.toHaveBeenCalled();
  });

  it('requires the mutation check', async () => {
    h.mutationOk = false;
    expect((await POST(upload(new File(['x'], 'a.txt', { type: 'text/plain' })))).status).toBe(401);
    expect(h.putMedia).not.toHaveBeenCalled();
  });

  it('is rate limited', async () => {
    h.limited = true;
    expect((await POST(upload(new File(['x'], 'a.txt', { type: 'text/plain' })))).status).toBe(429);
    expect(h.putMedia).not.toHaveBeenCalled();
  });

  it('rejects a missing, empty or oversized file', async () => {
    expect((await POST(upload(null))).status).toBe(400);
    expect((await POST(upload(new File([], 'empty.txt', { type: 'text/plain' })))).status).toBe(400);
    const big = new Request('http://localhost/api/media/library', { method: 'POST', body: 'x', headers: { 'content-length': String(40 * 1024 * 1024) } });
    expect((await POST(big)).status).toBe(413);
    expect(h.putMedia).not.toHaveBeenCalled();
  });

  it('maps storage validation and configuration errors to safe responses', async () => {
    h.putMedia.mockRejectedValueOnce(new Error('Unsupported media type'));
    const bad = await POST(upload(new File(['x'], 'a.exe', { type: 'application/x-msdownload' })));
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe('invalid_upload');
    h.putMedia.mockRejectedValueOnce(new Error('Missing required configuration: S3_BUCKET'));
    const off = await POST(upload(new File(['x'], 'a.txt', { type: 'text/plain' })));
    expect(off.status).toBe(503);
    expect(JSON.stringify(await off.json())).not.toContain('S3_BUCKET');
    expect(h.addToLibrary).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/media/library/[id]', () => {
  it('removes the stored object when nothing uses it', async () => {
    const res = await del();
    expect(await res.json()).toEqual({ outcome: 'deleted' });
    expect(h.prepareLibraryDelete).toHaveBeenCalledWith({ tx: true }, ACCOUNT, MEDIA, { userId: USER, role: 'agent' });
    expect(h.removeMedia).toHaveBeenCalledWith(expect.objectContaining({ accountId: ACCOUNT }), 'chat-media', `account-${ACCOUNT}/library/1-a.png`);
  });

  it('only hides referenced media and keeps the object', async () => {
    h.prepareLibraryDelete.mockResolvedValueOnce({ outcome: 'hidden', references: ['message', 'template'], retained: false });
    const res = await del();
    expect(await res.json()).toEqual({ outcome: 'hidden', references: ['message', 'template'], retained: false });
    expect(h.removeMedia).not.toHaveBeenCalled();
  });

  it('still reports deleted when the storage removal fails after the soft delete', async () => {
    h.removeMedia.mockRejectedValueOnce(new Error('S3 down'));
    const res = await del();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: 'deleted' });
  });

  it('refuses viewers and passes through refusals', async () => {
    h.role = 'viewer';
    expect((await del()).status).toBe(403);
    expect(h.prepareLibraryDelete).not.toHaveBeenCalled();
    h.role = 'agent';
    h.prepareLibraryDelete.mockRejectedValueOnce(new MediaLibraryError('Only an admin or the uploader can delete this file', 'forbidden', 403));
    expect((await del()).status).toBe(403);
    h.prepareLibraryDelete.mockRejectedValueOnce(new MediaLibraryError('Media not found', 'not_found', 404));
    expect((await del()).status).toBe(404);
    expect(h.removeMedia).not.toHaveBeenCalled();
  });

  it('requires the mutation check', async () => {
    h.mutationOk = false;
    expect((await del()).status).toBe(401);
    expect(h.prepareLibraryDelete).not.toHaveBeenCalled();
  });
});
