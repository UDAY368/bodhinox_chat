import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const APPT = '33333333-3333-4333-8333-333333333333';
const ID = '44444444-4444-4444-8444-444444444444';

const h = vi.hoisted(() => ({
  role: 'agent' as string,
  mutationOk: true,
  permissionOk: true,
  canManage: true,
  featureOk: true,
  bookError: null as unknown,
  booked: [] as unknown[],
  changes: [] as { fn: string; input: Record<string, unknown> }[],
  audits: [] as unknown[][],
  row: { id: '33333333-3333-4333-8333-333333333333', status: 'confirmed', version: 2, outcome_note: 'staff only', hold_code: 'ABCDEF',
    price_minor: BigInt(50000) },
}));

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => ({ userId: '22222222-2222-4222-8222-222222222222', accountId: '11111111-1111-4111-8111-111111111111',
    role: h.role, sessionId: 's' }),
  assertMutation: async () => {
    if (!h.mutationOk) {
      const { UnauthorizedError } = await import('@/lib/auth/errors');
      throw new UnauthorizedError();
    }
  },
}));
vi.mock('@/lib/auth/permissions', () => ({
  requirePermission: async () => {
    if (!h.permissionOk) {
      const { ForbiddenError } = await import('@/lib/auth/errors');
      throw new ForbiddenError('This feature is turned off for your role');
    }
  },
  can: async () => h.canManage,
}));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (_ctx: unknown, work: (tx: unknown) => Promise<unknown>) => work({
    $queryRaw: async () => [{ id: '55555555-5555-4555-8555-555555555555' }],
    $executeRaw: async (_s: TemplateStringsArray, ...values: unknown[]) => { h.audits.push(values); return 1; },
  }),
}));
vi.mock('@/lib/billing/entitlements', async () => {
  const actual = await vi.importActual<typeof import('@/lib/billing/entitlements')>('@/lib/billing/entitlements');
  const { PlanLimitError } = actual;
  return {
    ...actual,
    requireFeature: async () => {
      if (!h.featureOk) throw new PlanLimitError('Appointments are not included in the Free plan. Upgrade to use them.');
    },
  };
});
vi.mock('@/lib/appointments/listing', async (original) => ({
  ...(await original<typeof import('@/lib/appointments/listing')>()),
  listSchedule: async () => [h.row],
  getAppointmentDetail: async () => ({ appointment: h.row, events: [], messages: [], tasks: [] }),
}));
vi.mock('@/lib/appointments/booking', async (original) => ({
  ...(await original<typeof import('@/lib/appointments/booking')>()),
  bookAppointment: async (_tx: unknown, input: unknown) => {
    if (h.bookError) throw h.bookError;
    h.booked.push(input);
    return { appointment: h.row, replayed: false };
  },
  rescheduleAppointment: async (_tx: unknown, input: Record<string, unknown>) => { h.changes.push({ fn: 'reschedule', input }); return h.row; },
  cancelAppointment: async (_tx: unknown, input: Record<string, unknown>) => { h.changes.push({ fn: 'cancel', input }); return h.row; },
  markOutcome: async (_tx: unknown, input: Record<string, unknown>) => { h.changes.push({ fn: 'outcome', input }); return h.row; },
  updateAppointmentDetails: async (_tx: unknown, input: Record<string, unknown>) => { h.changes.push({ fn: 'details', input }); return h.row; },
}));

import { AppointmentError } from '@/lib/appointments/types';
import { GET, POST } from './route';
import { GET as GET_ONE, PATCH } from './[id]/route';

const list = () => GET(new Request('http://x/api/appointments?from=2026-11-09T00:00:00Z&to=2026-11-16T00:00:00Z'));
const post = (body: unknown) => POST(new Request('http://x/api/appointments', { method: 'POST', body: JSON.stringify(body) }));
const patch = (body: unknown, id = APPT) =>
  PATCH(new Request(`http://x/api/appointments/${id}`, { method: 'PATCH', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
const good = { contact_id: ID, service_id: ID, location_id: ID, start_at: '2026-11-09T03:30:00Z' };

beforeEach(() => {
  Object.assign(h, { role: 'agent', mutationOk: true, permissionOk: true, canManage: true, featureOk: true, bookError: null,
    booked: [], changes: [], audits: [] });
});

describe('GET /api/appointments', () => {
  it('never returns the hold code, and strips the staff note without appointments.manage', async () => {
    h.role = 'viewer';
    h.canManage = false;
    const body = await (await list()).json();
    expect(body.appointments[0]).not.toHaveProperty('hold_code');
    expect(body.appointments[0]).not.toHaveProperty('outcome_note');
    expect(body.appointments[0].price_minor).toBe(50000);
    h.canManage = true;
    expect((await (await list()).json()).appointments[0].outcome_note).toBe('staff only');
    const one = await (await GET_ONE(new Request(`http://x/api/appointments/${APPT}`), { params: Promise.resolve({ id: APPT }) })).json();
    expect(one.appointment).not.toHaveProperty('hold_code');
  });

  it('validates the range and refuses unentitled workspaces with 402', async () => {
    expect((await GET(new Request('http://x/api/appointments?from=bad&to=2026-11-16T00:00:00Z'))).status).toBe(400);
    expect((await GET(new Request('http://x/api/appointments?from=2026-01-01T00:00:00Z&to=2026-12-01T00:00:00Z'))).status).toBe(400);
    h.featureOk = false;
    expect((await list()).status).toBe(402);
  });
});

describe('POST /api/appointments', () => {
  it('books as staff for agents with the permission', async () => {
    const res = await post(good);
    expect(res.status).toBe(201);
    expect(h.booked[0]).toMatchObject({ accountId: ACCOUNT, source: 'staff', actorUserId: USER, staffId: null });
  });

  it('requires CSRF proof, the agent role and appointments.manage', async () => {
    h.mutationOk = false;
    expect((await post(good)).status).toBe(401);
    h.mutationOk = true;
    h.role = 'viewer';
    expect((await post(good)).status).toBe(403);
    h.role = 'agent';
    h.permissionOk = false;
    expect((await post(good)).status).toBe(403);
    expect(h.booked).toEqual([]);
  });

  it('maps domain refusals to code-only responses', async () => {
    expect((await post({ ...good, start_at: 'soon' })).status).toBe(400);
    h.bookError = new AppointmentError('slot_unavailable');
    const res = await post(good);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'slot_unavailable' });
    h.bookError = new Error('connection reset with secret detail');
    const failed = await post(good);
    expect(failed.status).toBe(500);
    expect(JSON.stringify(await failed.json())).not.toContain('secret');
  });
});

describe('PATCH /api/appointments/[id]', () => {
  it('passes the expected version and audits staff reschedules and cancellations', async () => {
    expect((await patch({ action: 'reschedule', expected_version: 2, start_at: '2026-11-10T03:30:00Z' })).status).toBe(200);
    expect(h.changes[0]).toMatchObject({ fn: 'reschedule', input: { expectedVersion: 2, actor: 'staff', actorUserId: USER } });
    expect((await patch({ action: 'cancel', expected_version: 3 })).status).toBe(200);
    expect(h.changes[1].input).toMatchObject({ reason: 'staff', expectedVersion: 3 });
    expect(h.audits.map((v) => v[2])).toEqual(['appointments.appointment.rescheduled', 'appointments.appointment.cancelled']);
  });

  it('refuses a missing version, an unknown action and a malformed id', async () => {
    expect((await patch({ action: 'cancel' })).status).toBe(400);
    expect((await patch({ action: 'delete', expected_version: 1 })).status).toBe(400);
    expect((await patch({ action: 'cancel', expected_version: 1 }, 'not-an-id')).status).toBe(404);
    expect(h.changes).toEqual([]);
  });
});
