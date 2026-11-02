import type { AccountRole } from '@/lib/auth/roles';

/**
 * Per-member phone masking (account_memberships.mask_phone_numbers). An admin
 * can hide customers' numbers from an agent or viewer; owners and admins always
 * see full numbers, even if a stale flag survives a promotion.
 *
 * Masking is a display rule applied on the server before a number reaches a
 * masked member's browser. It is not a substitute for authorization: sends and
 * exports must still resolve the number server-side.
 */

export const MASK_CHAR = '•';

// ITU calling codes that are 1 or 2 digits long; every other code is 3 digits.
const ONE_DIGIT = new Set(['1', '7']);
const TWO_DIGIT = new Set([
  '20', '27', '30', '31', '32', '33', '34', '36', '39', '40', '41', '43', '44', '45', '46', '47', '48', '49',
  '51', '52', '53', '54', '55', '56', '57', '58', '60', '61', '62', '63', '64', '65', '66',
  '81', '82', '84', '86', '90', '91', '92', '93', '94', '95', '98',
]);

function callingCodeLength(digits: string): number {
  if (ONE_DIGIT.has(digits[0])) return 1;
  if (TWO_DIGIT.has(digits.slice(0, 2))) return 2;
  return 3;
}

/**
 * Mask a phone number for display, keeping the calling code, the first two
 * and the last three national digits: '+919876543210' -> '+91 98•••••210'.
 * Numbers stored without '+' are treated as international when they have more
 * than 10 digits ('919876543210' -> '+91 98•••••210'); shorter ones mask the
 * middle without a calling code. Very short values keep only the last two
 * digits. Empty input returns ''.
 */
export function maskPhone(phone: string | null | undefined): string {
  const raw = (phone ?? '').trim();
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length < 7) return MASK_CHAR.repeat(Math.max(digits.length - 2, 1)) + digits.slice(-2);
  const international = raw.startsWith('+') || digits.length > 10;
  const ccLength = international ? callingCodeLength(digits) : 0;
  const cc = digits.slice(0, ccLength);
  const national = digits.slice(ccLength);
  if (national.length < 6) {
    return `${cc ? `+${cc} ` : ''}${MASK_CHAR.repeat(Math.max(national.length - 2, 1))}${national.slice(-2)}`;
  }
  const masked = national.slice(0, 2) + MASK_CHAR.repeat(national.length - 5) + national.slice(-3);
  return cc ? `+${cc} ${masked}` : masked;
}

/** Whether numbers must be masked for this member. Owners/admins never are. */
export function shouldMask(
  role: AccountRole | null | undefined,
  membership: { mask_phone_numbers?: boolean | null } | null | undefined,
): boolean {
  if (role === 'owner' || role === 'admin') return false;
  return membership?.mask_phone_numbers === true;
}

/** Convenience for projections: the number as this member may see it. */
export function displayPhone(phone: string | null | undefined, mask: boolean): string | null {
  if (phone == null) return null;
  return mask ? maskPhone(phone) : phone;
}

// A run of 8–15 digits with at most two spacing/punctuation characters
// between digits, optionally led by '+': what a phone number looks like in
// free text. Runs inside longer words or numbers are left alone.
const PHONE_IN_TEXT = /(?<![\w+])\+?\d(?:[\s().-]{0,2}\d){7,14}(?![\w])/g;
const ISO_DATE = /^\d{4}-\d{1,2}-\d{1,2}$/;

/**
 * Mask every phone-number-looking run in free text (notification titles and
 * bodies, digest lines) with maskPhone. Over-masking a long number that is
 * not a phone is the safe direction; ISO dates are kept.
 */
export function maskPhonesInText(text: string): string;
export function maskPhonesInText(text: string | null | undefined): string | null | undefined;
export function maskPhonesInText(text: string | null | undefined): string | null | undefined {
  if (typeof text !== 'string' || !/\d/.test(text)) return text;
  return text.replace(PHONE_IN_TEXT, (match) => (ISO_DATE.test(match) ? match : maskPhone(match)));
}
