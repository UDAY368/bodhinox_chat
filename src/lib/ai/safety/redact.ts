// High-precision redaction of personal data before text reaches an AI
// provider. Precision over recall: order, booking, invoice and AWB numbers
// must survive (staff and customers talk about them), so phone-shaped digits
// right after those words are kept, and card and Aadhaar numbers are masked
// only when their checksum (Luhn, Verhoeff) passes.

export interface RedactionResult {
  text: string;
  /** True when anything was masked (the caller adds the 'pii_redacted' guard flag). */
  redacted: boolean;
}

const digitsOf = (s: string) => s.replace(/\D/g, '');

/** Luhn checksum (payment cards). */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    double = !double;
  }
  return digits.length > 0 && sum % 10 === 0;
}

const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/** Verhoeff checksum (Aadhaar). */
export function verhoeffValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let c = 0;
  const rev = digits.split('').reverse();
  for (let i = 0; i < rev.length; i++) c = VERHOEFF_D[c][VERHOEFF_P[i % 8][Number(rev[i])]];
  return c === 0;
}

/** IBAN mod-97 check. */
export function ibanValid(raw: string): boolean {
  const s = raw.replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

// Digits right after these words are business references, not phone numbers.
const REFERENCE_BEFORE = /(?:order|#|booking|invoice|awb|ref(?:erence)?|ticket|tracking)\s*(?:no\.?|number|id|code)?\s*[:#-]?\s*$/i;

export function redactForProvider(input: string): RedactionResult {
  let text = input;
  let redacted = false;
  const mark = (replacement: string) => { redacted = true; return replacement; };

  // Query strings can carry tokens and personal data; keep the page, drop the query.
  text = text.replace(/\b(https?:\/\/[^\s?#<>"']+)\?[^\s#<>"']*/gi, (_m, base: string) => mark(base));
  text = text.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}\b/gi, () => mark('[email]'));
  // Cards: 13-19 digits (spaces or dashes allowed) that pass Luhn.
  text = text.replace(/(?<![\d])(?:\d[ -]?){12,18}\d(?![\d])/g, (m) => {
    const d = digitsOf(m);
    return d.length >= 13 && d.length <= 19 && luhnValid(d) ? mark('[card]') : m;
  });
  // Aadhaar: 12 digits (optionally 4-4-4) that pass Verhoeff.
  text = text.replace(/(?<![\d])\d{4}[ -]?\d{4}[ -]?\d{4}(?![\d])/g, (m) => (verhoeffValid(digitsOf(m)) ? mark('[id]') : m));
  text = text.replace(/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g, (m) => (ibanValid(m) ? mark('[id]') : m));
  text = text.replace(/\b[A-Z]{5}\d{4}[A-Z]\b/g, () => mark('[id]'));
  // One-time codes: 4-8 digits within three words of otp / code / pin.
  text = text.replace(/\b(otp|code|pin|passcode)\b((?:[^\w\n]+\w+){0,3}?)([^\w\n]+)(\d{4,8})\b/gi,
    (_m, word: string, between: string, sep: string) => mark(`${word}${between}${sep}[code]`));
  text = text.replace(/\b(\d{4,8})\b((?:[^\w\n]+\w+){0,2}?)[^\w\n]+(is\s+(?:your|the)\s+)?(otp|code|pin|passcode)\b/gi,
    (_m, _d: string, between: string, is: string | undefined, word: string) => mark(`[code]${between} ${is ?? ''}${word}`));
  // Phones: + E.164 (spaces, dashes, dots or parentheses between digits, as
  // in '+1 (415) 555 0134'), or Indian mobiles (6-9 then 9 digits in any
  // grouping, optional +91/0, spaces, dashes or dots).
  const phone = /(?<![\w+])(?:\+\d{1,3}[\s.-]?\(?\d(?:[\s().-]{0,2}\d){6,13}|(?:(?:\+?91|0)[\s-]?)?[6-9](?:[\s.-]?\d){9})(?![\d])/g;
  text = text.replace(phone, (m, offset: number, whole: string) => {
    if (REFERENCE_BEFORE.test(whole.slice(Math.max(0, offset - 24), offset))) return m;
    const n = digitsOf(m).length;
    return n >= 8 && n <= 15 ? mark('[phone]') : m;
  });
  // UPI VPA: name@handle with no dot in the handle (emails were masked above).
  text = text.replace(/\b[A-Z0-9._-]{1,64}@[A-Z][A-Z0-9]{1,30}\b(?![.@\w-])/gi, () => mark('[upi]'));
  return { text, redacted };
}
