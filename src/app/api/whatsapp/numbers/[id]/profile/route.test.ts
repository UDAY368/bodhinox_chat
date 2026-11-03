import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  role: 'admin' as string,
  getProfile: vi.fn(),
  updateProfile: vi.fn(),
  upload: vi.fn(),
  getNumberConfig: vi.fn(),
  calls: [] as string[],
}));
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const ctx = { accountId: ACCOUNT, userId: '22222222-2222-4222-8222-222222222222' };
const NUMBER = '33333333-3333-4333-8333-333333333333';

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: async () => ({ ...ctx, role: h.role }),
  requireRole: async () => {
    if (!['admin', 'owner'].includes(h.role)) throw Object.assign(new Error('Forbidden'), { status: 403 });
    return { ...ctx, role: h.role };
  },
  toErrorResponse: (err: { status?: number }) => Response.json({ error: 'denied' }, { status: err.status ?? 500 }),
}));
vi.mock('@/lib/auth/session', () => ({ requireSession: async () => ({}), assertMutation: async () => undefined }));
vi.mock('@/lib/rate-limit', () => ({
  RATE_LIMITS: { adminAction: { limit: 30, windowMs: 60_000 } },
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => Response.json({}, { status: 429 }),
}));
vi.mock('@/lib/db/tenant', () => ({ withTenant: (_t: unknown, op: (tx: unknown) => unknown) => op({}) }));
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => v.replace('enc:', '') }));
vi.mock('@/lib/whatsapp/numbers', async (orig) => {
  const actual = await orig<typeof import('@/lib/whatsapp/numbers')>();
  return { NoNumberError: actual.NoNumberError, assertNumberConnected: actual.assertNumberConnected, getNumberConfig: h.getNumberConfig };
});
vi.mock('@/lib/whatsapp/meta-api', () => ({
  getBusinessProfile: h.getProfile,
  updateBusinessProfile: h.updateProfile,
  uploadResumableMedia: h.upload,
}));

import { NoNumberError } from '@/lib/whatsapp/numbers';
import { GET, PUT } from './route';

const params = (id = NUMBER) => ({ params: Promise.resolve({ id }) });
const putJson = (body: unknown, id?: string) =>
  PUT(new Request('http://x', { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), params(id));

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'admin';
  h.calls = [];
  process.env.META_APP_ID = '42';
  h.getNumberConfig.mockResolvedValue({ id: NUMBER, phone_number_id: '777', access_token: 'enc:tok' });
  h.getProfile.mockImplementation(async () => { h.calls.push('get'); return { about: 'fresh', websites: ['https://a.example'] }; });
  h.updateProfile.mockImplementation(async () => { h.calls.push('update'); });
  h.upload.mockImplementation(async () => { h.calls.push('upload'); return { handle: 'H1' }; });
});

it('lets any member read the profile of a number in their workspace', async () => {
  h.role = 'viewer';
  const res = await GET(new Request('http://x'), params());
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(json.profile).toMatchObject({ about: 'fresh', websites: ['https://a.example'], profile_picture_url: null });
  expect(JSON.stringify(json)).not.toContain('tok');
  expect(h.getNumberConfig).toHaveBeenCalledWith({}, ACCOUNT, NUMBER);
  expect(h.getProfile).toHaveBeenCalledWith({ phoneNumberId: '777', accessToken: 'tok' });
});

it('answers 404 for a number outside the workspace', async () => {
  h.getNumberConfig.mockRejectedValue(new NoNumberError('not_found'));
  expect((await GET(new Request('http://x'), params('nope'))).status).toBe(404);
  expect((await putJson({ about: 'x' }, 'nope')).status).toBe(404);
  expect(h.updateProfile).not.toHaveBeenCalled();
});

it('answers 409 "disconnected" for a removed number instead of failing to decrypt its cleared token', async () => {
  h.getNumberConfig.mockResolvedValue({ id: NUMBER, phone_number_id: '777', status: 'disconnected', access_token: '' });
  const read = await GET(new Request('http://x'), params());
  expect(read.status).toBe(409);
  expect(await read.json()).toEqual({ error: expect.stringContaining('disconnected') });
  expect((await putJson({ about: 'x' })).status).toBe(409);
  expect(h.getProfile).not.toHaveBeenCalled();
  expect(h.updateProfile).not.toHaveBeenCalled();
});

it('answers 502 when Meta read fails', async () => {
  h.getProfile.mockRejectedValue(new Error('meta'));
  expect((await GET(new Request('http://x'), params())).status).toBe(502);
});

it('refuses writes from agents and viewers', async () => {
  for (const role of ['agent', 'viewer']) {
    h.role = role;
    expect((await putJson({ about: 'x' })).status).toBe(403);
  }
  expect(h.updateProfile).not.toHaveBeenCalled();
});

it('validates server side before touching Meta', async () => {
  const res = await putJson({ about: 'a'.repeat(140) });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ field: 'about' });
  expect((await putJson({ websites: ['ftp://x'] })).status).toBe(400);
  expect((await putJson({ vertical: 'NOPE' })).status).toBe(400);
  expect((await putJson({})).status).toBe(400);
  expect(h.getNumberConfig).not.toHaveBeenCalled();
  expect(h.updateProfile).not.toHaveBeenCalled();
});

it('updates Meta first, then returns the fresh profile', async () => {
  const res = await putJson({ about: ' New ', vertical: 'RETAIL' });
  expect(res.status).toBe(200);
  expect(h.updateProfile).toHaveBeenCalledWith({ phoneNumberId: '777', accessToken: 'tok', profile: { about: 'New', vertical: 'RETAIL' } });
  expect(h.calls).toEqual(['update', 'get']);
  expect((await res.json()).profile.about).toBe('fresh');
});

it('answers 502 and skips the re-read when Meta rejects the update', async () => {
  h.updateProfile.mockRejectedValue(new Error('meta'));
  expect((await putJson({ about: 'x' })).status).toBe(502);
  expect(h.getProfile).not.toHaveBeenCalled();
});

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const putForm = (fields: Record<string, string | File>) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return PUT(new Request('http://x', { method: 'PUT', body: form }), params());
};

it('uploads a photo through resumable upload and sends its handle', async () => {
  const res = await putForm({ profile: JSON.stringify({ about: 'Hi' }), photo: new File([png], 'me.png', { type: 'image/png' }) });
  expect(res.status).toBe(200);
  expect(h.upload).toHaveBeenCalledWith(expect.objectContaining({ appId: '42', accessToken: 'tok', mimeType: 'image/png' }));
  expect(h.updateProfile).toHaveBeenCalledWith(expect.objectContaining({ profile: { about: 'Hi', profile_picture_handle: 'H1' } }));
  expect(h.calls).toEqual(['upload', 'update', 'get']);
});

it('refuses a photo of the wrong type or with forged bytes', async () => {
  expect((await putForm({ photo: new File([png], 'a.gif', { type: 'image/gif' }) })).status).toBe(400);
  expect((await putForm({ photo: new File([new Uint8Array([1, 2, 3, 4])], 'a.png', { type: 'image/png' }) })).status).toBe(400);
  expect((await putForm({ profile: '{bad' })).status).toBe(400);
  expect(h.upload).not.toHaveBeenCalled();
});
