import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import en from '../../../messages/en.json';
import type { ContactBooking } from '@/lib/appointments/contact-bookings';
import { cardStateFrom, ContactAppointmentsView, type CardState } from './contact-appointments-card';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ accountRole: 'agent' }) }));

const render = (card: CardState, extra: { compact?: boolean; canBook?: boolean } = {}) => renderToStaticMarkup(
  <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
    <ContactAppointmentsView card={card} canBook={extra.canBook ?? true} compact={extra.compact}
      onRetry={() => {}} onNew={() => {}} onMore={() => {}} />
  </NextIntlClientProvider>,
);

const booking = (over: Partial<ContactBooking> = {}): ContactBooking => ({
  id: '33333333-3333-4333-8333-333333333333', service_name: 'Consult', start_at: '2026-12-01T03:30:00.000Z',
  end_at: '2026-12-01T04:00:00.000Z', timezone: 'Asia/Kolkata', status: 'confirmed', payment_status: 'none', ...over,
});
const ready = (upcoming: ContactBooking[], past: ContactBooking[], next: string | null = null): CardState => ({
  state: 'ready', upcoming: { items: upcoming, next, loadingMore: false }, past: { items: past, next: null, loadingMore: false },
});

describe('ContactAppointmentsView', () => {
  it('shows a placeholder while loading', () => {
    const html = render({ state: 'loading' });
    expect(html).toContain('Bookings');
    expect(html).not.toContain('No bookings yet');
  });

  it('says what failed and offers Retry', () => {
    const html = render({ state: 'failed' });
    expect(html).toContain("Couldn&#x27;t load bookings.");
    expect(html).toContain('Retry');
  });

  it('renders nothing when the plan has no appointments', () => {
    expect(render({ state: 'unavailable' })).toBe('');
  });

  it('empty: one line and a New booking action, only for members who can book', () => {
    const html = render(ready([], []));
    expect(html).toContain('No bookings yet');
    expect(html).toContain('New booking');
    expect(render(ready([], []), { canBook: false })).not.toContain('New booking');
  });

  it('lists upcoming and past bookings in the booking zone, each linking to the booking', () => {
    const html = render(ready([booking()], [booking({ id: '44444444-4444-4444-8444-444444444444', status: 'no_show' })], 'cursor'));
    expect(html).toContain('Upcoming');
    expect(html).toContain('Past and cancelled');
    expect(html).toContain('href="/appointments?id=33333333-3333-4333-8333-333333333333"');
    expect(html).toContain('href="/appointments?id=44444444-4444-4444-8444-444444444444"');
    // 03:30 UTC is 9:00 in Kolkata.
    expect(html).toMatch(/9:00/);
    expect(html).toContain('data-status="no_show"');
    expect(html).toContain('Show more');
    expect(render(ready([booking()], [], 'cursor'), { compact: true })).not.toContain('Show more');
  });

  it('says a held paid booking is waiting for payment', () => {
    expect(render(ready([booking({ status: 'held', payment_status: 'pending' })], []))).toContain('Waiting for payment');
  });
});

describe('cardStateFrom', () => {
  it('maps responses to states', () => {
    expect(cardStateFrom({ ok: false, status: 402 })).toEqual({ state: 'unavailable' });
    expect(cardStateFrom({ ok: false, status: 500 })).toEqual({ state: 'failed' });
    const page = { items: [booking()], next: null };
    expect(cardStateFrom({ ok: true, data: { upcoming: page, past: page } })).toMatchObject({ state: 'ready' });
  });
});
