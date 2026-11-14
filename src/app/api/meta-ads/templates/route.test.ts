import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ enabled: true, manage: true, mutationOk: true, sessions: 0, calls: [] as unknown[][] }));

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => {
    h.sessions++;
    return { userId: '22222222-2222-4222-8222-222222222222', accountId: '11111111-1111-4111-8111-111111111111', role: 'admin', sessionId: 's' };
  },
  assertMutation: async () => {
    if (!h.mutationOk) throw new (await import('@/lib/auth/errors')).UnauthorizedError();
  },
}));
vi.mock('@/lib/meta-ads/config', () => ({ metaAdsConfig: () => (h.enabled ? { appId: '1' } : null), metaAdsManageEnabled: () => h.manage }));
vi.mock('@/lib/meta-ads/templates', async (original) => ({
  ...(await original<typeof import('@/lib/meta-ads/templates')>()),
  listAdTemplates: async () => [{ id: 't1' }],
  saveAdTemplate: async (...args: unknown[]) => { h.calls.push(['save', args[1]]); return { id: 't2' }; },
  deleteAdTemplate: async (...args: unknown[]) => { h.calls.push(['delete', args[1]]); },
}));
vi.mock('@/lib/meta-ads/create', async (original) => ({
  ...(await original<typeof import('@/lib/meta-ads/create')>()),
  createPageLeadForm: async (...args: unknown[]) => { h.calls.push(['form', args[1]]); return { id: '9', name: 'Offer' }; },
  listAdPages: async () => [{ id: '1', name: 'Page', connected: true }],
}));

import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { DELETE, GET, POST } from './route';
import { POST as FORM } from '../leadforms/route';
import { GET as PAGES } from '../pages/route';

const post = (handler: (r: Request) => Promise<Response>, path: string, body: unknown) =>
  handler(new Request(`http://x/api/meta-ads/${path}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }));
const form = { name: 'Offer', questions: ['PHONE'], privacyUrl: 'https://shop.example/privacy' };

beforeEach(() => {
  Object.assign(h, { enabled: true, manage: true, mutationOk: true, sessions: 0, calls: [] });
  __resetRateLimitForTests();
});

it('answers 503 before any session work while disabled; lead forms and Pages need ad management', async () => {
  h.enabled = false;
  expect((await GET(new Request('http://x/api/meta-ads/templates'))).status).toBe(503);
  expect((await post(POST, 'templates', { name: 'a', settings: {} })).status).toBe(503);
  expect((await post(FORM, 'leadforms', form)).status).toBe(503);
  expect((await PAGES(new Request('http://x/api/meta-ads/pages'))).status).toBe(503);
  h.enabled = true;
  h.manage = false;
  expect((await post(FORM, 'leadforms', form)).status).toBe(503);
  expect((await PAGES(new Request('http://x/api/meta-ads/pages'))).status).toBe(503);
  expect(h.sessions).toBe(0);
});

it('checks the origin before saving, deleting or making a form', async () => {
  h.mutationOk = false;
  expect((await post(POST, 'templates', { name: 'a', settings: {} })).status).toBe(401);
  expect((await DELETE(new Request('http://x/api/meta-ads/templates?id=x', { method: 'DELETE' }))).status).toBe(401);
  expect((await post(FORM, 'leadforms', form)).status).toBe(401);
  expect(h.calls).toEqual([]);
});

it('validates bodies, refuses oversized setups and passes clean input on', async () => {
  expect((await post(POST, 'templates', { name: '', settings: {} })).status).toBe(400);
  expect((await post(POST, 'templates', 'x'.repeat(25_000))).status).toBe(400);
  expect((await post(POST, 'templates', { name: 'Diwali', settings: { kind: 'whatsapp' } })).status).toBe(201);
  expect(h.calls[0]).toEqual(['save', { name: 'Diwali', settings: { kind: 'whatsapp' } }]);
  expect((await post(FORM, 'leadforms', { ...form, questions: ['CITY'] })).status).toBe(400);
  expect((await post(FORM, 'leadforms', form)).status).toBe(201);
  expect(await (await GET(new Request('http://x/api/meta-ads/templates'))).json()).toEqual({ templates: [{ id: 't1' }] });
  expect(await (await PAGES(new Request('http://x/api/meta-ads/pages'))).json()).toEqual({ pages: [{ id: '1', name: 'Page', connected: true }] });
});
