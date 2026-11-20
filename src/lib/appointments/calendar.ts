/**
 * "Add to calendar" for a booking: an RFC 5545 .ics file and a Google
 * Calendar link. Pure (no server-only imports), so the booking page, the
 * manage page, the .ics route and the WhatsApp messages share one spelling.
 * Times are always written in UTC; calendars show them in the viewer's zone.
 */

export interface CalendarEventInput {
  /** Stable per booking, so re-importing updates the event instead of copying it. */
  uid: string;
  title: string;
  start: Date | string;
  end: Date | string;
  location?: string | null;
  description?: string | null;
  /** http(s) only; anything else is left out. */
  url?: string | null;
  /** DTSTAMP (when the file was made); defaults to now. */
  stamp?: Date;
}

const toDate = (value: Date | string): Date => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError('Invalid calendar date');
  return date;
};

/** 20261203T093000Z */
export function utcStamp(value: Date | string): string {
  return toDate(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** TEXT value escaping (RFC 5545 3.3.11): backslash, semicolon, comma and newlines. */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

const encoder = new TextEncoder();

/**
 * Fold a content line at 75 octets (RFC 5545 3.1): continuation lines start
 * with one space. Never splits a UTF-8 character.
 */
export function foldLine(line: string): string {
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = '';
  let size = 0;
  let limit = 75;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    if (size + bytes > limit) {
      parts.push(current);
      current = '';
      size = 0;
      limit = 74; // the leading space takes one octet
    }
    current += char;
    size += bytes;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

const safeUrl = (value: string | null | undefined): string | null => {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
};

/** A single-event VCALENDAR, CRLF line endings, folded and escaped. */
export function icsForAppointment(input: CalendarEventInput): string {
  const url = safeUrl(input.url);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Bodhinox//Booking//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    // UID is TEXT-like but must stay one token; strip anything a parser could trip on.
    `UID:${input.uid.replace(/[^A-Za-z0-9@._-]/g, '')}`,
    `DTSTAMP:${utcStamp(input.stamp ?? new Date())}`,
    `DTSTART:${utcStamp(input.start)}`,
    `DTEND:${utcStamp(input.end)}`,
    `SUMMARY:${escapeText(input.title)}`,
  ];
  if (input.location) lines.push(`LOCATION:${escapeText(input.location)}`);
  if (input.description) lines.push(`DESCRIPTION:${escapeText(input.description)}`);
  if (url) lines.push(`URL:${url}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

/** Google Calendar's "create event" link, prefilled. */
export function googleCalendarUrl(input: Omit<CalendarEventInput, 'uid' | 'stamp'>): string {
  const url = safeUrl(input.url);
  const details = [input.description, url].filter(Boolean).join('\n\n');
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: input.title,
    dates: `${utcStamp(input.start)}/${utcStamp(input.end)}`,
  });
  if (details) params.set('details', details);
  if (input.location) params.set('location', input.location);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
