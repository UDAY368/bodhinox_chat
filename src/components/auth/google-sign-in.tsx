'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { authFetch } from '@/lib/auth/client';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const ERRORS = [
  'google_unavailable',
  'google_cancelled',
  'google_failed',
  'google_link_required',
  'google_no_workspace',
  'google_invite_unavailable',
  'google_rate_limited',
  'google_terms_required',
] as const;

/**
 * "Continue with Google" for the login page, plus the second step for accounts with two-step
 * verification (the callback sends them back here with ?google=mfa). Hidden when the server has
 * no Google client configured.
 */
export function GoogleSignIn({ terms }: {
  /** The sign-up page while TERMS_VERSION is set: Google stays disabled until the terms are accepted. */
  terms?: { version: string; accepted: boolean };
} = {}) {
  const t = useTranslations('LoginPage.google');
  const searchParams = useSearchParams();
  const pendingMfa = searchParams.get('google') === 'mfa';
  const errorCode = searchParams.get('error');
  const [configured, setConfigured] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch('/api/auth/google', { credentials: 'same-origin', cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((result) => active && setConfigured(result?.configured === true))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const knownError = ERRORS.find((value) => value === errorCode);

  if (pendingMfa)
    return (
      <form
        className="mb-4 flex flex-col gap-3 rounded-lg border p-4"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setMessage(null);
          try {
            const response = await authFetch('/api/auth/google/callback', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ mfaCode: code }),
            });
            const result = await response.json();
            if (!response.ok) {
              setMessage(
                result.error?.code === 'google_expired' ? t('mfaExpired') : (result.error?.message ?? t('failed'))
              );
              return;
            }
            window.location.href = typeof result.redirect === 'string' && result.redirect.startsWith('/') ? result.redirect : '/dashboard';
          } catch {
            setMessage(t('failed'));
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="text-sm">{t('mfaPrompt')}</p>
        <Label htmlFor="google-mfa-code">{t('mfaLabel')}</Label>
        <Input
          id="google-mfa-code"
          autoComplete="one-time-code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          required
        />
        {message && (
          <p role="alert" className="text-sm text-red-400">
            {message}
          </p>
        )}
        <Button type="submit" disabled={busy || !code}>
          {busy ? t('verifying') : t('mfaSubmit')}
        </Button>
      </form>
    );

  if (!configured) return null;
  const start = new URLSearchParams();
  const next = searchParams.get('next');
  const invite = searchParams.get('invite');
  if (next) start.set('next', next);
  if (invite) start.set('invite', invite);
  if (terms) start.set('terms', terms.version);
  const query = start.toString();
  return (
    <div className="mb-4 flex flex-col gap-3">
      {knownError && (
        <div role="alert" className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
          {t(`errors.${knownError}`)}
        </div>
      )}
      {terms && !terms.accepted ? (
        <Button type="button" variant="outline" className="h-10 w-full" disabled>
          {t('continue')}
        </Button>
      ) : (
        /* A full navigation, not a fetch: the start route redirects to Google. */
        <a
          href={`/api/auth/google/start${query ? `?${query}` : ''}`}
          className={cn(buttonVariants({ variant: 'outline' }), 'h-10 w-full')}
        >
          {t('continue')}
        </a>
      )}
      <div className="text-muted-foreground flex items-center gap-3 text-xs">
        <span className="bg-border h-px flex-1" />
        {t('or')}
        <span className="bg-border h-px flex-1" />
      </div>
    </div>
  );
}
