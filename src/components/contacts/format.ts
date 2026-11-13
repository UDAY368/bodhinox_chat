// Date words for the contacts pages: "Today", "Yesterday", a weekday within
// the week, else a short date (the year only when it is not this year).

type Translate = (key: string, values?: Record<string, string | number>) => string;

const DAY = 86_400_000;

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** When a contact was last active, as the table and the profile show it. */
export function formatLastSeen(iso: string, locale: string, t: Translate, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY);
  if (days <= 0) return t('dates.today');
  if (days === 1) return t('dates.yesterday');
  if (days < 7) return at.toLocaleDateString(locale, { weekday: 'short' });
  return at.toLocaleDateString(locale, { day: 'numeric', month: 'short', ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
}

/** A date and time for the timeline and notes ("Today, 2:45 PM", "12 Oct 2026, 9:10 AM"). */
export function formatWhen(iso: string, locale: string, t: Translate, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const time = at.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  return t('dates.at', { day: formatLastSeen(iso, locale, t, now), time });
}

/** A date for "Added on" ("12 Oct 2026"). */
export function formatDay(iso: string, locale: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
}
