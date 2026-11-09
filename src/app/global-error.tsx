'use client';

// Last-resort boundary for an error in the root layout itself. It replaces the root layout, so
// it renders its own <html>/<body> with the global styles and default theme, and has no
// NextIntlClientProvider: the build locale's catalogue (@app-messages, the one the root layout
// serves) is loaded on demand so it never weighs on normal page loads. Until it arrives, or if it
// cannot load (a stale deploy), the buttons still work and show their icons.

import { useEffect, useState } from 'react';
import { createTranslator } from 'next-intl';
import { AlertTriangle, RotateCw } from 'lucide-react';

import './globals.css';
import { Button } from '@/components/ui/button';
import { DEFAULT_MODE, DEFAULT_THEME } from '@/lib/themes';
import { errorDigest } from '@/components/error-state';

type Strings = Record<'errorTitle' | 'errorDesc' | 'tryAgain' | 'reload', string> & { reference?: string };

export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  const [text, setText] = useState<Strings | null>(null);
  const digest = errorDigest(error);

  useEffect(() => {
    let cancelled = false;
    import('@app-messages')
      .then(({ default: messages }) => {
        if (cancelled) return;
        const t = createTranslator({
          locale: process.env.NEXT_PUBLIC_APP_LOCALE || 'en',
          messages,
          namespace: 'ErrorPages',
        });
        setText({
          errorTitle: t('errorTitle'),
          errorDesc: t('errorDesc'),
          tryAgain: t('tryAgain'),
          reload: t('reload'),
          ...(digest ? { reference: t('reference', { digest }) } : {}),
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [digest]);

  return (
    <html lang={process.env.NEXT_PUBLIC_APP_LOCALE || 'en'} data-theme={DEFAULT_THEME} data-mode={DEFAULT_MODE}>
      <body className="bg-background text-foreground min-h-screen font-sans antialiased">
        <main className="flex min-h-screen items-center justify-center px-4">
          <div className="border-border bg-card flex w-full max-w-md flex-col items-center gap-3 rounded-xl border p-6 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-amber-500/10">
              <AlertTriangle className="h-6 w-6 text-amber-500" aria-hidden />
            </div>
            {text && <h1 className="text-foreground text-xl font-semibold">{text.errorTitle}</h1>}
            {text && <p className="text-muted-foreground text-sm">{text.errorDesc}</p>}
            <div className="mt-2 flex w-full flex-col gap-2">
              <Button onClick={() => retry()} className="w-full" aria-label={text?.tryAgain}>
                <RotateCw className="size-4" aria-hidden />
                {text?.tryAgain}
              </Button>
              <Button variant="outline" onClick={() => window.location.reload()} className="w-full" aria-label={text?.reload}>
                {text?.reload ?? '↻'}
              </Button>
            </div>
            {text?.reference && <p className="text-muted-foreground font-mono text-xs">{text.reference}</p>}
          </div>
        </main>
      </body>
    </html>
  );
}
