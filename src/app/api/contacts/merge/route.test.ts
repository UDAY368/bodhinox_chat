// /api/contacts/merge and /api/contacts/duplicates/dismiss: admins and owners only, and every POST passes the
// real Origin and CSRF check (assertMutation) before anything is merged or stored. The merge itself is mocked;
// src/lib/contacts/merge.integration.test.ts runs it on PostgreSQL.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hashToken } from '@/lib/auth/csrf';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const KEEP = '33333333-3333-4333-8333-333333333333';
const MERGED = '44444444-4444-4444-8444-444444444444';
const CSRF = 'test-only-csrf-token';
const h = vi.hoisted(() => ({ role: 'admin', limited: false, merge: vi.fn(), preview: vi.fn(), dismiss: vi.fn() }));

vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  requireSession: async () => ({ userId: USER, accountId: ACCOUNT, role: h.role, sessionId: '55555555-5555-4555-8555-555555555555' }),
}));
// assertMutation reads the session's CSRF hash with the auth client.
vi.mock('@/lib/db/prisma', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db/prisma')>()),
  getAuthPrisma: () => ({ $queryRaw: async () => [{ csrf_hash: hashToken(CSRF) }] }),
}));
vi.mock('@/lib/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rate-limit')>()),
  checkRateLimit: async () => ({ success: !h.limited }),
  rateLimitResponse: () => Response.json({}, { status: 429 }),
}));
vi.mock('@/lib/contacts/merge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/contacts/merge')>()),
  mergeContacts: h.merge,
  previewMerge: h.preview,
}));
vi.mock('@/lib/contacts/duplicates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/contacts/duplicates')>()),
  dismissDuplicate: h.dismiss,
}));

import { MergeError } from '@/lib/contacts/merge';
import { GET, POST } from './route';
import { POST as DISMISS } from '../duplicates/dismiss/route';

const ORIGIN = 'http://localhost:3000';
const post = (body: unknown, headers: Record<string, string> = { origin: ORIGIN, 'x-csrf-token': CSRF }) =>
  POST(new Request('http://localhost:3000/api/contacts/merge', { method: 'POST', headers, body: JSON.stringify(body) }));
const dismiss = (headers: Record<string, string> = { origin: ORIGIN, 'x-csrf-token': CSRF }) =>
  DISMISS(new Request('http://localhost:3000/api/contacts/duplicates/dismiss', {
    method: 'POST', headers, body: JSON.stringify({ contact_ids: [KEEP, MERGED] }),
  }));
const counts = { conversations: 1, messages: 3 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('APP_URL', ORIGIN);
  h.role = 'admin';
  h.limited = false;
  h.merge.mockResolvedValue(counts);
  h.preview.mockResolvedValue(counts);
  h.dismiss.mockResolvedValue(undefined);
});

describe('contact merge route', () => {
  it('merges for an admin or owner in the session workspace', async () => {
    for (const role of ['admin', 'owner']) {
      h.role = role;
      const res = await post({ keep_id: KEEP, merge_id: MERGED });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ counts });
      expect(res.headers.get('Cache-Control')).toContain('no-store');
    }
    expect(h.merge).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: USER, role: 'owner' }, KEEP, MERGED);
  });

  it('refuses agents and viewers before previewing or merging', async () => {
    for (const role of ['agent', 'viewer']) {
      h.role = role;
      expect((await post({ keep_id: KEEP, merge_id: MERGED })).status).toBe(403);
      expect((await GET(new Request(`http://localhost:3000/api/contacts/merge?keep_id=${KEEP}&merge_id=${MERGED}`))).status).toBe(403);
      expect((await dismiss()).status).toBe(403);
    }
    expect(h.merge).not.toHaveBeenCalled();
    expect(h.preview).not.toHaveBeenCalled();
    expect(h.dismiss).not.toHaveBeenCalled();
  });

  it('refuses a cross-site request, a missing CSRF token and a wrong one', async () => {
    const body = { keep_id: KEEP, merge_id: MERGED };
    expect((await post(body, { origin: 'https://evil.example', 'x-csrf-token': CSRF })).status).toBe(403);
    expect((await post(body, { 'x-csrf-token': CSRF })).status).toBe(403);
    expect((await post(body, { origin: ORIGIN, 'sec-fetch-site': 'cross-site', 'x-csrf-token': CSRF })).status).toBe(403);
    expect((await post(body, { origin: ORIGIN })).status).toBe(403);
    expect((await post(body, { origin: ORIGIN, 'x-csrf-token': 'wrong-token' })).status).toBe(403);
    expect((await dismiss({ origin: 'https://evil.example', 'x-csrf-token': CSRF })).status).toBe(403);
    expect((await dismiss({ origin: ORIGIN })).status).toBe(403);
    expect(h.merge).not.toHaveBeenCalled();
    expect(h.dismiss).not.toHaveBeenCalled();
  });

  it('answers 400 for a bad body, the merge refusals with their codes, and 429 when rate-limited', async () => {
    expect((await post({ keep_id: KEEP })).status).toBe(400);
    expect((await post({ keep_id: KEEP, merge_id: MERGED, extra: 1 })).status).toBe(400);
    expect((await post({ keep_id: 'not-a-uuid', merge_id: MERGED })).status).toBe(400);
    expect(h.merge).not.toHaveBeenCalled();
    for (const [code, status] of [['not_found', 404], ['phone_conflict', 409], ['contact_busy', 409]] as const) {
      h.merge.mockRejectedValueOnce(new MergeError(code));
      const res = await post({ keep_id: KEEP, merge_id: MERGED });
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error: code, code });
    }
    h.limited = true;
    expect((await post({ keep_id: KEEP, merge_id: MERGED })).status).toBe(429);
  });

  it('previews counts on GET without the mutation check', async () => {
    const res = await GET(new Request(`http://localhost:3000/api/contacts/merge?keep_id=${KEEP}&merge_id=${MERGED}`));
    expect(await res.json()).toEqual({ counts });
    expect(h.preview).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: USER, role: 'admin' }, KEEP, MERGED);
    expect(h.merge).not.toHaveBeenCalled();
  });

  it('stores a dismissal for an admin with a valid CSRF token', async () => {
    expect(await (await dismiss()).json()).toEqual({ dismissed: true });
    expect(h.dismiss).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: USER, role: 'admin' }, KEEP, MERGED);
  });
});
