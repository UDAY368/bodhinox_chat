import { describe, expect, it } from 'vitest';
import {
  AppointmentFieldError, createException, parseRanges, parseService, resolveLocationTimeZone, setOfferings, SLUG, timeZoneCandidates,
} from './config';
import { AppointmentError } from './types';

const base = { name: 'Free consultation', mode: 'offline', duration_minutes: 30 };
const field = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof AppointmentFieldError ? error.field : error instanceof AppointmentError ? error.code : 'other';
  }
  return null;
};

describe('parseService', () => {
  it('fills defaults and normalises weekdays', () => {
    expect(parseService({ ...base, allowed_weekdays: [3, 1, 1] })).toMatchObject({
      buffer_minutes: 0, capacity: 1, slot_step_minutes: null, allowed_weekdays: [1, 3], payment_required: false, meeting_url: null,
    });
  });

  it('requires name, mode and duration on create', () => {
    expect(field(() => parseService({ mode: 'offline', duration_minutes: 30 }))).toBe('name');
    expect(field(() => parseService({ ...base, mode: 'video' }))).toBe('mode');
    expect(field(() => parseService({ ...base, duration_minutes: 4 }))).toBe('duration_minutes');
  });

  it('allows payment-required services only with a positive price (Phase 8, E15)', () => {
    const detail = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return error instanceof AppointmentFieldError ? `${error.field}:${error.detail}` : 'other';
      }
      return null;
    };
    expect(detail(() => parseService({ ...base, payment_required: true }))).toBe('payment_required:price_required');
    expect(detail(() => parseService({ ...base, payment_required: true, price_minor: 0, currency: 'INR' }))).toBe('payment_required:price_required');
    expect(parseService({ ...base, payment_required: true, price_minor: 50000, currency: 'INR' })).toMatchObject({ payment_required: true });
    // An update that clears the price of a paid service is refused too.
    expect(detail(() => parseService({ price_minor: null, currency: null },
      { ...parseService({ ...base, payment_required: true, price_minor: 50000, currency: 'INR' }) }))).toBe('payment_required:price_required');
  });

  it('keeps price and currency together, meeting links only for online https', () => {
    expect(field(() => parseService({ ...base, price_minor: 50000 }))).toBe('currency');
    expect(parseService({ ...base, price_minor: 50000, currency: 'INR' })).toMatchObject({ price_minor: 50000, currency: 'INR' });
    expect(field(() => parseService({ ...base, meeting_url: 'https://meet.example/x' }))).toBe('meeting_url');
    expect(field(() => parseService({ ...base, mode: 'online', meeting_url: 'http://meet.example/x' }))).toBe('meeting_url');
    expect(parseService({ ...base, mode: 'online', meeting_url: 'https://meet.example/x' }).meeting_url).toBe('https://meet.example/x');
  });

  it('bounds weekdays to ISO 1..7', () => {
    expect(field(() => parseService({ ...base, allowed_weekdays: [0] }))).toBe('allowed_weekdays');
    expect(field(() => parseService({ ...base, allowed_weekdays: [] }))).toBe('allowed_weekdays');
    expect(parseService({ ...base, allowed_weekdays: null }).allowed_weekdays).toBeNull();
  });

  it('on update checks the merged result (switching to offline with a stored link is refused)', () => {
    const current = parseService({ ...base, mode: 'online', meeting_url: 'https://meet.example/x' });
    expect(field(() => parseService({ mode: 'offline' }, current))).toBe('meeting_url');
    expect(parseService({ capacity: 3 }, current)).toMatchObject({ capacity: 3, mode: 'online' });
  });
});

describe('parseRanges and slugs', () => {
  it('validates exception ranges like working hours', () => {
    expect(parseRanges(null)).toBeNull();
    expect(parseRanges([{ start: '14:00', end: '16:00' }, { start: '09:00', end: '10:00' }])).toEqual([
      { start: '09:00', end: '10:00' }, { start: '14:00', end: '16:00' }]);
    expect(field(() => parseRanges([{ start: '10:00', end: '09:00' }]))).toBe('ranges');
    expect(field(() => parseRanges([]))).toBe('ranges');
  });

  it('accepts lower-case slugs only', () => {
    expect(SLUG.test('dr-sharma-clinic')).toBe(true);
    expect(SLUG.test('Dr-Sharma')).toBe(false);
    expect(SLUG.test('-x-')).toBe(false);
    expect(SLUG.test('ab')).toBe(false);
  });
});

describe('location time zones', () => {
  it('refuses offset forms Postgres would read the other way round, and canonicalises case and aliases', async () => {
    expect(field(() => timeZoneCandidates('+05:30'))).toBe('timezone');
    expect(field(() => timeZoneCandidates('-0300'))).toBe('timezone');
    expect(field(() => timeZoneCandidates('Not/AZone'))).toBe('timezone');
    expect(timeZoneCandidates('Asia/Kolkata')[0]).toBe('Asia/Kolkata');
    expect(timeZoneCandidates('america/new_york')).toContain('America/New_York');
    expect(timeZoneCandidates('US/Pacific-New')).toContain('America/Los_Angeles');
  });

  it('stores the first name Postgres knows, and refuses an ICU-only alias as a field error', async () => {
    const tx = (known: string[]) => ({
      $queryRaw: async (_s: TemplateStringsArray, names: string[]) => names.filter((n) => known.includes(n)).map((name) => ({ name })),
    }) as never;
    expect(await resolveLocationTimeZone(tx(['Asia/Kolkata']), 'Asia/Kolkata')).toBe('Asia/Kolkata');
    expect(await resolveLocationTimeZone(tx(['America/Los_Angeles']), 'US/Pacific-New')).toBe('America/Los_Angeles');
    expect(await resolveLocationTimeZone(tx(['America/New_York']), 'america/new_york')).toBe('America/New_York');
    await expect(resolveLocationTimeZone(tx([]), 'US/Pacific-New')).rejects.toMatchObject({ field: 'timezone' });
  });

  it('saves an old alias the browser reports under its current name when Postgres lacks the alias', async () => {
    const tx = (known: string[]) => ({
      $queryRaw: async (_s: TemplateStringsArray, names: string[]) => names.filter((n) => known.includes(n)).map((name) => ({ name })),
    }) as never;
    // Chrome on Windows reports Asia/Calcutta; Debian tzdata without the legacy package lists only Asia/Kolkata.
    expect(timeZoneCandidates('Asia/Calcutta')[0]).toBe('Asia/Kolkata');
    expect(await resolveLocationTimeZone(tx(['Asia/Kolkata']), 'Asia/Calcutta')).toBe('Asia/Kolkata');
    expect(await resolveLocationTimeZone(tx(['Asia/Kolkata', 'Asia/Calcutta']), 'Asia/Calcutta')).toBe('Asia/Kolkata');
    expect(await resolveLocationTimeZone(tx(['Europe/Kyiv']), 'Europe/Kiev')).toBe('Europe/Kyiv');
  });
});

describe('createException dates', () => {
  it('refuses impossible calendar dates before any SQL', async () => {
    const tx = { $queryRaw: () => { throw new Error('no SQL expected'); } } as never;
    const body = { location_id: '00000000-0000-4000-8000-000000000001', starts_on: '2026-02-30', ends_on: '2026-03-01' };
    await expect(createException(tx, 'a', null, body)).rejects.toMatchObject({ field: 'starts_on' });
    await expect(createException(tx, 'a', null, { ...body, starts_on: '2026-02-01', ends_on: '2026-02-30' })).rejects.toMatchObject({ field: 'ends_on' });
  });
});

describe('setOfferings shape switch', () => {
  it('refuses to switch pooled/staffed while the other shape has active future bookings', async () => {
    const statements: string[] = [];
    const tx = {
      $executeRaw: async (s: TemplateStringsArray) => { statements.push(s.join('?')); return 1; },
      $queryRaw: async (s: TemplateStringsArray) => {
        const sql = s.join('?');
        statements.push(sql);
        if (sql.includes('AS ok')) return [{ ok: true }];
        if (sql.includes('AS busy')) return [{ busy: true }];
        return [];
      },
    } as never;
    const body = { service_id: '00000000-0000-4000-8000-000000000001', location_id: '00000000-0000-4000-8000-000000000002', pooled: true };
    await expect(setOfferings(tx, 'a', null, body)).rejects.toMatchObject({ field: 'pooled', detail: 'mode_in_use' });
    expect(statements.some((sql) => sql.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(statements.some((sql) => sql.includes('DELETE FROM appointment_offerings'))).toBe(false);
  });
});
