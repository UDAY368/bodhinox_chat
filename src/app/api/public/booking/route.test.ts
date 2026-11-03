import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const PAGE = '22222222-2222-4222-8222-222222222222';
const SERVICE = '33333333-3333-4333-8333-333333333333';
const LOCATION = '44444444-4444-4444-8444-444444444444';
const APPT = '55555555-5555-4555-8555-555555555555';
const REQUEST = '66666666-6666-4666-8666-666666666666';
const TOKEN = 'A'.repeat(43);
const ORIGIN = 'http://localhost:3000';

const h = vi.hoisted(() => ({
  pageHit: true,
  tokenHit: true,
  featureOk: true,
  suspended: false,
  durableLimited: false,
  booked: [] as Record<string, unknown>[],
  changes: [] as { fn: string; input: Record<string, unknown> }[],
  bookError: null as unknown,
  definerCalls: 0,
  startAt: new Date('2026-11-09T04:30:00Z'),
  status: 'confirmed' as string,
  meetingUrl: null as string | null,
}));

vi.mock('@/lib/db/prisma', () => ({
  getWorkerPrisma: () => ({
    $queryRaw: async (strings: TemplateStringsArray) => {
      h.definerCalls += 1;
      const sql = strings.join('?');
      if (sql.includes('resolve_booking_page')) return h.pageHit ? [{ account_id: ACCOUNT, page_id: PAGE }] : [];
      if (sql.includes('resolve_appointment_token')) return h.tokenHit ? [{ account_id: ACCOUNT, appointment_id: APPT }] : [];
      return [];
    },
  }),
}));

function fakeTx() {
  return {
    $queryRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('FROM booking_pages p JOIN accounts')) return [{ id: PAGE, title: 'Clinic', location_id: null, whatsapp_config_id: null, business_name: 'Acme Clinic' }];
      if (sql.includes('FROM booking_page_services ps JOIN appointment_services')) return [{ id: SERVICE, name: 'Free consultation', mode: 'offline',
        duration_minutes: 30, price_minor: BigInt(0), currency: 'INR', capacity: 1, payment_required: false }];
      if (sql.includes('FROM appointment_offerings o')) return [{ service_id: SERVICE, staff_id: null, staff_name: null, location_id: LOCATION,
        name: 'Main', address: 'MG Road', timezone: 'Asia/Kolkata', kind: 'physical' }];
      if (sql.includes('SELECT EXISTS(')) return [{ ok: true }];
      if (sql.includes('FROM appointments a JOIN accounts acc')) return [{ status: h.status, version: 2, service_name: 'Free consultation',
        staff_name: 'Dr Rao', location_name: 'Main', location_address: 'MG Road', location_kind: 'physical', start_at: h.startAt,
        end_at: new Date(h.startAt.getTime() + 30 * 60_000), timezone: 'Asia/Kolkata', price_minor: null, currency: null,
        meeting_url: h.meetingUrl, business_name: 'Acme Clinic' }];
      if (sql.includes('FROM appointments WHERE')) return [{ id: APPT, status: h.status, version: 2, service_id: SERVICE, location_id: LOCATION,
        staff_id: null, start_at: h.startAt, end_at: h.startAt }];
      return [];
    },
    $queryRawUnsafe: async () => [],
  };
}

vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (ctx: { accountId: string; role: string }, work: (tx: unknown) => Promise<unknown>) => {
    if (ctx.accountId !== ACCOUNT || ctx.role !== 'owner') throw new Error('unexpected tenant');
    return work(fakeTx());
  },
}));
vi.mock('@/lib/billing/entitlements', async (original) => {
  const actual = await original<typeof import('@/lib/billing/entitlements')>();
  return { ...actual, requireFeature: async () => {
    if (!h.featureOk) throw new actual.PlanLimitError('Appointments are not included in the Free plan. Upgrade to use them.');
  } };
});
vi.mock('@/lib/billing/suspension', () => ({
  requireSendingAllowed: async () => {
    if (h.suspended) {
      const { PlanLimitError } = await import('@/lib/billing/entitlements');
      throw new PlanLimitError('suspended');
    }
  },
}));
vi.mock('@/lib/auth/service', () => ({
  enforceAuthRateLimit: async () => {
    if (h.durableLimited) {
      const { AuthError } = await import('@/lib/auth/errors');
      throw new AuthError('Too many attempts. Try again later.', 429, 'rate_limited');
    }
  },
}));
vi.mock('@/lib/appointments/availability', () => ({
  loadSettings: async () => ({ customer_cancel_cutoff_minutes: 120 }),
  listSlots: async () => ({ timezone: 'Asia/Kolkata', slots: [{ startAt: 'a', endAt: 'b', localDate: '2026-11-09', hhmm: '10:00',
    staffIds: ['77777777-7777-4777-8777-777777777777'], remaining: 1 }] }),
}));
vi.mock('@/lib/appointments/booking', async () => {
  return {
    bookAppointment: async (_tx: unknown, input: Record<string, unknown>) => {
      if (h.bookError) throw h.bookError;
      h.booked.push(input);
      return { replayed: false, appointment: { id: APPT, status: 'held', hold_code: 'ABC234', hold_expires_at: new Date('2026-11-03T10:15:00Z'),
        start_at: input.startAt, end_at: new Date((input.startAt as Date).getTime() + 1_800_000), timezone: 'Asia/Kolkata',
        intake: input.intake, contact_id: null } };
    },
    cancelAppointment: async (_tx: unknown, input: Record<string, unknown>) => { h.changes.push({ fn: 'cancel', input }); },
    rescheduleAppointment: async (_tx: unknown, input: Record<string, unknown>) => {
      h.changes.push({ fn: 'reschedule', input });
      if (h.bookError) throw h.bookError;
    },
    // Phase 8: paid services are listed only while online payment is available.
    paidBookingReady: async () => false,
  };
});

import { AppointmentError } from '@/lib/appointments/types';
import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { GET as GET_PAGE, POST as POST_HOLD } from './[slug]/route';
import { GET as GET_SLOTS } from './[slug]/slots/route';
import { GET as GET_MANAGE, POST as POST_MANAGE } from './manage/[token]/route';
import { GET as GET_MANAGE_SLOTS } from './manage/[token]/slots/route';

const slug = (s = 'acme-clinic') => ({ params: Promise.resolve({ slug: s }) });
const token = (t = TOKEN) => ({ params: Promise.resolve({ token: t }) });
const post = (url: string, body: unknown, origin: string | null = ORIGIN) => new Request(url, {
  method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
});
const holdBody = { serviceId: SERVICE, locationId: LOCATION, startAt: '2026-11-09T04:30:00.000Z', requestId: REQUEST, intake: { name: 'Asha' } };

beforeEach(() => {
  process.env.APP_URL = ORIGIN;
  Object.assign(h, { pageHit: true, tokenHit: true, featureOk: true, suspended: false, durableLimited: false, bookError: null,
    definerCalls: 0, status: 'confirmed', meetingUrl: null, startAt: new Date(Date.now() + 3 * 86_400_000) });
  h.booked.length = 0;
  h.changes.length = 0;
  __resetRateLimitForTests();
});

describe('identical 404s', () => {
  async function body404(response: Response) {
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    return response.text();
  }

  it('unknown, malformed, unentitled and suspended pages look the same', async () => {
    const bodies: string[] = [];
    h.pageHit = false;
    bodies.push(await body404(await GET_PAGE(new Request('http://x/api/public/booking/acme-clinic'), slug())));
    h.pageHit = true;
    h.definerCalls = 0;
    bodies.push(await body404(await GET_PAGE(new Request('http://x/api/public/booking/x'), slug('Bad Slug!'))));
    expect(h.definerCalls).toBe(0);
    h.featureOk = false;
    bodies.push(await body404(await GET_PAGE(new Request('http://x/api/public/booking/acme-clinic'), slug())));
    h.featureOk = true;
    h.suspended = true;
    bodies.push(await body404(await GET_PAGE(new Request('http://x/api/public/booking/acme-clinic'), slug())));
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).not.toMatch(/upgrade|plan|suspend/i);
  });

  it('unknown, malformed, unentitled and suspended manage tokens look the same', async () => {
    const bodies: string[] = [];
    h.definerCalls = 0;
    bodies.push(await body404(await GET_MANAGE(new Request('http://x'), token('short'))));
    expect(h.definerCalls).toBe(0);
    h.tokenHit = false;
    bodies.push(await body404(await GET_MANAGE(new Request('http://x'), token())));
    h.tokenHit = true;
    h.featureOk = false;
    bodies.push(await body404(await GET_MANAGE(new Request('http://x'), token())));
    h.featureOk = true;
    h.suspended = true;
    bodies.push(await body404(await GET_MANAGE(new Request('http://x'), token())));
    expect(new Set(bodies).size).toBe(1);
  });
});

describe('booking page', () => {
  it('lists services, locations and times with no practitioner ids in slots', async () => {
    const page = await (await GET_PAGE(new Request('http://x'), slug())).json();
    expect(page).toMatchObject({ businessName: 'Acme Clinic', services: [{ id: SERVICE, priceMinor: 0, locations: [{ id: LOCATION, timezone: 'Asia/Kolkata' }] }] });
    const slots = await (await GET_SLOTS(new Request(`http://x/s?service=${SERVICE}&location=${LOCATION}&from=2026-11-09&days=7`), slug())).json();
    expect(slots.slots[0]).toEqual({ startAt: 'a', endAt: 'b', localDate: '2026-11-09', hhmm: '10:00', remaining: 1 });
  });

  it('refuses more than the public number of days', async () => {
    const response = await GET_SLOTS(new Request(`http://x/s?service=${SERVICE}&location=${LOCATION}&days=8`), slug());
    expect(response.status).toBe(400);
  });

  it('refuses an impossible calendar date with 400, not a database error', async () => {
    const response = await GET_SLOTS(new Request(`http://x/s?service=${SERVICE}&location=${LOCATION}&from=2026-02-30&days=7`), slug());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: 'invalid' });
  });
});

describe('holding a slot', () => {
  it('creates a public hold with no contact and returns only the code', async () => {
    const response = await POST_HOLD(post('http://x', holdBody), slug());
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toEqual({ holdCode: 'ABC234', holdExpiresAt: '2026-11-03T10:15:00.000Z', startAt: '2026-11-09T04:30:00.000Z',
      endAt: '2026-11-09T05:00:00.000Z', timezone: 'Asia/Kolkata', whatsappUrl: null });
    expect(JSON.stringify(body)).not.toContain('Asha');
    expect(h.booked[0]).toMatchObject({ accountId: ACCOUNT, source: 'public', bookingPageId: PAGE, sourceRef: `public:${PAGE}:${REQUEST}`,
      intake: { name: 'Asha' } });
    expect(h.booked[0].contactId).toBeUndefined();
    expect(h.booked[0].clientHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a cross-origin POST, even with no session involved', async () => {
    expect((await POST_HOLD(post('http://x', holdBody, 'https://evil.example'), slug())).status).toBe(403);
    expect((await POST_HOLD(post('http://x', holdBody, null), slug())).status).toBe(403);
    expect(h.booked).toHaveLength(0);
  });

  it('maps the durable limit to a code-only too_many', async () => {
    h.durableLimited = true;
    const response = await POST_HOLD(post('http://x', holdBody), slug());
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ code: 'too_many' });
    expect(h.booked).toHaveLength(0);
  });

  it('returns domain refusals as codes only', async () => {
    h.bookError = new AppointmentError('slot_unavailable');
    const response = await POST_HOLD(post('http://x', holdBody), slug());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: 'slot_unavailable' });
  });

  it('refuses a phone field or a bad body', async () => {
    expect((await POST_HOLD(post('http://x', { ...holdBody, requestId: 'nope' }), slug())).status).toBe(400);
    expect((await POST_HOLD(post('http://x', { ...holdBody, intake: { name: 'x'.repeat(200) } }), slug())).status).toBe(400);
  });
});

describe('manage page', () => {
  it('shows the booking without customer data and hides a far-off meeting link', async () => {
    h.meetingUrl = 'https://meet.example/abc';
    const view = await (await GET_MANAGE(new Request('http://x'), token())).json();
    expect(view).toMatchObject({ businessName: 'Acme Clinic', status: 'confirmed', version: 2, practitioner: 'Dr Rao', online: true,
      meetingUrl: null, meetingLinkLater: true, canChange: true });
    expect(Object.keys(view)).not.toEqual(expect.arrayContaining(['contact', 'phone', 'name', 'intake', 'outcomeNote']));
  });

  it('shows the meeting link within 24 hours of a confirmed online booking', async () => {
    h.meetingUrl = 'https://meet.example/abc';
    h.startAt = new Date(Date.now() + 3 * 3_600_000);
    const view = await (await GET_MANAGE(new Request('http://x'), token())).json();
    expect(view.meetingUrl).toBe('https://meet.example/abc');
    expect(view.canChange).toBe(true);
  });

  it('cancels and reschedules as the customer with the expected version', async () => {
    expect((await POST_MANAGE(post('http://x', { action: 'cancel', expectedVersion: 2 }), token())).status).toBe(200);
    expect((await POST_MANAGE(post('http://x', { action: 'reschedule', startAt: '2026-11-16T04:30:00Z', expectedVersion: 2 }), token())).status).toBe(200);
    expect(h.changes[0]).toEqual({ fn: 'cancel', input: { accountId: ACCOUNT, appointmentId: APPT, actor: 'customer', expectedVersion: 2, reason: 'customer' } });
    expect(h.changes[1].input).toMatchObject({ actor: 'customer', expectedVersion: 2 });
    expect(h.changes[1].input.staffId).toBeUndefined();
  });

  it('rejects a cross-origin change and a missing version', async () => {
    expect((await POST_MANAGE(post('http://x', { action: 'cancel', expectedVersion: 2 }, 'https://evil.example'), token())).status).toBe(403);
    expect((await POST_MANAGE(post('http://x', { action: 'cancel' }), token())).status).toBe(400);
    expect(h.changes).toHaveLength(0);
  });

  it('refuses reschedule slots after the cutoff', async () => {
    h.startAt = new Date(Date.now() + 30 * 60_000);
    const response = await GET_MANAGE_SLOTS(new Request('http://x/s?days=7'), token());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: 'conflict' });
  });
});
