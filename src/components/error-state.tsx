'use client';

// The translated body of app/error.tsx and app/(dashboard)/error.tsx: what happened, a retry of
// the failed segment (retry re-fetches it), a full reload (a stale chunk after a deploy needs one) and a way home.
// The error message itself is never shown (it may carry internal detail); the digest is the
// server log reference.

import Link from 'next/link';
import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Home, RotateCw } from 'lucide-react';

import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/** The server log reference of a Server Component error; a Client Component may throw anything. */
export function errorDigest(error: unknown): string | null {
  const digest = error instanceof Error ? (error as Error & { digest?: unknown }).digest : undefined;
  return typeof digest === 'string' && digest ? digest.slice(0, 64) : null;
}

export function ErrorState({ error, retry }: { error: unknown; retry: () => void }) {
  const t = useTranslations('ErrorPages');
  const digest = errorDigest(error);
  useEffect(() => {
    // Name and digest only: messages can carry customer content.
    console.error('[ui] render error', error instanceof Error ? error.name : typeof error, digest ?? '');
  }, [error, digest]);
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4 py-10">
      <Card className="border-border bg-card w-full max-w-md">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-amber-500/10">
            <AlertTriangle className="h-6 w-6 text-amber-500" />
          </div>
          <CardTitle className="text-foreground text-xl">{t('errorTitle')}</CardTitle>
          <CardDescription className="text-muted-foreground">{t('errorDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <Button onClick={() => retry()} className="w-full">
            <RotateCw className="size-4" />
            {t('tryAgain')}
          </Button>
          <Button variant="outline" onClick={() => window.location.reload()} className="w-full">
            {t('reload')}
          </Button>
          <Link href="/dashboard" className={buttonVariants({ variant: 'ghost', className: 'w-full' })}>
            <Home className="size-4" />
            {t('goHome')}
          </Link>
          {digest && (
            <p className="text-muted-foreground mt-2 text-center font-mono text-xs">
              {t('reference', { digest })}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
