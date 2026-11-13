'use client';

// The Ads page while Meta ads are off (flag unset) or not fully configured.
// Referral capture needs no Meta approval, so the count of conversations
// started from ads still shows, from GET /api/meta-ads/referrals/summary.

import { useEffect, useState } from 'react';
import { Megaphone } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { authFetch } from '@/lib/auth/client';

export function AdsNotEnabled({ reason }: { reason: 'flag_off' | 'not_configured' }) {
  const t = useTranslations('Ads.notEnabled');
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    authFetch('/api/meta-ads/referrals/summary', { cache: 'no-store' })
      .then(async (res) => (res.ok ? ((await res.json()) as { conversations?: unknown }) : null))
      .then((body) => {
        if (live && typeof body?.conversations === 'number') setCount(body.conversations);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-border bg-card px-4 py-12 text-center">
      <span className="mb-1 inline-flex size-13 items-center justify-center rounded-2xl bg-primary/10 text-primary" aria-hidden>
        <Megaphone className="size-6" />
      </span>
      <h2 className="text-[15px] font-semibold text-foreground">{t('title')}</h2>
      <p className="max-w-md text-sm text-muted-foreground">{reason === 'flag_off' ? t('flagOff') : t('notConfigured')}</p>
      {count !== null && (
        <p className="mt-2 rounded-full bg-muted px-3 py-1 text-sm font-medium tabular-nums text-foreground" data-testid="ads-referral-count">
          {t('adClicks', { count })}
        </p>
      )}
    </div>
  );
}
