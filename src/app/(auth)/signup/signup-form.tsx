'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { createClient } from '@/lib/data/client';
import { authFetch } from '@/lib/auth/client';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { PasswordRequirements } from '@/components/auth/password-requirements';
import { GoogleSignIn } from '@/components/auth/google-sign-in';
import { MIN_PASSWORD_LENGTH, meetsPasswordRequirements } from '@/lib/auth/password-policy';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { MessageSquare, CheckCircle, UsersRound } from 'lucide-react';

// `useSearchParams` opts the component out of static prerendering
// unless wrapped in Suspense — same pattern as /login.
// `termsVersion` is TERMS_VERSION from the server page: while it is set the
// form asks for acceptance of the terms and privacy policy and sends the
// accepted version with the signup; unset = the form is unchanged.
export function SignupPageClient({ termsVersion }: { termsVersion: string | null }) {
  return (
    <Suspense fallback={null}>
      <SignupPageInner termsVersion={termsVersion} />
    </Suspense>
  );
}

function SignupPageInner({ termsVersion }: { termsVersion: string | null }) {
  // When the user lands here from `/join/<token>` the invite token
  // rides along in the query. Signup sends it to the server, which
  // joins the new identity to the inviting workspace with the
  // invited role (no personal workspace is created). Keyed so
  // "sign up without the invitation" starts from a clean form.
  const inviteToken = useSearchParams().get('invite');
  return <SignupForm key={inviteToken ?? ''} inviteToken={inviteToken} termsVersion={termsVersion} />;
}

/** The signup call with the accepted terms version (the auth client has no option for it). */
async function signUpWithTerms(body: Record<string, unknown>): Promise<{ error: { message: string; code?: string } | null }> {
  try {
    const response = await authFetch('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (response.ok) return { error: null };
    const data = (await response.json().catch(() => null)) as { error?: { message?: string; code?: string } } | null;
    return { error: { message: data?.error?.message ?? 'Authentication failed', code: data?.error?.code } };
  } catch {
    return { error: { message: 'Unable to reach authentication service' } };
  }
}

function SignupForm({ inviteToken, termsVersion }: { inviteToken: string | null; termsVersion: string | null }) {
  const t = useTranslations('SignupPage');
  const tRoles = useTranslations('Settings.roles');
  const [invite, setInvite] = useState<{
    account_name: string;
    role: 'admin' | 'agent' | 'viewer';
  } | null>(null);
  const [inviteUnavailable, setInviteUnavailable] = useState(false);

  // Show which workspace and role the invitation is for.
  useEffect(() => {
    if (!inviteToken) return;
    let cancelled = false;
    fetch(`/api/invitations/${encodeURIComponent(inviteToken)}/peek`, {
      cache: 'no-store',
      credentials: 'same-origin',
    })
      .then((response) => response.json())
      .then((result) => {
        if (cancelled) return;
        if (result?.ok === true) setInvite(result);
        else if (result?.reason && result.reason !== 'server_error')
          setInviteUnavailable(true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [inviteToken]);

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const tTerms = useTranslations('SignupPage.terms');
  const db = createClient();

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError(t('passwordsMismatch'));
      return;
    }

    if (!meetsPasswordRequirements(password)) {
      setError(t('passwordTooShort'));
      return;
    }

    setLoading(true);
    setInviteUnavailable(false);

    // Always name our own origin as the place the confirmation link
    // returns to. Previously this was left unset unless an invite was
    // involved, so db fell back to its Site URL — which on a
    // freshly-created or self-hosted project is `http://localhost:3000`
    // (issue #595) — and even when the Site URL was right the link
    // landed on `/` with an unexchanged `?code=`, so the user had to
    // sign in again after verifying. /auth/callback exchanges the link
    // for a session and forwards to `next` (issue #592). db still
    // has to allow this origin under Authentication → URL Configuration
    // → Redirect URLs; see docs/auth-emails.md.
    // An invited signup is already a member once verified, so it lands on the dashboard.
    const next = '/dashboard';
    const emailRedirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;

    if (termsVersion && !termsAccepted) {
      setError(tTerms('required'));
      setLoading(false);
      return;
    }

    // Same body as db.auth.signUp, plus the accepted terms version while terms are configured.
    const { error } = termsVersion
      ? await signUpWithTerms({
          email,
          password,
          fullName,
          next: new URL(emailRedirectTo).searchParams.get('next') ?? '/dashboard',
          ...(inviteToken ? { invite: inviteToken } : {}),
          termsVersion,
        })
      : await db.auth.signUp({
          email,
          password,
          options: {
            data: {
              full_name: fullName,
            },
            emailRedirectTo,
            ...(inviteToken ? { invite: inviteToken } : {}),
          },
        });

    if (error) {
      // Used, expired or malformed link (the server answers all three with invite_unavailable):
      // never fall back to creating a workspace silently. Other errors show as they are.
      if (inviteToken && error.code === 'invite_unavailable')
        setInviteUnavailable(true);
      else setError(error.message);
      setLoading(false);
      return;
    }

    setSuccess(true);
    setLoading(false);
  };

  if (success) {
    return (
      <div className="bg-background flex min-h-screen items-center justify-center px-4">
        <Card className="border-border bg-card w-full max-w-md">
          <CardHeader className="items-center text-center">
            <div className="bg-primary/10 mb-2 flex h-12 w-12 items-center justify-center rounded-xl">
              <CheckCircle className="text-primary h-6 w-6" />
            </div>
            <CardTitle className="text-foreground text-xl">
              {t('checkEmailTitle')}
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              {t.rich('checkEmailDesc', {
                email,
                strong: (chunks) => (
                  <span className="text-foreground">{chunks}</span>
                ),
              })}
            </CardDescription>
          </CardHeader>
          <CardContent>
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

  return (
    <div className="bg-background flex min-h-screen items-center justify-center px-4">
      <Card className="border-border bg-card w-full max-w-md">
        <CardHeader className="items-center text-center">
          <div className="bg-primary/10 mb-2 flex h-12 w-12 items-center justify-center rounded-xl">
            {inviteToken ? (
              <UsersRound className="text-primary h-6 w-6" />
            ) : (
              <MessageSquare className="text-primary h-6 w-6" />
            )}
          </div>
          <CardTitle className="text-foreground text-xl">
            {inviteToken ? t('titleJoin') : t('title')}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {invite
              ? t.rich('descJoinWorkspace', {
                  workspace: invite.account_name,
                  role: tRoles(invite.role),
                  strong: (chunks) => (
                    <span className="text-foreground">{chunks}</span>
                  ),
                })
              : inviteToken
                ? t('descJoin')
                : t('desc')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* Hidden without a Google client. While terms apply it stays disabled until the box below is ticked. */}
          <GoogleSignIn terms={termsVersion ? { version: termsVersion, accepted: termsAccepted } : undefined} />
          <form onSubmit={handleSignup} className="flex flex-col gap-4">
            {inviteUnavailable && (
              <div
                role="alert"
                className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400"
              >
                {t('inviteUnavailable')}{' '}
                <Link href="/signup" className="text-primary underline">
                  {t('signupWithoutInvite')}
                </Link>
              </div>
            )}
            {error && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                {error}
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="fullName" className="text-muted-foreground">
                {t('fullNameLabel')}
              </Label>
              <Input
                id="fullName"
                type="text"
                placeholder={t('fullNamePlaceholder')}
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                required
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="email" className="text-muted-foreground">
                {t('emailLabel')}
              </Label>
              <Input
                id="email"
                type="email"
                placeholder={t('emailPlaceholder')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="password" className="text-muted-foreground">
                {t('passwordLabel')}
              </Label>
              <PasswordInput
                id="password"
                autoComplete="new-password"
                minLength={MIN_PASSWORD_LENGTH}
                aria-describedby="password-requirements"

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

            <PasswordRequirements id="password-requirements" />

            {termsVersion ? (
              <div className="flex items-start gap-2">
                <Checkbox
                  id="acceptTerms"
                  checked={termsAccepted}
                  onCheckedChange={(checked) => setTermsAccepted(checked === true)}
                  className="mt-0.5"
                />
                <Label htmlFor="acceptTerms" className="text-muted-foreground text-sm leading-snug font-normal">
                  {tTerms.rich('label', {
                    terms: (chunks) => (
                      <Link href="/terms" target="_blank" className="text-primary underline">
                        {chunks}
                      </Link>
                    ),
                    privacy: (chunks) => (
                      <Link href="/privacy" target="_blank" className="text-primary underline">
                        {chunks}
                      </Link>
                    ),
                  })}
                </Label>
              </div>
            ) : null}

            <Button
              type="submit"
              disabled={loading}
              className="bg-primary text-primary-foreground hover:bg-primary/90 mt-2 h-10 w-full disabled:opacity-50"
            >
              {loading ? t('creating') : t('submit')}
            </Button>
          </form>

          <p className="text-muted-foreground mt-6 text-center text-sm">
            {t('haveAccount')}{' '}
            <Link
              href={
                inviteToken
                  ? `/login?invite=${encodeURIComponent(inviteToken)}`
                  : '/login'
              }
              className="text-primary hover:text-primary/80"
            >
              {t('signIn')}
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
