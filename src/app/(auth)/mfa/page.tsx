'use client';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { safeNextPath } from '@/lib/auth/callback';
import Link from 'next/link';
import { authFetch } from '@/lib/auth/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function MfaPage() {
  return <Suspense fallback={null}><MfaPageInner /></Suspense>;
}
function MfaPageInner() {
  const searchParams = useSearchParams();
  const next = safeNextPath(searchParams.get('next'), '/settings');
  const [enabled, setEnabled] = useState<boolean | null>(null),
    // false for an account created through Google: a recent Google sign-in confirms setup instead.
    [passwordSet, setPasswordSet] = useState(true),
    [reauth, setReauth] = useState(false),
    [password, setPassword] = useState(''),
    [code, setCode] = useState('');
  const [secret, setSecret] = useState<string | null>(null),
    [recovery, setRecovery] = useState<string[]>([]),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    authFetch('/api/auth/mfa')
      .then(async (response) => {
        if (response.status === 401) {
          // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- establish a fresh authenticated request after enrollment login
          window.location.href = `/login?next=${encodeURIComponent(next)}`;
          return;
        }
        const result = await response.json();
        if (!response.ok) throw new Error(result.error?.message);
        setEnabled(result.enabled);
        setPasswordSet(result.passwordSet !== false);
      })
      .catch(() => setMessage('Unable to load your security settings'));
  }, [next]);
  async function action(endpoint: string, payload: unknown) {
    setBusy(true);
    setMessage('');
    setReauth(false);
    try {
      const response = await authFetch(`/api/auth/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) {
        if (result.error?.code === 'google_reauth_required') setReauth(true);
        throw new Error(result.error?.message ?? 'Request failed');
      }
      if (endpoint === 'mfa-enroll') {
        setSecret(result.secret);
        setMessage(
          'Add this secret to your authenticator, then enter its six-digit code.'
        );
      }
      if (endpoint === 'mfa-verify') {
        setEnabled(true);
        setSecret(null);
        setRecovery(result.recoveryCodes);
        setPassword('');
        setCode('');
      }
      if (endpoint === 'mfa-disable' || endpoint === 'logout-all') {
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- discard application state after every session was revoked
        window.location.href = '/login';
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="bg-background flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>Account security</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p>
            Multi-factor authentication:{' '}
            {enabled === null ? 'Loading' : enabled ? 'Enabled' : 'Disabled'}
          </p>
          {message && <p role="status">{message}</p>}
          {reauth && (
            <a
              className="text-primary"
              href={`/api/auth/google/start?next=${encodeURIComponent(`/mfa?next=${encodeURIComponent(next)}`)}`}
            >
              Sign in with Google again
            </a>
          )}
          {recovery.length > 0 && (
            <div>
              <p>
                Save these recovery codes somewhere private. Each works once.
                They will be shown only here.
              </p>
              <pre className="bg-muted mt-2 rounded p-3 whitespace-pre-wrap">
                {recovery.join('\n')}
              </pre>
              <Button className="mt-2" onClick={() => setRecovery([])}>
                I saved my codes
              </Button>
            </div>
          )}
          {secret && (
            <div>
              <p>Authenticator setup secret</p>
              <code className="break-all">{secret}</code>
            </div>
          )}
          {!secret && !passwordSet && enabled === false && (
            <p className="text-muted-foreground text-sm">
              Your account signs in with Google, so your Google sign-in in the
              last 10 minutes confirms this setup.
            </p>
          )}
          {!secret && (passwordSet || enabled) && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="currentPassword">Current password</Label>
              <PasswordInput
                id="currentPassword"

                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          )}
          {(secret || enabled) && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="code">
                {secret
                  ? 'Six-digit authenticator code'
                  : 'Authenticator or recovery code'}
              </Label>
              <Input
                id="code"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </div>
          )}
          {enabled === false && !secret && (
            <Button
              disabled={busy || (passwordSet && !password)}
              onClick={() =>
                action(
                  'mfa-enroll',
                  passwordSet ? { currentPassword: password } : {}
                )
              }
            >
              Set up authenticator
            </Button>
          )}
          {secret && (
            <Button
              disabled={busy || !code}
              onClick={() => action('mfa-verify', { code })}
            >
              Verify and enable
            </Button>
          )}
          {enabled && (
            <Button
              variant="outline"
              disabled={busy || !password || !code}
              onClick={() =>
                action('mfa-disable', { currentPassword: password, code })
              }
            >
              Disable MFA and sign out all sessions
            </Button>
          )}
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => action('logout-all', {})}
          >
            Sign out all devices
          </Button>
          <Link href={enabled && recovery.length === 0 ? next : '/settings'} className="text-primary">
            {enabled && recovery.length === 0 && next !== '/settings' ? 'Continue' : 'Back to settings'}
          </Link>
        </CardContent>
      </Card>
    </main>
  );
}
