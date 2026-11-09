import { afterAll, describe, expect, it, vi } from 'vitest';
import en from '../../../messages/en.json';
import es from '../../../messages/es.json';
import ko from '../../../messages/ko.json';
import pt from '../../../messages/pt.json';

const ORIGINAL_LOCALE = process.env.NEXT_PUBLIC_APP_LOCALE;
const LINK = 'https://app.example.test/auth/callback?token=abc&purpose=verify';

/** Loads the email content against one build locale's catalogue, as next.config's @app-messages alias does. */
async function loadFor(locale: string, messages: unknown) {
  vi.resetModules();
  process.env.NEXT_PUBLIC_APP_LOCALE = locale;
  vi.doMock('@app-messages', () => ({ default: messages }));
  return import('./email-content');
}

afterAll(() => {
  vi.doUnmock('@app-messages');
  vi.resetModules();
  if (ORIGINAL_LOCALE === undefined) delete process.env.NEXT_PUBLIC_APP_LOCALE;
  else process.env.NEXT_PUBLIC_APP_LOCALE = ORIGINAL_LOCALE;
});

describe('account emails', () => {
  it('keep the English wording by default', async () => {
    const mail = await loadFor('en', en);
    expect(mail.verificationEmail('verify', LINK)).toEqual({
      subject: 'Verify your Bodhinox email',
      text: `Verify your email: ${LINK}\nThis link expires in 24 hours. If you did not request it, ignore this message.`,
    });
    expect(mail.verificationEmail('reset', LINK).subject).toBe('Reset your Bodhinox password');
    expect(mail.existingAccountEmail('https://app.example.test/login').text).toBe(
      'Someone tried to create a Bodhinox account with this email, but one already exists.\n' +
        'Sign in: https://app.example.test/login\n' +
        'Forgot your password? Use "Forgot password" on the sign-in page. If this was not you, ignore this message.'
    );
  });

  it('fall back to English for an unknown locale', async () => {
    const mail = await loadFor('xx', en);
    expect(mail.emailChangeConfirmEmail(LINK).subject).toBe('Confirm your new Bodhinox email');
  });

  it.each([
    ['es', es, 'Verifica tu correo de Bodhinox', 'Restablece tu contraseña de Bodhinox'],
    ['pt', pt, 'Verifique seu e-mail do Bodhinox', 'Redefina sua senha do Bodhinox'],
    ['ko', ko, 'Bodhinox 이메일 인증', 'Bodhinox 비밀번호 재설정'],
  ] as const)('use the %s catalogue on a %s build', async (locale, messages, verify, reset) => {
    const mail = await loadFor(locale, messages);
    const verification = mail.verificationEmail('verify', LINK);
    expect(verification.subject).toBe(verify);
    expect(verification.text).toContain(LINK);
    expect(mail.verificationEmail('reset', LINK).subject).toBe(reset);
    const join = 'https://app.example.test/join/tok';
    const existing = mail.existingAccountEmail('https://app.example.test/login', join);
    expect(existing.subject).not.toBe('You already have a Bodhinox account');
    expect(existing.text).toContain('https://app.example.test/login');
    expect(existing.text).toContain(join);
    const notice = mail.emailChangeNoticeEmail('new@example.test');
    expect(notice.text).toContain('new@example.test');
    expect(notice.subject).not.toBe('Bodhinox email change requested');
    expect(mail.deliveryTestEmail().subject).not.toBe('Bodhinox Chat email verification delivery test');
  });
});
