import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/client', () => ({ authFetch: vi.fn(async () => new Response('{}', { status: 200 })) }));
vi.mock('@/lib/data/client', () => ({ createClient: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

import en from '../../../messages/en.json';
import {
  abilitiesFor, failureKey, fromMinor, groupByLocalDate, scheduleWindow, toMinor, type AppointmentConfig,
} from './shared';
import { messageReasonKey } from './appointment-sheet';
import { offeringChoices } from './new-appointment-dialog';
import { EMPTY_SERVICE, serviceBody } from './services-panel';
import { templateChoices, type TemplateOption } from './settings-panel';
import { bookingLink, SLUG_PATTERN } from './booking-pages-panel';
import { ScheduleView } from './schedule-view';

describe('failureKey', () => {
  it('maps plan, field, template and domain refusals to code-only messages', () => {
    expect(failureKey({ ok: false, status: 402 })).toBe('Appointments.errors.feature_unavailable');
    expect(failureKey({ ok: false, status: 400, code: 'invalid', field: 'reminder_template_name', detail: 'url_button_base' }))
      .toBe('AppointmentSettings.templateErrors.url_button_base');
    expect(failureKey({ ok: false, status: 400, code: 'invalid', field: 'confirm_template_name', detail: 'not_approved' }))
      .toBe('AppointmentSettings.templateErrors.not_approved');
    expect(failureKey({ ok: false, status: 400, code: 'invalid', field: 'slug', detail: 'taken' })).toBe('Appointments.fieldErrors.taken');
    expect(failureKey({ ok: false, status: 409, code: 'slot_unavailable' })).toBe('Appointments.errors.slot_unavailable');
    expect(failureKey({ ok: false, status: 409, code: 'conflict' })).toBe('Appointments.errors.conflict');
    expect(failureKey({ ok: false, status: 403 })).toBe('Appointments.readOnly');
    // An unknown code never echoes anything from the server.
    expect(failureKey({ ok: false, status: 500, code: '<script>' })).toBe('Appointments.errors.invalid');
  });

  it('every mapped key exists in the English messages', () => {
    const get = (k: string) => k.split('.').reduce<unknown>((o, p) => (o as Record<string, unknown> | undefined)?.[p], en);
    for (const code of ['slot_unavailable', 'day_not_allowed', 'customer_conflict', 'too_many', 'hold_expired', 'conflict', 'not_found', 'invalid'])
      expect(get(failureKey({ ok: false, status: 400, code }))).toBeTypeOf('string');
    expect(get(failureKey({ ok: false, status: 402 }))).toBeTypeOf('string');
    expect(get(failureKey({ ok: false, status: 403 }))).toBeTypeOf('string');
  });
});

describe('abilitiesFor', () => {
  it('follows the role ceilings of appointments.manage (agent) and appointments.settings (admin)', () => {
    expect(abilitiesFor('viewer')).toEqual({ manage: false, settings: false, resolve: false });
    expect(abilitiesFor('agent')).toEqual({ manage: true, settings: false, resolve: false });
    expect(abilitiesFor('admin')).toEqual({ manage: true, settings: true, resolve: true });
    expect(abilitiesFor(null)).toEqual({ manage: false, settings: false, resolve: false });
  });
});

describe('schedule helpers', () => {
  it('a Kolkata week starts at local midnight (the previous UTC evening)', () => {
    const w = scheduleWindow('week', '2026-11-09', 'Asia/Kolkata');
    expect(w.from.toISOString()).toBe('2026-11-08T18:30:00.000Z');
    expect(w.to.toISOString()).toBe('2026-11-15T18:30:00.000Z');
    expect(w.days).toHaveLength(7);
    expect(scheduleWindow('day', '2026-11-09', 'UTC').days).toEqual(['2026-11-09']);
  });

  it('groups by each row\'s own local date, not the UTC date', () => {
    // Monday 00:30 IST is Sunday 19:00 UTC: it belongs to Monday.
    const rows = [
      { id: 'b', local_date: '2026-11-09', start_at: '2026-11-09T04:30:00.000Z' },
      { id: 'a', local_date: '2026-11-09T00:00:00.000Z', start_at: '2026-11-08T19:00:00.000Z' },
      { id: 'c', local_date: '2026-11-10', start_at: '2026-11-10T05:00:00.000Z' },
    ];
    const groups = groupByLocalDate(rows);
    expect(groups.map(([d, r]) => [d, r.map((x) => x.id)])).toEqual([['2026-11-09', ['a', 'b']], ['2026-11-10', ['c']]]);
  });
});

describe('prices', () => {
  it('converts by the currency\'s decimals', () => {
    expect(toMinor('499.50', 'INR')).toBe(49950);
    expect(toMinor('1000', 'JPY')).toBe(1000);
    expect(toMinor('', 'INR')).toBeNull();
    expect(toMinor('12,5', 'INR')).toBeUndefined();
    expect(fromMinor(49950, 'INR')).toBe('499.50');
    expect(fromMinor(null, 'INR')).toBe('');
  });
});

describe('serviceBody', () => {
  it('builds the Monday-only offline free consultation', () => {
    const r = serviceBody({ ...EMPTY_SERVICE, name: 'Free consultation', weekdays: [1], meetingUrl: 'https://x.test/m' });
    expect('body' in r && r.body).toMatchObject({ name: 'Free consultation', mode: 'offline', allowed_weekdays: [1], meeting_url: null, price_minor: null, currency: null });
  });

  it('refuses a price without a currency and an empty weekday list', () => {
    expect(serviceBody({ ...EMPTY_SERVICE, name: 'x', price: '100' })).toEqual({ invalid: 'currency' });
    expect(serviceBody({ ...EMPTY_SERVICE, name: 'x', weekdays: [] })).toEqual({ invalid: 'allowed_weekdays' });
    expect(serviceBody({ ...EMPTY_SERVICE, name: 'x', price: 'abc', currency: 'INR' })).toEqual({ invalid: 'price_minor' });
  });

  it('never sends advance payment (not supported until payments)', () => {
    const r = serviceBody({ ...EMPTY_SERVICE, name: 'Paid', price: '500', currency: 'inr', mode: 'online', meetingUrl: 'https://meet.test/a' });
    expect('body' in r && r.body).toMatchObject({ price_minor: 50000, currency: 'INR', meeting_url: 'https://meet.test/a' });
    expect('body' in r && 'payment_required' in r.body).toBe(false);
  });
});

describe('templateChoices', () => {
  const base = { header_type: null, header_content: null, header_media_url: null, template_kind: null, cards: null, lto: null } as const;
  const tpl = (over: Partial<TemplateOption>): TemplateOption =>
    ({ id: 'i', name: 'n', language: 'en', category: 'Utility', body_text: 'Hi {{1}}', buttons: [], ...base, ...over } as TemplateOption);

  it('marks templates that cannot carry appointment messages', () => {
    const origin = 'https://app.test';
    const choices = templateChoices([
      tpl({ name: 'ok', buttons: [{ type: 'URL', text: 'Manage', url: 'https://app.test/my-booking/{{1}}' }] as TemplateOption['buttons'] }),
      tpl({ name: 'promo', category: 'Marketing' }),
      tpl({ name: 'wrong', buttons: [{ type: 'URL', text: 'Go', url: 'https://evil.test/{{1}}' }] as TemplateOption['buttons'] }),
    ], origin);
    expect(choices.map((c) => [c.key, c.refusal])).toEqual([['ok|en', null], ['promo|en', 'not_utility'], ['wrong|en', 'url_button_base']]);
  });
});

describe('small helpers', () => {
  it('maps stored reason codes to known translations only', () => {
    expect(messageReasonKey('contact_blocked')).toBe('contact_blocked');
    expect(messageReasonKey('past_due_24h')).toBe('past_due');
    expect(messageReasonKey('something_new')).toBe('other');
    expect(messageReasonKey(null)).toBe('other');
  });

  it('booking links and slugs', () => {
    expect(bookingLink('https://app.test/', 'clinic-one')).toBe('https://app.test/book/clinic-one');
    expect(SLUG_PATTERN.test('clinic-one')).toBe(true);
    expect(SLUG_PATTERN.test('-bad')).toBe(false);
  });

  it('offers only active locations and practitioners that offer the service', () => {
    const config = {
      locations: [{ id: 'L1', archived_at: null }, { id: 'L2', archived_at: '2026-01-01' }, { id: 'L3', archived_at: null }],
      staff: [{ id: 'S1', archived_at: null }, { id: 'S2', archived_at: '2026-01-01' }],
      offerings: [
        { id: 'o1', service_id: 'A', staff_id: 'S1', location_id: 'L1' },
        { id: 'o2', service_id: 'A', staff_id: 'S2', location_id: 'L1' },
        { id: 'o3', service_id: 'A', staff_id: null, location_id: 'L2' },
        { id: 'o4', service_id: 'B', staff_id: null, location_id: 'L3' },
      ],
    } as unknown as AppointmentConfig;
    const c = offeringChoices(config, 'A');
    expect(c.locations.map((l) => l.id)).toEqual(['L1']);
    expect(c.staffAt('L1').map((s) => s.id)).toEqual(['S1']);
  });
});

describe('ScheduleView', () => {
  const config: AppointmentConfig = { services: [], staff: [], locations: [], offerings: [] };
  const render = (manage: boolean) => renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <ScheduleView config={config} abilities={{ manage, settings: false, resolve: false }} onOpen={() => {}} onNew={() => {}} refreshKey={0} />
    </NextIntlClientProvider>,
  );

  it('offers "New appointment" only to members who can manage appointments', () => {
    expect(render(false)).not.toContain('New appointment');
    expect(render(true)).toContain('New appointment');
  });
});
