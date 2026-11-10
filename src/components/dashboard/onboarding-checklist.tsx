'use client';

// The dashboard's "Get started" checklist (Phase 14). Every step is read from
// state the workspace already has (no new table). Its steps follow the
// workspace's enabled channels (Stage 1):
//   WhatsApp:  a connected number, a contact, a message template
//   Instagram: a connected account, a received Instagram message (proof that
//              "Allow access to messages" is on), a comment-reply rule
//   shared:    a flow or automation, and a second member or pending invitation
// Hidden once every step is done, or when dismissed; dismissal is per user and
// workspace in this browser (localStorage, the store the app already uses for
// per-user display preferences).

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { CheckCircle2, Circle, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { useWorkspaceChannels } from '@/hooks/use-workspace-channels';
import { authFetch } from '@/lib/auth/client';
import { CHANNELS } from '@/lib/channels/capabilities';
import { channelPath, channelSettingsPath } from '@/lib/channels/routes';
import { createClient } from '@/lib/data/client';
import type { InstagramAccountView } from '@/lib/instagram/connection';
import type { Channel } from '@/types';

export type OnboardingStep =
  | 'whatsapp'
  | 'contacts'
  | 'templates'
  | 'instagramConnect'
  | 'instagramAllowMessages'
  | 'instagramCommentAutomation'
  | 'automation'
  | 'team';

const STEPS_BY_CHANNEL: Record<Channel, readonly OnboardingStep[]> = {
  whatsapp: ['whatsapp', 'contacts', 'templates'],
  instagram: ['instagramConnect', 'instagramAllowMessages', 'instagramCommentAutomation'],
};
const SHARED_STEPS: readonly OnboardingStep[] = ['automation', 'team'];
const ONBOARDING_ENABLED_FALLBACK: readonly Channel[] = ['whatsapp'];

/** The steps for a workspace's enabled channels: WhatsApp's, then Instagram's, then the shared ones. None enabled counts as WhatsApp. */
export function onboardingSteps(enabled: readonly Channel[]): OnboardingStep[] {
  const channels = CHANNELS.filter((channel) => enabled.includes(channel));
  return [...(channels.length ? channels : ['whatsapp' as const]).flatMap((c) => STEPS_BY_CHANNEL[c]), ...SHARED_STEPS];
}

/** A WhatsApp workspace's steps (the checklist before Stage 1). */
export const ONBOARDING_STEPS: readonly OnboardingStep[] = onboardingSteps(['whatsapp']);

/** Each step's message key under Dashboard.onboarding. */
const LABEL: Record<OnboardingStep, string> = {
  whatsapp: 'steps.whatsapp',
  contacts: 'steps.contacts',
  templates: 'steps.templates',
  instagramConnect: 'instagram.connect',
  instagramAllowMessages: 'instagram.allowMessages',
  instagramCommentAutomation: 'instagram.firstCommentAutomation',
  automation: 'steps.automation',
  team: 'steps.team',
};

export const STEP_HREF: Record<OnboardingStep, string> = {
  whatsapp: channelSettingsPath('whatsapp'),
  contacts: '/contacts',
  templates: channelPath('whatsapp', 'templates'),
  instagramConnect: channelSettingsPath('instagram'),
  instagramAllowMessages: channelSettingsPath('instagram'),
  instagramCommentAutomation: channelPath('instagram', 'comments'),
  automation: '/flows',
  team: '/settings?tab=members',
};

export const dismissKey = (accountId: string, userId: string) => `bodhinox:onboarding-dismissed:${accountId}:${userId}`;

/** The team step's count: members plus open invitations (an invitation means someone was invited). */
export function teamCount(members: number | null, invitations: number | null): number | null {
  if (members === null && invitations === null) return null;
  return (members ?? 0) + (invitations ?? 0);
}

/** Steps done, from counts (null = unknown, treated as not done), in the order of `steps`. */
export function completedSteps(state: Partial<Record<OnboardingStep, number | null>>,
  steps: readonly OnboardingStep[] = ONBOARDING_STEPS): Set<OnboardingStep> {
  return new Set(steps.filter((step) => (state[step] ?? 0) > (step === 'team' ? 1 : 0)));
}

function readDismissed(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

/** Comment-reply rules on the workspace's live Instagram accounts that have the comments permission (admins only). */
async function countCommentRules(): Promise<number | null> {
  try {
    const res = await authFetch('/api/instagram/status', { cache: 'no-store' });
    const status = (res.ok ? await res.json() : null) as { enabled?: boolean; accounts?: InstagramAccountView[] } | null;
    if (!status?.enabled || !Array.isArray(status.accounts)) return null;
    const ready = status.accounts.filter((a) => a.status !== 'disconnected' && a.missingScopes.comments.length === 0);
    let total = 0;
    for (const account of ready) {
      const rules = await authFetch(`/api/instagram/accounts/${encodeURIComponent(account.id)}/comment-rules`, { cache: 'no-store' });
      if (!rules.ok) return null;
      const body = (await rules.json()) as { rules?: unknown[] };
      total += Array.isArray(body.rules) ? body.rules.length : 0;
      if (total > 0) break;
    }
    return total;
  } catch {
    return null;
  }
}

export function OnboardingChecklist() {
  const t = useTranslations('Dashboard.onboarding');
  const { user, accountId } = useAuth();
  const canEdit = useCan('edit-settings');
  const channels = useWorkspaceChannels();
  const [done, setDone] = useState<Set<OnboardingStep> | null>(null);
  const [dismissed, setDismissed] = useState(false);
  // The steps wait for the channel state; if it cannot load, the WhatsApp steps (as before Stage 1).
  const enabled = channels.data?.enabled ?? (channels.error ? ONBOARDING_ENABLED_FALLBACK : null);
  const stepsKey = enabled ? onboardingSteps(enabled).join(',') : null;
  const instagramConnected = !!channels.data && channels.data.channels.instagram.connection !== 'none';

  useEffect(() => {
    if (!user?.id || !accountId || !stepsKey) return;
    // Read after mount (never during render) so server and client markup match.
    if (readDismissed(dismissKey(accountId, user.id))) return;
    const steps = stepsKey.split(',') as OnboardingStep[];
    const needs = (step: OnboardingStep) => steps.includes(step);
    let live = true;
    const db = createClient();
    const count = (table: string, where?: [column: string, value: string]) => {
      const query = db.from(table).select('id', { count: 'exact', head: true }).eq('account_id', accountId);
      return (where ? query.eq(where[0], where[1]) : query)
        .then((r) => (r.error ? null : (r.count ?? 0)), () => null);
    };
    const skip = Promise.resolve(null);
    (async () => {
      const [whatsapp, contacts, templates, instagramMessages, commentRules, flows, automations, members, invitations] = await Promise.all([
        needs('whatsapp') ? count('whatsapp_config') : skip,
        needs('contacts') ? count('contacts') : skip,
        needs('templates') ? count('message_templates') : skip,
        // A received Instagram message shows "Allow access to messages" is on.
        needs('instagramAllowMessages') ? count('conversations', ['channel', 'instagram']) : skip,
        // Comment rules are admin-only on the server; for others the step stays open.
        needs('instagramCommentAutomation') && canEdit && instagramConnected ? countCommentRules() : skip,
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
        instagramConnect: instagramConnected ? 1 : 0,
        instagramAllowMessages: instagramMessages,
        instagramCommentAutomation: commentRules,
        automation: (flows ?? 0) + (automations ?? 0),
        team: teamCount(members, invitations),
      }, steps));
    })();
    return () => {
      live = false;
    };
  }, [user?.id, accountId, stepsKey, canEdit, instagramConnected]);

  const steps = stepsKey ? (stepsKey.split(',') as OnboardingStep[]) : [];
  if (dismissed || !done || !steps.length || steps.every((step) => done.has(step)) || !user?.id || !accountId) return null;

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
          <p className="mt-1 text-sm text-muted-foreground">
            {t('progress', { done: steps.filter((step) => done.has(step)).length, total: steps.length })}
          </p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={dismiss} aria-label={t('dismiss')} title={t('dismiss')}>
          <X className="size-4" />
        </Button>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2">
          {steps.map((step) => {
            const complete = done.has(step);
            return (
              <li key={step} className="flex items-center gap-2 text-sm" data-onboarding-step={step}>
                {complete ? <CheckCircle2 className="size-4 text-emerald-500" /> : <Circle className="size-4 text-muted-foreground" />}
                {complete ? (
                  <span className="text-muted-foreground line-through">{t(LABEL[step])}</span>
                ) : (
                  <Link href={STEP_HREF[step]} className="text-foreground hover:text-primary hover:underline">{t(LABEL[step])}</Link>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
