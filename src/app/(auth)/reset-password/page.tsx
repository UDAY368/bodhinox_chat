'use client';

// ============================================================
// /reset-password — the form the password-reset email leads to.
//
// The emailed link lands on /auth/callback, which exchanges it for a
// session and 303s here. So on arrival the visitor either has a
// recovery session (show the form) or doesn't (the link was spent,
// expired, or opened in a browser without the PKCE verifier cookie —
// say so, with a way to request a new one). Bouncing to /login with
// no explanation was the locked-out experience issue #592 describes.
//
// Not gated by the middleware on purpose: the "expired" state must be
// reachable signed-out, and a signed-in visitor must not be redirected
// away from the very page they need.
// ============================================================

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { createClient } from '@/lib/data/client';
import { authFetch } from '@/lib/auth/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { PasswordRequirements } from '@/components/auth/password-requirements';
import { MIN_PASSWORD_LENGTH, meetsPasswordRequirements } from '@/lib/auth/password-policy';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { CheckCircle, KeyRound, Loader2, MailX } from 'lucide-react';

type Status = 'checking' | 'ready' | 'expired' | 'done';

export default function ResetPasswordPage() {
  const t = useTranslations('ResetPasswordPage');
  const db = createClient();

  const [status, setStatus] = useState<Status>('checking');
  const [password, setPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // The callback wrote the session cookies server-side; the browser
    // client reads them here. No user → the link didn't yield a session.
    authFetch('/api/auth/recovery')
      .then((response) => response.json())
      .then(({ valid }) => {
        if (!cancelled) setStatus(valid ? 'ready' : 'expired');
      })
      .catch(() => {
        if (!cancelled) setStatus('expired');
      });
    return () => {
      cancelled = true;
    };
  }, [db]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError(t('passwordsMismatch'));
      return;
    }
    // Same floor as /signup.
    if (!meetsPasswordRequirements(password)) {
      setError(t('passwordTooShort'));
      return;
    }

    setSaving(true);
    const { error } = await db.auth.recoverPassword(
      password,
      mfaCode || undefined
    );
    setSaving(false);

    if (error) {
      setError(error.message);
      return;
    }
    setStatus('done');
  };

  if (status === 'checking') {
    return (
      <div className="bg-background flex min-h-screen items-center justify-center px-4">
        <div className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('checking')}
        </div>
      </div>
    );
  }

  if (status === 'expired') {
    return (
      <div className="bg-background flex min-h-screen items-center justify-center px-4">
        <Card className="border-border bg-card w-full max-w-md">
          <CardHeader className="items-center text-center">
            <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-amber-500/10">
              <MailX className="h-6 w-6 text-amber-400" />
            </div>
            <CardTitle className="text-foreground text-xl">
              {t('expiredTitle')}
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('expiredDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Link href="/forgot-password">
              <Button className="bg-primary text-primary-foreground hover:bg-primary/90 h-10 w-full">
                {t('requestNewLink')}
              </Button>
            </Link>
            <Link href="/login">
              <Button
                variant="outline"
                className="border-border text-muted-foreground hover:bg-muted hover:text-foreground w-full"
              >
                {t('backToSignIn')}
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (status === 'done') {
    return (
      <div className="bg-background flex min-h-screen items-center justify-center px-4">
        <Card className="border-border bg-card w-full max-w-md">
          <CardHeader className="items-center text-center">
            <div className="bg-primary/10 mb-2 flex h-12 w-12 items-center justify-center rounded-xl">
              <CheckCircle className="text-primary h-6 w-6" />
            </div>
            <CardTitle className="text-foreground text-xl">
              {t('successTitle')}
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('successDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              className="bg-primary text-primary-foreground hover:bg-primary/90 h-10 w-full"
              onClick={() => {
                // Full-page navigation, like /login: the middleware
                // gating /dashboard must see the session cookies on a
                // fresh top-level request, which a soft router.push
                // can race (issue #365).
                // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- deliberate full reload so the auth cookies reach the middleware
                window.location.href = '/login';
              }}
            >
              Sign in with your new password
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="bg-background flex min-h-screen items-center justify-center px-4">
      <Card className="border-border bg-card w-full max-w-md">
        <CardHeader className="items-center text-center">
          <div className="bg-primary/10 mb-2 flex h-12 w-12 items-center justify-center rounded-xl">
            <KeyRound className="text-primary h-6 w-6" />
          </div>
          <CardTitle className="text-foreground text-xl">
            {t('title')}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t('desc')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            {error && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                {error}
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="password" className="text-muted-foreground">
                {t('passwordLabel')}
              </Label>
              <PasswordInput
                id="password"
                minLength={MIN_PASSWORD_LENGTH}
                aria-describedby="password-requirements"

                autoComplete="new-password"
                placeholder={t('passwordPlaceholder')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label
                htmlFor="confirmPassword"
                className="text-muted-foreground"
              >
                {t('confirmPasswordLabel')}
              </Label>
              <PasswordInput
                id="confirmPassword"

                autoComplete="new-password"
                placeholder={t('confirmPasswordPlaceholder')}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="mfaCode">
                Authenticator or recovery code (if enabled)
              </Label>
              <Input
                id="mfaCode"
                autoComplete="one-time-code"
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value)}
              />
            </div>
            <PasswordRequirements id="password-requirements" />

            <Button
              type="submit"
              disabled={saving}
              className="bg-primary text-primary-foreground hover:bg-primary/90 mt-2 h-10 w-full disabled:opacity-50"
            >
              {saving ? t('saving') : t('submit')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
