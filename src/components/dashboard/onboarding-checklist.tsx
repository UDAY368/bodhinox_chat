'use client';

// The dashboard's "Get started" checklist (Phase 14). Every step is read from
// state the workspace already has (no new table): a connected WhatsApp number,
// a contact, a message template, a flow or automation, and a second member or
// pending invitation. Hidden once every step is done, or when dismissed;
// dismissal is per user and workspace in this browser (localStorage, the store
// the app already uses for per-user display preferences).

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { CheckCircle2, Circle, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/hooks/use-auth';
import { authFetch } from '@/lib/auth/client';
import { createClient } from '@/lib/data/client';

export const ONBOARDING_STEPS = ['whatsapp', 'contacts', 'templates', 'automation', 'team'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

const HREF: Record<OnboardingStep, string> = {
  whatsapp: '/settings?tab=whatsapp',
  contacts: '/contacts',
  templates: '/settings?tab=templates',
  automation: '/flows',
  team: '/settings?tab=members',
};

export const dismissKey = (accountId: string, userId: string) => `bodhinox:onboarding-dismissed:${accountId}:${userId}`;

/** The team step's count: members plus open invitations (an invitation means someone was invited). */
export function teamCount(members: number | null, invitations: number | null): number | null {
  if (members === null && invitations === null) return null;
  return (members ?? 0) + (invitations ?? 0);
}

/** Steps done, from counts (null = unknown, treated as not done). */
export function completedSteps(state: Partial<Record<OnboardingStep, number | null>>): Set<OnboardingStep> {
  return new Set(ONBOARDING_STEPS.filter((step) => (state[step] ?? 0) > (step === 'team' ? 1 : 0)));
}

function readDismissed(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

export function OnboardingChecklist() {
  const t = useTranslations('Dashboard.onboarding');
  const { user, accountId } = useAuth();
  const [done, setDone] = useState<Set<OnboardingStep> | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!user?.id || !accountId) return;
    // Read after mount (never during render) so server and client markup match.
    if (readDismissed(dismissKey(accountId, user.id))) return;
    let live = true;
    const db = createClient();
    const count = (table: string) =>
      db.from(table).select('id', { count: 'exact', head: true }).eq('account_id', accountId)
        .then((r) => (r.error ? null : (r.count ?? 0)), () => null);
    (async () => {
      const [whatsapp, contacts, templates, flows, automations, members, invitations] = await Promise.all([
        count('whatsapp_config'),
        count('contacts'),
        count('message_templates'),
        count('flows'),
        count('automations'),
        authFetch('/api/account/members', { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : null))
          .then((b: { members?: unknown[] } | null) => (Array.isArray(b?.members) ? b.members.length : null))
          .catch(() => null),
        // Open invitations (admins and owners only; a 403 for others counts as none).
        authFetch('/api/account/invitations', { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : null))
          .then((b: { invitations?: unknown[] } | null) => (Array.isArray(b?.invitations) ? b.invitations.length : null))
          .catch(() => null),
      ]);
      if (!live) return;
      setDone(completedSteps({
        whatsapp,
        contacts,
        templates,
        automation: (flows ?? 0) + (automations ?? 0),
        team: teamCount(members, invitations),
      }));
    })();
    return () => {
      live = false;
    };
  }, [user?.id, accountId]);

  if (dismissed || !done || done.size === ONBOARDING_STEPS.length || !user?.id || !accountId) return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(dismissKey(accountId, user.id), '1');
    } catch {
      // Storage unavailable: hide for this visit only.
    }
    setDismissed(true);
  };

  return (
    <Card data-testid="onboarding-checklist">
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle className="text-foreground">{t('title')}</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">{t('progress', { done: done.size, total: ONBOARDING_STEPS.length })}</p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={dismiss} aria-label={t('dismiss')} title={t('dismiss')}>
          <X className="size-4" />
        </Button>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2">
          {ONBOARDING_STEPS.map((step) => {
            const complete = done.has(step);
            return (
              <li key={step} className="flex items-center gap-2 text-sm">
                {complete ? <CheckCircle2 className="size-4 text-emerald-500" /> : <Circle className="size-4 text-muted-foreground" />}
                {complete ? (
                  <span className="text-muted-foreground line-through">{t(`steps.${step}`)}</span>
                ) : (
                  <Link href={HREF[step]} className="text-foreground hover:text-primary hover:underline">{t(`steps.${step}`)}</Link>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
