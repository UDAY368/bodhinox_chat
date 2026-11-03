import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError } from '@/lib/auth/errors';
import { AppointmentError } from './types';

const h = vi.hoisted(() => ({
  confirm: vi.fn(), limit: vi.fn(), insert: vi.fn(), queued: [] as unknown[],
  features: { appointments: true }, scope: { pages: true, known: true, created_at: null as Date | null },
  attempts: [] as { attempts: number }[],
}));
vi.mock('./booking', () => ({ confirmHold: h.confirm }));
vi.mock('./schedule-jobs', () => ({ insertJob: h.insert }));
vi.mock('@/lib/auth/service', () => ({ enforceAuthRateLimit: h.limit }));
vi.mock('@/lib/billing/entitlements', () => ({ getEntitlements: async () => ({ features: h.features }) }));
vi.mock('@/lib/db/prisma', () => ({
  getWorkerPrisma: () => 'worker',
  getAuthPrisma: () => ({ $queryRaw: async () => h.attempts }),
}));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (_c: unknown, op: (tx: unknown) => unknown) => op({
    $queryRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('FROM jobs')) return h.queued;
      if (sql.includes('booking_pages')) return [h.scope];
      return [];
    },
  }),
}));

import { handleBookingCode } from './inbound';

const id = '00000000-0000-4000-8000-000000000001';
const input = { accountId: id, userId: id, contactId: id, conversationId: id, messageId: id, whatsappConfigId: id, code: 'ABC234' };

beforeEach(() => {
  vi.clearAllMocks();
  h.queued = [];
  h.features = { appointments: true };
  h.scope = { pages: true, known: true, created_at: null };
  h.attempts = [];
  h.limit.mockResolvedValue(undefined);
  h.insert.mockResolvedValue(true);
});

describe('handleBookingCode', () => {
  it('confirms a hold and keeps the bots silent', async () => {
    h.confirm.mockResolvedValue({ status: 'confirmed', appointment: {} });
    expect(await handleBookingCode(input)).toEqual({ handled: true, outcome: 'confirmed' });
    expect(h.confirm.mock.calls[0][1]).toMatchObject({ accountId: id, code: 'ABC234', contactId: id, whatsappConfigId: id });
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.limit).not.toHaveBeenCalled();
  });

  it('answers a late code once, counting it against the sender', async () => {
    h.confirm.mockRejectedValue(new AppointmentError('hold_expired'));
    expect(await handleBookingCode(input)).toEqual({ handled: true, outcome: 'hold_expired' });
    expect(h.limit).toHaveBeenCalledWith('booking:code', id, 5, 3600);
    expect(h.insert.mock.calls[0][3]).toEqual({ kind: 'hold_reply', contactId: id, messageId: id, reason: 'hold_expired' });
    expect(h.insert.mock.calls[0][4]).toBe(`appt-ntf:${id}:msg:${id}:hold_reply`);
  });

  it('a retried message is neither counted nor answered twice', async () => {
    h.confirm.mockRejectedValue(new AppointmentError('slot_unavailable'));
    h.queued = [{ found: 1 }];
    expect(await handleBookingCode(input)).toEqual({ handled: true, outcome: 'replayed' });
    expect(h.limit).not.toHaveBeenCalled();
    expect(h.insert).not.toHaveBeenCalled();
  });

  it('the miss that crosses the limit stays silent', async () => {
    h.confirm.mockRejectedValue(new AppointmentError('customer_conflict'));
    h.limit.mockRejectedValue(new AuthError('Too many', 429, 'rate_limited'));
    expect(await handleBookingCode(input)).toEqual({ handled: true, outcome: 'rate_limited' });
    expect(h.insert).not.toHaveBeenCalled();
  });

  it('past the bad-code limit a valid held code is not even tried', async () => {
    h.attempts = [{ attempts: 5 }];
    h.confirm.mockResolvedValue({ status: 'confirmed', appointment: {} });
    expect(await handleBookingCode(input)).toEqual({ handled: false, outcome: 'rate_limited' });
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.limit).not.toHaveBeenCalled();
    expect(h.insert).not.toHaveBeenCalled();
  });

  it('below the limit the code is tried', async () => {
    h.attempts = [{ attempts: 4 }];
    h.confirm.mockResolvedValue({ status: 'confirmed', appointment: {} });
    expect(await handleBookingCode(input)).toEqual({ handled: true, outcome: 'confirmed' });
  });

  it('a workspace without the appointments feature never handles the text', async () => {
    h.features = { appointments: false };
    expect(await handleBookingCode({ ...input, code: 'TABLE2' })).toEqual({ handled: false, outcome: 'not_booking' });
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.limit).not.toHaveBeenCalled();
    expect(h.insert).not.toHaveBeenCalled();
  });

  it('a workspace with no booking page never handles the text', async () => {
    h.scope = { pages: false, known: false, created_at: null };
    expect(await handleBookingCode(input)).toEqual({ handled: false, outcome: 'not_booking' });
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.limit).not.toHaveBeenCalled();
  });

  it('"book sunday" with no such code falls through to the bots, counted but not answered', async () => {
    h.scope = { pages: true, known: false, created_at: null };
    expect(await handleBookingCode({ ...input, code: 'SUNDAY' })).toEqual({ handled: false, outcome: 'code_unknown' });
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.limit).toHaveBeenCalledWith('booking:code', id, 5, 3600);
    expect(h.insert).not.toHaveBeenCalled();
  });

  it('a code confirmHold cannot match (another sender, another number) falls through, counted', async () => {
    h.confirm.mockRejectedValue(new AppointmentError('not_found'));
    expect(await handleBookingCode(input)).toEqual({ handled: false, outcome: 'code_unknown' });
    expect(h.limit).toHaveBeenCalledTimes(1);
    expect(h.insert).not.toHaveBeenCalled();
  });

  it('passes the message time to confirmHold', async () => {
    const at = new Date('2026-11-03T10:00:00Z');
    h.scope = { pages: true, known: true, created_at: at };
    h.confirm.mockResolvedValue({ status: 'already_confirmed', appointment: {} });
    expect(await handleBookingCode(input)).toEqual({ handled: true, outcome: 'already_confirmed' });
    expect(h.confirm.mock.calls[0][1].messageAt).toBe(at);
  });

  it('a concurrent change retries with the inbound job; a bad code shape is not handled', async () => {
    h.confirm.mockRejectedValue(new AppointmentError('conflict'));
    await expect(handleBookingCode(input)).rejects.toMatchObject({ code: 'conflict' });
    expect(await handleBookingCode({ ...input, code: 'abc' })).toEqual({ handled: false });
  });
});
