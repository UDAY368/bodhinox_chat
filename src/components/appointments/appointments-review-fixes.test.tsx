import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/client', () => ({ authFetch: vi.fn(async () => new Response('{}', { status: 200 })) }));
vi.mock('@/lib/data/client', () => ({ createClient: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

import en from '../../../messages/en.json';
import { DEFAULT_APPOINTMENT_SETTINGS } from '@/lib/appointments/types';
import { messageReasonKey } from './appointment-sheet';
import { settingsPatch } from './settings-panel';
import { SlotPicker } from './slot-picker';
import { dueAtFromDay, formatDueDate } from './shared';

const render = (node: React.ReactNode) =>
  renderToStaticMarkup(<NextIntlClientProvider locale="en" messages={en} timeZone="UTC">{node}</NextIntlClientProvider>);

describe('settingsPatch (a stale or partly edited form never overwrites untouched settings)', () => {
  const stored = {
    ...DEFAULT_APPOINTMENT_SETTINGS, hold_minutes: 30, horizon_days: 90,
    confirm_template_name: 'appt_confirm', confirm_template_language: 'en',
    reminder_template_name: 'appt_remind', reminder_template_language: 'en',
  };

  it('sends only the toggled field', () => {
    expect(settingsPatch(stored, { ...stored, reminder_2h: !stored.reminder_2h })).toEqual({ reminder_2h: !stored.reminder_2h });
  });

  it('sends nothing when nothing changed', () => {
    expect(settingsPatch(stored, { ...stored })).toEqual({});
  });

  it('keeps a template slot name and language together and leaves other slots out', () => {
    expect(settingsPatch(stored, { ...stored, confirm_template_language: 'hi' }))
      .toEqual({ confirm_template_name: 'appt_confirm', confirm_template_language: 'hi' });
    expect(settingsPatch(stored, { ...stored, reminder_template_name: null, reminder_template_language: null }))
      .toEqual({ reminder_template_name: null, reminder_template_language: null });
  });
});

describe('messageReasonKey covers every reason code the server stores', () => {
  // Read the literal codes from the code that writes appointment_messages.reason, so a new code
  // without a translation fails here instead of showing "Not sent." to staff.
  const lib = join(process.cwd(), 'src/lib/appointments');
  const source = ['customer-send.ts', 'followup.ts', 'reminders.ts'].map((f) => readFileSync(join(lib, f), 'utf8')).join('\n');
  const codes = new Set([
    ...[...source.matchAll(/reason: '([a-z_]+)'/g)].map((m) => m[1]),
    ...[...source.matchAll(/\b(?:skip|block|fail)\('([a-z_]+)'\)/g)].map((m) => m[1]),
    ...[...source.matchAll(/return '([a-z_]+)';/g)].map((m) => m[1]),
  ]);

  it('finds the codes', () => {
    for (const code of ['template_not_found', 'template_not_approved', 'template_wrong_number', 'feedback_recorded', 'no_template'])
      expect(codes).toContain(code);
  });

  it('maps each code to its own translated reason', () => {
    const reasons = en.Appointments.messageReasons as Record<string, string>;
    for (const code of codes) {
      expect(messageReasonKey(code), code).toBe(code);
      expect(reasons[code], code).toBeTypeOf('string');
    }
  });
});

describe('task due dates are calendar days', () => {
  it('stores a picked day as UTC midnight and shows that same day', () => {
    expect(dueAtFromDay('2026-11-10')).toBe('2026-11-10T00:00:00.000Z');
    expect(dueAtFromDay('')).toBeNull();
    expect(dueAtFromDay('10/11/2026')).toBeNull();
    // A viewer's zone does not matter: the day is read in UTC (New York would otherwise show Nov 9).
    expect(formatDueDate('2026-11-10T00:00:00.000Z', 'en-US')).toBe('Nov 10, 2026');
  });
});

describe('SlotPicker with no day to show', () => {
  const props = { dates: [] as string[], selectedDate: null, onDateChange: () => {}, onSelect: () => {}, slots: [], timeZone: 'Asia/Kolkata' };

  it('shows a spinner while the first load runs', () => {
    const html = render(<SlotPicker {...props} loading />);
    expect(html).toContain('Loading times');
    expect(html).not.toContain('No free dates');
  });

  it('says there are no free dates once loaded, keeping the paging arrows', () => {
    const html = render(<SlotPicker {...props} onNextDates={() => {}} />);
    expect(html).toContain('No free dates in the coming days.');
    expect(html).toContain('aria-label="Later dates"');
  });

  it('shows why the slots could not be loaded instead', () => {
    const html = render(<SlotPicker {...props} errorText="Appointments are not included in your plan." />);
    expect(html).toContain('Appointments are not included in your plan.');
    expect(html).not.toContain('No free dates');
  });
});
