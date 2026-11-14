import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  enabled: true, manage: true, mutationOk: true, sessions: 0, provider: 'gemini' as string | null, calls: [] as unknown[][],
  image: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
}));

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => {
    h.sessions++;
    return { userId: '22222222-2222-4222-8222-222222222222', accountId: '11111111-1111-4111-8111-111111111111', role: 'admin', sessionId: 's' };
  },
  assertMutation: async () => {
    if (!h.mutationOk) throw new (await import('@/lib/auth/errors')).UnauthorizedError();
  },
}));
vi.mock('@/lib/auth/account', async (original) => ({
  ...(await original<typeof import('@/lib/auth/account')>()),
  requireRole: async () => ({ db: {}, accountId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222' }),
}));
vi.mock('@/lib/meta-ads/config', () => ({ metaAdsConfig: () => (h.enabled ? { appId: '1' } : null), metaAdsManageEnabled: () => h.manage }));
vi.mock('@/lib/ai/config', () => ({ loadAiConfig: async () => (h.provider ? { provider: h.provider, model: 'm', apiKey: 'k', baseUrl: null } : null) }));
vi.mock('@/lib/ai/budget', () => ({
  ROUTE_GENERATION_TOKENS: 1,
  requestMeter: () => ({
    hooks: { beforeAttempt: async () => { h.calls.push(['reserve']); }, afterAttempt: () => { h.calls.push(['usage']); } },
    finish: async (error?: unknown) => { h.calls.push(['finish', !!error]); },
  }),
}));
vi.mock('@/lib/ai/ad-creative', async (original) => ({
  ...(await original<typeof import('@/lib/ai/ad-creative')>()),
  suggestAdCopy: async (args: { kind: string; brief: string }) => { h.calls.push(['copy', args.kind, args.brief]); return [{ primaryText: 'A', headline: 'B', description: null }]; },
  generateAdImage: async () => { h.calls.push(['image']); return h.image; },
}));
vi.mock('@/lib/meta-ads/create', async (original) => ({
  ...(await original<typeof import('@/lib/meta-ads/create')>()),
  uploadImageForAd: async (_a: unknown, adAccountId: string) => { h.calls.push(['upload', adAccountId]); return { hash: 'abcdef0123456789', url: null }; },
}));

import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { POST } from './route';

const post = (body: unknown) => POST(new Request('http://x/api/meta-ads/ai', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => {
  Object.assign(h, { enabled: true, manage: true, mutationOk: true, sessions: 0, provider: 'gemini', calls: [], image: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]) });
  __resetRateLimitForTests();
});

it('answers 503 before any session work while ads or ad management are off', async () => {
  h.enabled = false;
  expect((await post({ action: 'copy', kind: 'whatsapp', brief: 'x' })).status).toBe(503);
  h.enabled = true;
  h.manage = false;
  expect((await post({ action: 'copy', kind: 'whatsapp', brief: 'x' })).status).toBe(503);
  expect(h.sessions).toBe(0);
});

it('checks the origin first, then the request; no provider means no call', async () => {
  h.mutationOk = false;
  expect((await post({ action: 'copy', kind: 'whatsapp', brief: 'x' })).status).toBe(401);
  h.mutationOk = true;
  expect((await post({ action: 'copy', kind: 'tiktok', brief: 'x' })).status).toBe(400);
  expect((await post({ action: 'copy', kind: 'whatsapp', brief: 'x'.repeat(1001) })).status).toBe(400);
  h.provider = null;
  const res = await post({ action: 'copy', kind: 'whatsapp', brief: 'Lamps' });
  expect([res.status, (await res.json()).error]).toEqual([400, 'ai_not_configured']);
  expect(h.calls).toEqual([]);
});

it('writes copy under one metered request', async () => {
  const res = await post({ action: 'copy', kind: 'whatsapp', brief: ' Diwali lamps ' });
  expect(await res.json()).toEqual({ variants: [{ primaryText: 'A', headline: 'B', description: null }] });
  expect(h.calls).toEqual([['copy', 'whatsapp', 'Diwali lamps'], ['finish', false]]);
});

it('makes an image, meters it, refuses a non-image, and uploads it to the ad account', async () => {
  expect((await post({ action: 'image', adAccountId: 'act_1', prompt: 'x' })).status).toBe(400);
  h.provider = 'anthropic';
  expect((await (await post({ action: 'image', adAccountId: '555', prompt: 'lamps' })).json()).error).toBe('image_not_supported');
  h.provider = 'openai';
  const res = await post({ action: 'image', adAccountId: '555', prompt: 'lamps' });
  const body = await res.json();
  expect(body).toMatchObject({ hash: 'abcdef0123456789', url: null });
  expect(body.preview).toMatch(/^data:image\/png;base64,/);
  expect(h.calls).toEqual([['reserve'], ['image'], ['usage'], ['finish', false], ['upload', '555']]);
  h.calls = [];
  h.image = new TextEncoder().encode('<svg onload=alert(1)>');
  expect((await post({ action: 'image', adAccountId: '555', prompt: 'lamps' })).status).toBe(502);
  expect(h.calls.some((c) => c[0] === 'upload')).toBe(false);
});
