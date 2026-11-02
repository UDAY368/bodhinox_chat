import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  numbers: [] as Record<string, unknown>[],
  /** The token Meta accepts for this media id (the WABA it arrived on). */
  acceptedToken: '',
  tried: [] as string[],
}));

vi.mock('@/lib/data/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u-1' } }, error: null }) },
    from(table: string) {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        maybeSingle: async () => ({ data: table === 'profiles' ? { account_id: 'acct' } : null, error: null }),
        then: (resolve: (r: { data: unknown[]; error: null }) => unknown) =>
          resolve({ data: table === 'whatsapp_config' ? h.numbers : [], error: null }),
      };
      return b;
    },
  }),
}));
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => `plain:${v}` }));
vi.mock('@/lib/whatsapp/meta-api', () => ({
  getMediaUrl: async ({ accessToken }: { accessToken: string }) => {
    h.tried.push(accessToken);
    if (accessToken !== h.acceptedToken) throw new Error('Meta API error: (#100) not found');
    return { url: 'https://lookaside.example/media', mimeType: 'image/jpeg' };
  },
  downloadMedia: async ({ accessToken }: { accessToken: string }) => {
    if (accessToken !== h.acceptedToken) throw new Error('wrong token');
    return { buffer: Buffer.from('img'), contentType: 'image/jpeg' };
  },
}));

import { GET } from './route';

const get = () => GET(new Request('http://localhost/api/whatsapp/media/123'), { params: Promise.resolve({ mediaId: '123' }) });

describe('GET /api/whatsapp/media/[mediaId] with numbers in two WABAs', () => {
  beforeEach(() => {
    h.tried = [];
    h.numbers = [
      { id: 'b', access_token: 'tok-b', is_default: false, created_at: '2026-02-01T00:00:00Z' },
      { id: 'a', access_token: 'tok-a', is_default: true, created_at: '2026-01-01T00:00:00Z' },
    ];
  });

  it("tries the default number's token first", async () => {
    h.acceptedToken = 'plain:tok-a';
    const res = await get();
    expect(res.status).toBe(200);
    expect(h.tried).toEqual(['plain:tok-a']);
  });

  it("falls back to the other WABA's token for media that arrived there", async () => {
    h.acceptedToken = 'plain:tok-b';
    const res = await get();
    expect(res.status).toBe(200);
    expect(h.tried).toEqual(['plain:tok-a', 'plain:tok-b']);
  });

  it('fails when no token can read the media, and 400s with no number', async () => {
    h.acceptedToken = 'none';
    expect((await get()).status).toBe(500);
    h.numbers = [];
    expect((await get()).status).toBe(400);
  });
});
