import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  role: 'viewer' as string,
  sql: [] as string[],
}));

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => ({ userId: '22222222-2222-4222-8222-222222222222', accountId: '11111111-1111-4111-8111-111111111111',
    role: h.role, sessionId: 's' }),
  assertMutation: async () => undefined,
}));
vi.mock('@/lib/auth/permissions', () => ({ requirePermission: async () => undefined }));
vi.mock('@/lib/billing/entitlements', async (original) => ({
  ...(await original<typeof import('@/lib/billing/entitlements')>()),
  requireFeature: async () => undefined,
}));
// Answers like Postgres would: only the selected columns come back.
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (_ctx: unknown, work: (tx: unknown) => Promise<unknown>) => work({
    $queryRawUnsafe: async (sql: string) => {
      h.sql.push(sql);
      const row: Record<string, unknown> = { id: 's1', display_name: 'Dr A', user_id: null, archived_at: null };
      if (/meeting_host_email/.test(sql.split('FROM')[0])) row.meeting_host_email = 'dr.a@clinic.example';
      return [row];
    },
  }),
}));

import { GET } from './route';

const list = async () => {
  const res = await GET(new Request('http://x/api/appointments/staff'));
  return { status: res.status, body: await res.json() as { staff: Record<string, unknown>[] } };
};

beforeEach(() => { h.role = 'viewer'; h.sql = []; });

describe('GET /api/appointments/staff', () => {
  it('never reads or returns the Zoom host email for viewers', async () => {
    const { status, body } = await list();
    expect(status).toBe(200);
    expect(body.staff).toEqual([{ id: 's1', display_name: 'Dr A', user_id: null, archived_at: null }]);
    expect(body.staff[0]).not.toHaveProperty('meeting_host_email');
    expect(h.sql[0]).not.toMatch(/meeting_host_email/);
  });

  it.each(['agent', 'admin', 'owner'])('returns the Zoom host email to %s', async (role) => {
    h.role = role;
    const { status, body } = await list();
    expect(status).toBe(200);
    expect(body.staff[0]).toMatchObject({ id: 's1', meeting_host_email: 'dr.a@clinic.example' });
  });
});
