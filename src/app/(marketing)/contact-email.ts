// The public contact address for privacy, data deletion and support questions
// (SUPPORT_EMAIL, read at request time). Null when unset or not an address.
const EMAIL = /^[^\s@<>"',;]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;

export function supportEmail(env: Record<string, string | undefined> = process.env): string | null {
  const value = env.SUPPORT_EMAIL?.trim() ?? '';
  return EMAIL.test(value) ? value : null;
}
