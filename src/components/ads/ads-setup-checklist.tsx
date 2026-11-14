'use client';

// The setup card at the top of the Ads page (admins): what is done and what is
// left before ads can be reported on and created here, each step linking to
// where it is fixed. It hides once every step is done, and an admin can hide
// it for this browser.

import { useState } from 'react';
import Link from 'next/link';
import { Check, Circle, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

export interface SetupStep {
  key: 'connect' | 'adAccount' | 'page' | 'manage' | 'permissions';
  done: boolean;
  /** Where the admin fixes it; null when it is not something they can change here. */
  href: string | null;
}

/** The setup steps from what the Ads page already knows. Pure, so it is tested on its own. */
export function setupSteps(input: {
  connected: boolean; adAccounts: number; pageId: string | null; manageEnabled: boolean; missingScopes: string[];
}): SetupStep[] {
  const settings = '/settings?tab=ads';
  return [
    { key: 'connect', done: input.connected, href: settings },
    { key: 'adAccount', done: input.adAccounts > 0, href: settings },
    { key: 'page', done: !!input.pageId, href: settings },
    { key: 'manage', done: input.manageEnabled, href: null },
    { key: 'permissions', done: input.manageEnabled && input.missingScopes.length === 0, href: settings },
  ];
}

const HIDE_KEY = 'bodhinox.ads.setup.hidden';

export function AdsSetupChecklist({ steps }: { steps: SetupStep[] }) {
  const t = useTranslations('Ads.setup');
  const [hidden, setHidden] = useState(() => {
    try { return typeof window !== 'undefined' && window.localStorage.getItem(HIDE_KEY) === '1'; } catch { return false; }
  });
  const done = steps.filter((s) => s.done).length;
  if (hidden || done === steps.length) return null;
  const hide = () => {
    setHidden(true);
    try { window.localStorage.setItem(HIDE_KEY, '1'); } catch { /* storage blocked: hidden for this view only */ }
  };

  return (
    <section className="rounded-xl border border-border bg-card p-4" aria-labelledby="ads-setup-title" data-testid="ads-setup">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="ads-setup-title" className="text-sm font-semibold text-foreground">{t('title')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('progress', { done, total: steps.length })}</p>
        </div>
        <button type="button" onClick={hide} aria-label={t('hide')}
          className="rounded-md p-1 text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          <X className="size-4" />
        </button>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${(done / steps.length) * 100}%` }} />
      </div>
      <ol className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {steps.map((s) => (
          <li key={s.key} className={cn('flex items-start gap-2 rounded-lg border px-3 py-2 text-xs', s.done ? 'border-transparent bg-primary/5' : 'border-border')}>
            {s.done
              ? <Check className="mt-0.5 size-3.5 shrink-0 text-primary" aria-label={t('done')} />
              : <Circle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-label={t('todo')} />}
            <span className="min-w-0">
              <span className={cn('block font-medium', s.done ? 'text-muted-foreground' : 'text-foreground')}>{t(`steps.${s.key}.title`)}</span>
              {!s.done && (
                <span className="mt-0.5 block text-muted-foreground">
                  {t(`steps.${s.key}.body`)}{' '}
                  {s.href && <Link href={s.href} className="font-medium text-primary hover:underline">{t('fix')}</Link>}
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
