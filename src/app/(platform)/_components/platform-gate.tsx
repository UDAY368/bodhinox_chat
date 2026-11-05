'use client';

// Shown instead of the console to an allowlisted platform admin whose session
// has no recent MFA confirmation ('step_up') or who has no verified factor
// ('enroll'). Step-up re-confirms the authenticator for this session only.

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { authFetch } from '@/lib/auth/client';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function PlatformGate({ kind }: { kind: 'enroll' | 'step_up' }) {
  const t = useTranslations('Platform.gate');
  const router = useRouter();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await authFetch('/api/auth/mfa-step-up', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.trim() }),
      });
      if (!response.ok) {
        setError(t('invalidCode'));
        return;
      }
      setCode('');
      router.refresh();
    } catch {
      setError(t('invalidCode'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-4 px-4 py-16">
      <Card>
        <CardHeader>
          <CardTitle>{kind === 'enroll' ? t('enrollTitle') : t('stepUpTitle')}</CardTitle>
          <CardDescription>{kind === 'enroll' ? t('enrollBody') : t('stepUpBody')}</CardDescription>
        </CardHeader>
        <CardContent>
          {kind === 'enroll' ? (
            <Link href="/settings?tab=security" className={buttonVariants({ variant: 'default' })}>
              {t('enrollAction')}
            </Link>
          ) : (
            <form onSubmit={submit} className="flex flex-col gap-3">
              <Label htmlFor="platform-step-up-code">{t('codeLabel')}</Label>
              <Input
                id="platform-step-up-code"
                autoComplete="one-time-code"
                inputMode="text"
                required
                maxLength={100}
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              {error && (
                <p role="alert" className="text-destructive text-sm">
                  {error}
                </p>
              )}
              <Button type="submit" disabled={busy || code.trim().length === 0}>
                {t('confirm')}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
