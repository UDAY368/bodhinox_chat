'use client';

// Campaign list header: the WhatsApp number's quality rating, daily
// messaging tier and an estimate of what is left today. Quality and tier
// come from Meta (/api/whatsapp/health); usage counts campaign sends only.

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { authFetch } from '@/lib/auth/client';
import type { PhoneHealth } from '@/lib/whatsapp/phone-health';

const QUALITY_CLASSES: Record<string, string> = {
  GREEN: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-400',
  YELLOW: 'bg-amber-500/12 text-amber-700 dark:text-amber-400',
  RED: 'bg-red-500/12 text-red-600 dark:text-red-400',
  UNKNOWN: 'bg-muted text-muted-foreground',
};

export function NumberHealthBar() {
  const t = useTranslations('Broadcasts.health');
  const [health, setHealth] = useState<PhoneHealth | null>(null);
  const [used, setUsed] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    authFetch('/api/whatsapp/health').then((r) => (r.ok ? r.json() : null)).then((h) => live && setHealth(h)).catch(() => {});
    authFetch('/api/broadcasts/usage').then((r) => (r.ok ? r.json() : null)).then((u) => live && u && setUsed(u.campaignContacts24h)).catch(() => {});
    return () => { live = false; };
  }, []);

  if (!health || health.state === 'disconnected') return null;
  const limit = health.limit;
  const remaining = limit?.kind === 'tier' && used !== null ? Math.max(0, limit.perDay - used) : null;

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl bg-muted px-4 py-2.5 text-sm" data-testid="number-health">
      <span className="flex items-center gap-2">
        <span className="text-muted-foreground">{t('quality')}</span>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${QUALITY_CLASSES[health.quality] ?? QUALITY_CLASSES.UNKNOWN}`}>
          {t(`ratings.${health.quality}`)}
        </span>
      </span>
      <span>
        <span className="text-muted-foreground">{t('tier')} </span>
        <span className="font-medium text-foreground">
          {limit?.kind === 'unlimited' ? t('unlimited') : limit ? t('perDay', { count: limit.perDay }) : t('unknown')}
        </span>
      </span>
      {remaining !== null && (
        <span title={t('remainingHint')}>
          <span className="text-muted-foreground">{t('remaining')} </span>
          <span className="font-medium text-foreground">≈ {remaining.toLocaleString()}</span>
        </span>
      )}
      {health.state === 'unavailable' && <span className="text-xs text-muted-foreground">{t('unavailable')}</span>}
    </div>
  );
}
