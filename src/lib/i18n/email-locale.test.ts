import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLocaleT, staffEmailLocale } from './email-locale';
import { verificationEmail, deliveryTestEmail } from '@/lib/auth/email-content';
import { buildDigestEmails, type DigestEntry } from '@/lib/notifications/digest';
import { billingEmailKey, groupByLocale, noticeText } from '@/lib/billing/billing-notify';

afterEach(() => vi.unstubAllEnvs());

describe('staff email language', () => {
  it('uses the member’s own language first', () => {
    expect(staffEmailLocale('ko', 'pt')).toBe('ko');
  });

  it('falls back to the workspace default', () => {
    expect(staffEmailLocale(null, 'pt')).toBe('pt');
    expect(staffEmailLocale('xx', 'es')).toBe('es');
  });

  it('then to English (the deployment default when unset)', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_LOCALE', '');
    expect(staffEmailLocale(null, null)).toBe('en');
    expect(staffEmailLocale(undefined, 'fr')).toBe('en');
  });

  it('then to the deployment default when one is set', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_LOCALE', 'es');
    expect(staffEmailLocale(null, null)).toBe('es');
  });

  it('translates from every catalogue, whatever the build locale', () => {
    expect(getLocaleT('en', 'AuthEmails')('resetSubject')).toBe('Reset your Bodhinox password');
    expect(getLocaleT('es', 'AuthEmails')('resetSubject')).not.toBe('Reset your Bodhinox password');
    expect(getLocaleT('ko', 'AuthEmails')('verifySubject')).toBe('Bodhinox 이메일 인증');
    expect(getLocaleT('pt', 'AuthEmails')('verifySubject')).toBe('Verifique seu e-mail do Bodhinox');
  });
});

describe('emails to staff', () => {
  it('writes account emails in the given language, and the build language without one', () => {
    expect(verificationEmail('verify', 'https://x.test/l', 'pt').subject).toBe('Verifique seu e-mail do Bodhinox');
    expect(verificationEmail('verify', 'https://x.test/l').subject).toBe('Verify your Bodhinox email');
    expect(deliveryTestEmail('ko').subject).toBe(getLocaleT('ko', 'AuthEmails')('deliveryTestSubject'));
  });

  it('writes each member’s digest in their language, else the workspace’s', () => {
    const now = new Date('2026-11-19T10:00:00Z');
    const entry = (user_id: string, language: string | null, workspace_language: string | null): DigestEntry => ({
      id: `e-${user_id}`, user_id, title: 'Assigned', link: null, created_at: now, address: `${user_id}@x.test`,
      read: false, wants_email: true, language, workspace_language,
    });
    const emails = buildDigestEmails([entry('a', 'es', 'pt'), entry('b', null, 'pt'), entry('c', null, null)],
      { origin: 'https://app.x.test', now });
    const subject = (user: string) => emails.find((e) => e.userId === user)!.subject;
    expect(subject('a')).toBe(getLocaleT('es', 'AuthEmails.digest')('subject', { count: 1 }));
    expect(subject('b')).toBe(getLocaleT('pt', 'AuthEmails.digest')('subject', { count: 1 }));
    expect(subject('c')).toBe('1 new notification in Bodhinox');
  });

  it('writes billing emails in the workspace language', () => {
    expect(noticeText('activated', { plan: 'Pro' }, 'es').title).toBe('Suscripción activa: Pro');
    expect(noticeText('activated', { plan: 'Pro' }).title).toBe(getLocaleT('en', 'Billing.notices')('activated.title', { plan: 'Pro' }));
  });

  it('sends billing emails to admins in each one’s language, workspace language first, one address once', () => {
    const groups = groupByLocale([
      { email: 'ko@x.test', locale: 'ko' },
      { email: 'pt1@x.test', locale: 'pt' },
      { email: 'not an address', locale: 'pt' },
      { email: 'PT1@x.test', locale: 'ko' },
      { email: 'pt2@x.test', locale: 'pt' },
    ], 'pt');
    expect(groups).toEqual([{ locale: 'pt', to: ['pt1@x.test', 'pt2@x.test'] }, { locale: 'ko', to: ['ko@x.test'] }]);
  });

  it('keeps the original outbound key for the workspace language so a queued job is never re-sent', () => {
    expect(billingEmailKey('n1', 'pt', 'pt')).toBe('billing-email:n1');
    expect(billingEmailKey('n1', 'ko', 'pt')).toBe('billing-email:n1:ko');
  });
});
