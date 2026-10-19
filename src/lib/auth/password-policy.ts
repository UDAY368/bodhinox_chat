/** Shared by browser forms and password hashing; never apply new rules to login. */
export const MIN_PASSWORD_LENGTH = 8;
export const PASSWORD_REQUIREMENTS = 'Use at least 8 characters, including one uppercase letter, one number, and one special character.';

export function meetsPasswordRequirements(password: string): boolean {
  return typeof password === 'string' &&
    password.length >= MIN_PASSWORD_LENGTH &&
    new TextEncoder().encode(password).byteLength <= 1024 &&
    /[A-Z]/.test(password) && /[0-9]/.test(password) &&
    /[^\p{L}\p{N}\s]/u.test(password);
}
