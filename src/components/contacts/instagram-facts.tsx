'use client';

// Stage 5 (5E): a contact's Instagram facts on the contact page and in the
// inbox panel: username, follows you, you follow them, verified, followers,
// Instagram subscription, last interaction and the messaging window. Read from
// stored facts through GET /api/contacts/{id}/identities (no Meta call on
// render). Hidden while Instagram is off or the contact has no Instagram identity.
import { useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { authFetch } from '@/lib/auth/client';
import type { InstagramFactsView } from '@/lib/contacts/instagram-facts';
import { cn } from '@/lib/utils';
import { identityLabel } from './contact-identities';

interface IdentityRow {
  id: string;
  username: string | null;
  display_name: string | null;
}

interface FactsResponse {
  enabled: boolean;
  identities: IdentityRow[];
  facts?: InstagramFactsView | null;
}

/** Subscribed unless they opted out on Instagram; a contact with no identity has no status. */
export function instagramStatus(hasIdentity: boolean, subscription: InstagramFactsView['subscription']): 'subscribed' | 'unsubscribed' | 'none' {
  if (subscription === 'opted_out') return 'unsubscribed';
  return hasIdentity ? 'subscribed' : 'none';
}

export function InstagramFacts({ contactId, refreshToken, className }: { contactId: string; refreshToken?: string | number; className?: string }) {
  const t = useTranslations('Contacts.instagramFacts');
  const ts = useTranslations('Contacts.channelStatus');
  const format = useFormatter();
  const [data, setData] = useState<FactsResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    authFetch(`/api/contacts/${encodeURIComponent(contactId)}/identities`, { cache: 'no-store' })
      .then(async (res) => {
        const body = res.ok ? ((await res.json()) as FactsResponse) : null;
        if (!cancelled) setData(body);
      })
      .catch(() => {
        if (!cancelled) setData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [contactId, refreshToken]);

  if (!data?.enabled || !data.facts || data.identities.length === 0) return null;
  const facts = data.facts;
  const yesNo = (value: boolean | null) => (value === null ? t('unknown') : value ? t('yes') : t('no'));
  const when = (value: string | null) =>
    value ? format.dateTime(new Date(value), { dateStyle: 'medium', timeStyle: 'short' }) : t('unknown');
  const status = instagramStatus(data.identities.length > 0, facts.subscription);

  return (
    <section className={cn('space-y-3', className)} aria-label={t('title')}>
      <h3 className="text-[13px] font-semibold text-foreground">{t('title')}</h3>
      {data.identities.map((identity) => {
        const fact = facts.identities.find((row) => row.id === identity.id);
        return (
          <dl key={identity.id} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
            <dt className="text-muted-foreground">{t('username')}</dt>
            <dd className="truncate font-medium">{identityLabel(identity, t('unknown'))}</dd>
            <dt className="text-muted-foreground">{t('followsYou')}</dt>
            <dd>{yesNo(fact?.follows_business ?? null)}</dd>
            <dt className="text-muted-foreground">{t('youFollow')}</dt>
            <dd>{yesNo(fact?.business_follows ?? null)}</dd>
            <dt className="text-muted-foreground">{t('verified')}</dt>
            <dd>{yesNo(fact?.is_verified ?? null)}</dd>
            <dt className="text-muted-foreground">{t('followers')}</dt>
            <dd>{fact?.follower_count == null ? t('unknown') : format.number(fact.follower_count)}</dd>
          </dl>
        );
      })}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
        <dt className="text-muted-foreground">{t('subscription')}</dt>
        <dd>{status === 'none' ? ts('none') : ts(status)}</dd>
        <dt className="text-muted-foreground">{t('lastInteraction')}</dt>
        <dd>{when(facts.last_interaction_at)}</dd>
        <dt className="text-muted-foreground">{t('window')}</dt>
        <dd>
          {facts.window_open_until
            ? t('windowOpen', { time: format.dateTime(new Date(facts.window_open_until), { timeStyle: 'short', dateStyle: 'short' }) })
            : t('windowClosed')}
        </dd>
      </dl>
    </section>
  );
}
