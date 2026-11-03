import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import en from '../../../messages/en.json';
import { AppointmentStatusBadge } from './appointment-status-badge';
import { SlotPicker } from './slot-picker';
import type { Slot } from '@/lib/appointments/types';

const render = (node: React.ReactNode) =>
  renderToStaticMarkup(<NextIntlClientProvider locale="en" messages={en} timeZone="UTC">{node}</NextIntlClientProvider>);

const slot = (startAt: string, remaining = 1): Slot => ({
  startAt, endAt: startAt, localDate: '2026-11-09', hhmm: '', staffIds: [], remaining,
});

describe('AppointmentStatusBadge', () => {
  it('renders the translated status', () => {
    expect(render(<AppointmentStatusBadge status="held" />)).toContain('Awaiting WhatsApp');
    expect(render(<AppointmentStatusBadge status="no_show" />)).toContain('data-status="no_show"');
  });
});

describe('SlotPicker', () => {
  const props = { dates: ['2026-11-09', '2026-11-16'], onDateChange: () => {}, onSelect: () => {}, timeZone: 'Asia/Kolkata' };

  it('shows times in the location zone, never the viewer zone', () => {
    // 2026-11-09T03:30Z is 09:00 in Kolkata.
    const html = render(<SlotPicker {...props} selectedDate="2026-11-09" slots={[slot('2026-11-09T03:30:00.000Z')]} />);
    expect(html).toContain('9:00');
    expect(html).toContain('GMT+5:30');
    expect(html).toContain('Mon, Nov 9');
  });

  it('marks the selected slot and shows remaining places on request', () => {
    const html = render(
      <SlotPicker {...props} selectedDate="2026-11-09" selectedStartAt="2026-11-09T03:30:00.000Z" showRemaining
        slots={[slot('2026-11-09T03:30:00.000Z', 3)]} />,
    );
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('3 places left');
  });

  it('says when a day has no free times, and hides times before a date is picked', () => {
    expect(render(<SlotPicker {...props} selectedDate="2026-11-09" slots={[]} />)).toContain('No free times on this day.');
    expect(render(<SlotPicker {...props} selectedDate={null} slots={[]} />)).not.toContain('Choose a time');
  });
});
