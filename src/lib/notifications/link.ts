/**
 * Where clicking an in-app notification may go. Only a same-origin relative
 * path is followed: it must start with exactly one "/" (not "//", which a
 * browser reads as another host), and may not contain a backslash (browsers
 * treat "/\" like "//") or control characters. Anything else returns null and
 * the caller falls back to the notification's conversation or type.
 */
export function safeNotificationLink(link: unknown): string | null {
  if (typeof link !== 'string' || link.length > 2048) return null;
  if (!link.startsWith('/') || link.startsWith('//')) return null;
  if (/[\\\u0000-\u001f\u007f]/.test(link)) return null;
  return link;
}
