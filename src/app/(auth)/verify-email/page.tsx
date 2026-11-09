'use client';

// /verify-email — the emailed verify link lands on /auth/callback, which keeps the token in an
// HttpOnly cookie and 303s here. Verification also needs the password chosen at signup, so a
// stranger who signed up first with someone else's address never keeps the account
// (account pre-hijack). Not gated by the proxy: visitors here are signed out.

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { createAuthClient } from '@/lib/auth/client';
import { safeNextPath } from '@/lib/auth/callback';
import { Button } from '@/components/ui/button';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Loader2, MailCheck, MailX } from 'lucide-react';

type Status = 'checking' | 'ready' | 'expired';

function VerifyEmailForm() {
  const t = useTranslations('VerifyEmailPage');
  const next = safeNextPath(useSearchParams().get('next'));
  const [status, setStatus] = useState<Status>('checking');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    createAuthClient()
      .verifyLinkValid()
      .then((valid) => {
        if (!cancelled) setStatus(valid ? 'ready' : 'expired');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    const { error } = await createAuthClient().confirmEmail(password);
    setSaving(false);
    if (!error) {
      // Full-page navigation to the sign-in page, as after a password reset.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- deliberate full reload so the proxy sees fresh cookies
      window.location.href = `/login?verified=1&next=${encodeURIComponent(next)}`;
      return;
    }
    if (error.code === 'password_mismatch') setError(t('mismatch'));
    else if (error.code === 'link_invalid') setStatus('expired');
    else if (error.code === 'rate_limited') setError(t('rateLimited'));
    else setError(t('failed'));
  };

  if (status === 'checking')
    return (
      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('checking')}
      </div>
    );

  if (status === 'expired')
    return (
      <Card className="border-border bg-card w-full max-w-md">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-amber-500/10">
            <MailX className="h-6 w-6 text-amber-400" />
          </div>
          <CardTitle className="text-foreground text-xl">{t('expiredTitle')}</CardTitle>
          <CardDescription className="text-muted-foreground">{t('expiredDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/login">
            <Button variant="outline" className="w-full">
              {t('backToSignIn')}
            </Button>
          </Link>
        </CardContent>
      </Card>
    );

  return (
    <Card className="border-border bg-card w-full max-w-md">
      <CardHeader className="items-center text-center">
        <div className="bg-primary/10 mb-2 flex h-12 w-12 items-center justify-center rounded-xl">
          <MailCheck className="text-primary h-6 w-6" />
        </div>
        <CardTitle className="text-foreground text-xl">{t('title')}</CardTitle>
        <CardDescription className="text-muted-foreground">{t('desc')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {error && (
            <div role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
              {error}
            </div>
          )}
          <div className="flex flex-col gap-2">
            <Label htmlFor="password" className="text-muted-foreground">
              {t('passwordLabel')}
            </Label>
            <PasswordInput
              id="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <Button type="submit" disabled={saving || !password} className="mt-2 h-10 w-full">
            {saving ? t('saving') : t('submit')}
          </Button>
          <p className="text-muted-foreground text-center text-xs">
            {t('forgotHint')}
          </p>
        </form>
      </CardContent>
    </Card>
  );
}

export default function VerifyEmailPage() {
  return (
    <div className="bg-background flex min-h-screen items-center justify-center px-4">
      <Suspense>
        <VerifyEmailForm />
      </Suspense>
    </div>
  );
}
