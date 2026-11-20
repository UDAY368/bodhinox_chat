import { describe, expect, it } from 'vitest';
import { escapeText, foldLine, googleCalendarUrl, icsForAppointment, utcStamp } from './calendar';

const base = {
  uid: 'appt-1@bodhinox',
  title: 'Haircut',
  start: '2026-12-03T04:00:00.000Z',
  end: new Date('2026-12-03T04:45:00.000Z'),
  stamp: new Date('2026-11-19T10:11:12.345Z'),
};

describe('utcStamp', () => {
  it('writes UTC basic format without milliseconds', () => {
    expect(utcStamp('2026-12-03T09:30:00+05:30')).toBe('20261203T040000Z');
    expect(utcStamp(new Date('2026-11-19T10:11:12.345Z'))).toBe('20261119T101112Z');
  });
  it('refuses an invalid date', () => {
    expect(() => utcStamp('not a date')).toThrow(RangeError);
  });
});

describe('escapeText', () => {
  it('escapes backslash, semicolon, comma and every newline form', () => {
    expect(escapeText('a\\b;c,d\ne\r\nf\rg')).toBe('a\\\\b\\;c\\,d\\ne\\nf\\ng');
  });
});

describe('foldLine', () => {
  it('leaves short lines alone', () => {
    expect(foldLine('SUMMARY:short')).toBe('SUMMARY:short');
  });
  it('folds at 75 octets with a leading space on each continuation', () => {
    const folded = foldLine(`DESCRIPTION:${'x'.repeat(200)}`);
    const parts = folded.split('\r\n');
    expect(parts.length).toBeGreaterThan(1);
    expect(new TextEncoder().encode(parts[0]).length).toBe(75);
    for (const part of parts.slice(1)) {
      expect(part.startsWith(' ')).toBe(true);
      expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75);
    }
    expect(parts.map((p, i) => (i ? p.slice(1) : p)).join('')).toBe(`DESCRIPTION:${'x'.repeat(200)}`);
  });
  it('never splits a multi-byte character', () => {
    const line = `SUMMARY:${'é'.repeat(60)}${'🙂'.repeat(10)}`;
    const parts = foldLine(line).split('\r\n');
    for (const part of parts) expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75);
    expect(parts.map((p, i) => (i ? p.slice(1) : p)).join('')).toBe(line);
  });
});

describe('icsForAppointment', () => {
  it('is a CRLF VCALENDAR with one VEVENT in UTC', () => {
    const ics = icsForAppointment({ ...base, location: 'Shop 4, MG Road; Pune', description: 'Bring ID\nArrive early', url: 'https://app.example.com/my-booking/abc' });
    expect(ics.endsWith('\r\n')).toBe(true);
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    const lines = ics.split('\r\n');
    expect(lines[0]).toBe('BEGIN:VCALENDAR');
    expect(lines).toContain('VERSION:2.0');
    expect(lines).toContain('BEGIN:VEVENT');
    expect(lines).toContain('UID:appt-1@bodhinox');
    expect(lines).toContain('DTSTAMP:20261119T101112Z');
    expect(lines).toContain('DTSTART:20261203T040000Z');
    expect(lines).toContain('DTEND:20261203T044500Z');
    expect(lines).toContain('SUMMARY:Haircut');
    expect(lines).toContain('LOCATION:Shop 4\\, MG Road\\; Pune');
    expect(lines).toContain('DESCRIPTION:Bring ID\\nArrive early');
    expect(lines).toContain('URL:https://app.example.com/my-booking/abc');
    expect(lines.at(-2)).toBe('END:VCALENDAR');
  });

  it('cannot be broken by injected lines in any text field', () => {
    const ics = icsForAppointment({ ...base, title: 'X\r\nEND:VEVENT\r\nBEGIN:VEVENT', uid: 'a\r\nb c@d' });
    expect(ics.split('\r\n').filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(1);
    expect(ics).toContain('UID:abc@d');
  });

  it('leaves out empty optional fields and non-http urls', () => {
    const ics = icsForAppointment({ ...base, url: 'javascript:alert(1)', location: null, description: '' });
    expect(ics).not.toMatch(/^(URL|LOCATION|DESCRIPTION):/m);
  });
});

describe('googleCalendarUrl', () => {
  it('prefills title, UTC dates, place and details with the link', () => {
    const url = new URL(googleCalendarUrl({ ...base, location: 'MG Road', description: 'See you', url: 'https://app.example.com/my-booking/abc' }));
    expect(url.origin + url.pathname).toBe('https://calendar.google.com/calendar/render');
    expect(url.searchParams.get('action')).toBe('TEMPLATE');
    expect(url.searchParams.get('text')).toBe('Haircut');
    expect(url.searchParams.get('dates')).toBe('20261203T040000Z/20261203T044500Z');
    expect(url.searchParams.get('location')).toBe('MG Road');
    expect(url.searchParams.get('details')).toBe('See you\n\nhttps://app.example.com/my-booking/abc');
  });
  it('omits details and location when there are none', () => {
    const url = new URL(googleCalendarUrl(base));
    expect(url.searchParams.has('details')).toBe(false);
    expect(url.searchParams.has('location')).toBe(false);
  });
});
