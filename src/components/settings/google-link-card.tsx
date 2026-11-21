'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { authFetch, createAuthClient } from '@/lib/auth/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { PasswordInput } from '@/components/ui/password-input';
import { GroupedListRow } from '@/components/ui/grouped-list';
import { SettingsBlock, SettingsGroup, SettingsRow } from './settings-row';

type Status = {
  configured: boolean;
  linked: { email: string; linkedAt: string } | null;
  /** False for an account created through Google: it has no password to confirm with yet. */
  passwordSet: boolean;
};
const OUTCOMES = [
  'linked',
  'google_in_use',
  'google_already_linked',
  'google_failed',
  'google_cancelled',
  'google_unavailable',
] as const;

/** The link status plus whether the user has a password (read from the MFA status, which already reports it). */
export async function loadGoogleStatus(): Promise<Status | null> {
  const [google, mfa] = await Promise.all([authFetch('/api/auth/google'), authFetch('/api/auth/mfa')]);
  if (!google.ok) return null;
  const body = (await google.json()) as Omit<Status, 'passwordSet'>;
  // Unknown (request failed) counts as set: the server still demands the password either way.
  const passwordSet = mfa.ok ? ((await mfa.json().catch(() => ({}))) as { passwordSet?: unknown }).passwordSet !== false : true;
  return { ...body, passwordSet };
}

/**
 * Link or unlink a Google account for sign-in. Both need the current password,
 * so an account created through Google is offered an email link to set one
 * first (the forgot-password page is for signed-out visitors only).
 */
export function GoogleLinkCard() {
  const t = useTranslations('Settings.security.google');
  const searchParams = useSearchParams();
  const outcome = OUTCOMES.find((value) => value === searchParams.get('google'));
  const [status, setStatus] = useState<Status | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(outcome ? t(`outcomes.${outcome}`) : null);
  const { user } = useAuth();

  const load = useCallback(async () => {
    const status = await loadGoogleStatus();
    if (status) setStatus(status);
  }, []);
  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  if (!status || (!status.configured && !status.linked)) return null;

  async function sendSetPasswordLink() {
    if (!user?.email) return;
    setBusy(true);
    setMessage(null);
    try {
      const { error } = await createAuthClient().resetPasswordForEmail(user.email);
      setMessage(error ? t('failed') : t('setPasswordSent'));
    } finally {
      setBusy(false);
    }
  }

  async function submit(method: 'POST' | 'DELETE') {
    setBusy(true);
    setMessage(null);
    try {
      const response = await authFetch(method === 'POST' ? '/api/auth/google/start' : '/api/auth/google', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: password }),
      });
      const result = await response.json();
      if (!response.ok) {
        setMessage(result.error?.message ?? t('failed'));
        return;
      }
      setPassword('');
      if (method === 'POST' && typeof result.url === 'string') {
        window.location.href = result.url;
        return;
      }
      setMessage(t('unlinked'));
      await load();
    } catch {
      setMessage(t('failed'));
    } finally {
      setBusy(false);
    }
  }

  const footer = status.linked ? t('linkedAs', { email: status.linked.email }) : t('description');
  const messageRow = message ? (
    <SettingsBlock className="py-3">
      <p role="status" className="text-sm">
        {message}
      </p>
    </SettingsBlock>
  ) : null;

  if (!status.passwordSet) {
    return (
      <SettingsGroup title={t('title')} footer={footer} testId="google-link-no-password">
        <SettingsBlock className="py-3">
          <p className="text-muted-foreground text-sm">{t('noPassword')}</p>
        </SettingsBlock>
        {messageRow}
        <GroupedListRow
          title={<span className={busy || !user?.email ? 'text-muted-foreground' : 'text-primary'}>{t('setPassword')}</span>}
          onClick={busy || !user?.email ? undefined : () => void sendSetPasswordLink()}
        />
      </SettingsGroup>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit(status.linked ? 'DELETE' : 'POST');
      }}
    >
      <SettingsGroup
        title={t('title')}
        footer={footer}
        action={
          <Button type="submit" size="sm" variant={status.linked ? 'outline' : 'default'} disabled={busy || !password} className="min-h-11 sm:min-h-8">
            {status.linked ? t('unlink') : t('link')}
          </Button>
        }
      >
        <SettingsRow label={t('passwordLabel')} htmlFor="google-link-password" hint={status.linked ? t('unlinkHint') : undefined}>
          <PasswordInput
            id="google-link-password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </SettingsRow>
        {messageRow}
      </SettingsGroup>
    </form>
  );
}
