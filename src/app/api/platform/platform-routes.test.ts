// Every /api/platform/* route answers 404 without PLATFORM_DATABASE_URL and to
// anyone who is not an allowlisted platform admin (signed out included), asks
// an admin for a recent MFA confirmation, and only then reaches the platform
// functions - with the session's email, never one from the request.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnauthorizedError } from '@/lib/auth/errors';

const ADMIN = 'ops@bodhinox.test';
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const GRANT = '22222222-2222-4222-8222-222222222222';

const h = vi.hoisted(() => ({
  session: null as null | { userId: string; sessionId: string; user: { email: string } },
  mfa: { factor: true, mfa_verified_at: new Date() as Date | null },
  configured: true,
  assertMutation: vi.fn(async () => {}),
  db: {
    platformTenants: vi.fn(async () => []),
    platformTenant: vi.fn(async () => ({ account_id: '11111111-1111-4111-8111-111111111111' })),
    platformIntegrationHealth: vi.fn(async () => []),
    platformJobBacklog: vi.fn(async () => []),
    platformAuditList: vi.fn(async () => []),
    platformSupportGrants: vi.fn(async () => []),
    platformSupportRequest: vi.fn(async () => '33333333-3333-4333-8333-333333333333'),
    platformSupportDiagnostics: vi.fn(async () => ({ account_id: '11111111-1111-4111-8111-111111111111' })),
    platformSetLifecycle: vi.fn(async () => {}),
    platformDbError: vi.fn((e: unknown) => { throw e; }),
  },
  executeRaw: vi.fn(async () => 1),
}));

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => {
    if (!h.session) throw new UnauthorizedError();
    return h.session;
  },
  resolveSession: async () => h.session,
  assertMutation: h.assertMutation,
}));
vi.mock('@/lib/db/prisma', () => ({
  platformDatabaseConfigured: () => h.configured,
  getAuthPrisma: () => ({ $queryRaw: async () => [h.mfa] }),
  getPlatformPrisma: () => ({ $executeRaw: h.executeRaw }),
}));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: () => ({ success: true }) }));
vi.mock('@/lib/platform/db', () => h.db);

import { GET as tenantsGET } from './tenants/route';
import { GET as tenantGET } from './tenants/[id]/route';
import { GET as healthGET } from './health/route';
import { GET as auditGET } from './audit/route';
import { POST as lifecyclePOST } from './lifecycle/route';
import { GET as supportGET, POST as supportPOST } from './support/route';
import { GET as diagnosticsGET } from './support/[id]/diagnostics/route';

const req = (path: string, body?: unknown) =>
  new Request(`https://crm.test${path}`, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

const calls: [string, () => Promise<Response>][] = [
  ['tenants', () => tenantsGET(req('/api/platform/tenants'))],
  ['tenant', () => tenantGET(req(`/api/platform/tenants/${ACCOUNT}`), params(ACCOUNT))],
  ['health', () => healthGET(req('/api/platform/health'))],
  ['audit', () => auditGET(req('/api/platform/audit'))],
  ['lifecycle', () => lifecyclePOST(req('/api/platform/lifecycle', { accountId: ACCOUNT, status: 'admin_suspended', blockManual: true, reason: 'Abuse report filed' }))],
  ['support list', () => supportGET(req('/api/platform/support'))],
  ['support request', () => supportPOST(req('/api/platform/support', { accountId: ACCOUNT, reason: 'Customer reports failures', minutes: 60 }))],
  ['diagnostics', () => diagnosticsGET(req(`/api/platform/support/${GRANT}/diagnostics`), params(GRANT))],
];

function reachedDatabase(): boolean {
  return Object.values(h.db).some((fn) => fn.mock.calls.length > 0) || h.executeRaw.mock.calls.length > 0;
}

beforeEach(() => {
  vi.stubEnv('PLATFORM_ADMIN_EMAILS', ADMIN);
  h.configured = true;
  h.session = { userId: 'u1', sessionId: 's1', user: { email: 'Ops@Bodhinox.test' } };
  h.mfa = { factor: true, mfa_verified_at: new Date() };
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe('platform console routes', () => {
  it.each(calls)('%s: 404 without PLATFORM_DATABASE_URL, even for an admin', async (_name, call) => {
    h.configured = false;
    expect((await call()).status).toBe(404);
    expect(reachedDatabase()).toBe(false);
  });

  it.each(calls)('%s: 404 for a signed-in non-admin; 401 for a signed-out visitor (so an expired session refreshes)', async (_name, call) => {
    h.session = { userId: 'u2', sessionId: 's2', user: { email: 'owner@customer.example' } };
    expect((await call()).status).toBe(404);
    h.session = null;
    expect((await call()).status).toBe(401);
    expect(reachedDatabase()).toBe(false);
  });

  it.each(calls)('%s: asks an admin without a factor or a recent confirmation for MFA', async (_name, call) => {
    h.mfa = { factor: false, mfa_verified_at: null };
    let response = await call();
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('mfa_enrollment_required');
    h.mfa = { factor: true, mfa_verified_at: new Date(Date.now() - 13 * 3_600_000) };
    response = await call();
    expect((await response.json()).code).toBe('mfa_step_up_required');
    expect(reachedDatabase()).toBe(false);
  });

  it.each(calls)('%s: serves a verified admin', async (_name, call) => {
    expect((await call()).status).toBeLessThan(300);
    expect(reachedDatabase()).toBe(true);
  });

  it('checks the origin on mutations and uses the session email, not the body', async () => {
    await supportPOST(req('/api/platform/support', { accountId: ACCOUNT, reason: 'Customer reports failures', minutes: 60 }));
    expect(h.assertMutation).toHaveBeenCalledTimes(1);
    expect(h.db.platformSupportRequest).toHaveBeenCalledWith({ accountId: ACCOUNT, reason: 'Customer reports failures', minutes: 60, adminEmail: ADMIN });
    expect((await supportPOST(req('/api/platform/support', { accountId: ACCOUNT, reason: 'x', minutes: 60, adminEmail: 'evil@x.y' }))).status).toBe(400);
    await lifecyclePOST(req('/api/platform/lifecycle', { accountId: ACCOUNT, status: 'active', reason: 'Review finished, all clear' }));
    expect(h.assertMutation).toHaveBeenCalledTimes(3);
    expect(h.db.platformSetLifecycle).toHaveBeenCalledWith({ accountId: ACCOUNT, status: 'active', blockManual: false, reason: 'Review finished, all clear', adminEmail: ADMIN });
    await diagnosticsGET(req(`/api/platform/support/${GRANT}/diagnostics`), params(GRANT));
    expect(h.db.platformSupportDiagnostics).toHaveBeenCalledWith(GRANT, ADMIN);
  });

  it('refuses malformed input before the database', async () => {
    expect((await tenantsGET(req('/api/platform/tenants?limit=500'))).status).toBe(400);
    expect((await auditGET(req('/api/platform/audit?accountId=nope'))).status).toBe(400);
    expect((await tenantGET(req('/api/platform/tenants/nope'), params('nope'))).status).toBe(404);
    expect((await diagnosticsGET(req('/api/platform/support/nope/diagnostics'), params('nope'))).status).toBe(403);
    expect((await lifecyclePOST(req('/api/platform/lifecycle', { accountId: ACCOUNT, status: 'closing', reason: 'Owner asked to delete' }))).status).toBe(400);
    expect(reachedDatabase()).toBe(false);
  });
});
