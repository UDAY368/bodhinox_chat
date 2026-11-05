'use client';

// A non-blocking banner for signed-in users who have not accepted the current
// terms of service. Shown only while TERMS_VERSION is configured (the session
// response then carries termsVersion and termsPending); unset = never shown.
// "Later" hides it for this browser tab only.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { authFetch } from '@/lib/auth/client';
import { sendJson } from './step-up';

const LATER_KEY = 'bodhinox:terms-later';

export function TermsBanner() {
  const t = useTranslations('Settings.privacy.terms');
  const [version, setVersion] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    authFetch('/api/auth/session', { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<{ session?: { termsVersion?: unknown; termsPending?: unknown } | null }>) : null))
      .then((body) => {
        const session = body?.session;
        if (!live || !session || session.termsPending !== true || typeof session.termsVersion !== 'string') return;
        let later: string | null = null;
        try {
          later = window.sessionStorage.getItem(LATER_KEY);
        } catch {
          later = null;
        }
        if (later !== session.termsVersion) setVersion(session.termsVersion);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  if (!version) return null;

  const accept = async () => {
    setBusy(true);
    const result = await sendJson('/api/auth/terms-accept', 'POST', { termsVersion: version });
    setBusy(false);
    if (result.ok) setVersion(null);
  };

  const later = () => {
    try {
      window.sessionStorage.setItem(LATER_KEY, version);
    } catch {
      // Storage unavailable: hiding for this render is enough.
    }
    setVersion(null);
  };

  return (
    <div role="status" className="flex flex-wrap items-center gap-3 border-b border-border bg-muted/60 px-4 py-2 text-sm">
      <span className="flex-1 text-foreground">
        {t.rich('banner', { link: (chunks) => <Link href="/terms" target="_blank" className="text-primary underline">{chunks}</Link> })}
      </span>
      <Button size="sm" onClick={accept} disabled={busy}>{t('accept')}</Button>
      <Button size="sm" variant="ghost" onClick={later} disabled={busy}>{t('later')}</Button>
    </div>
  );
}
