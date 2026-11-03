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
    <div className="rounded-lg border border-border bg-card p-6">
      <div className="flex items-start gap-3">
        <Megaphone className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div className="space-y-1">
          <h2 className="text-base font-medium text-foreground">{t('title')}</h2>
          <p className="text-sm text-muted-foreground">{reason === 'flag_off' ? t('flagOff') : t('notConfigured')}</p>
          {count !== null && (
            <p className="pt-2 text-sm text-foreground" data-testid="ads-referral-count">
              {t('adClicks', { count })}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
