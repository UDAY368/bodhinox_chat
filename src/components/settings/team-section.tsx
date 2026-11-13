'use client';

/**
 * Settings › Team members as the prototype's Members | Groups | Permissions
 * switch with counts and "N of M seats used". Each tab keeps the app's own
 * card (roster with invites and roles, teams editor, editable permission
 * matrix). Permissions shows to those who can change them, as before (the
 * restriction rows are admin-only).
 */
import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { authFetch } from '@/lib/auth/client';
import { cn } from '@/lib/utils';
import { MembersTab } from './members-tab';
import { PermissionsMatrix } from './teams/permissions-matrix';
import { TeamsCard } from './teams/teams-card';

type Tab = 'members' | 'groups' | 'permissions';

interface Counts {
  members: number | null;
  groups: number | null;
  seats: number | null;
  plan: string | null;
}

export function TeamSection() {
  const t = useTranslations('SettingsRedesign.team');
  const { accountId, canManageMembers } = useAuth();
  const [tab, setTab] = useState<Tab>('members');
  const [counts, setCounts] = useState<Counts>({ members: null, groups: null, seats: null, plan: null });

  useEffect(() => {
    if (!accountId) return;
    let live = true;
    const json = (url: string) => authFetch(url, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    void Promise.all([json('/api/account/members'), canManageMembers ? json('/api/teams') : null, json('/api/account/plan')])
      .then(([members, teams, plan]) => {
        if (!live) return;
        setCounts({
          members: Array.isArray(members?.members) ? members.members.length : null,
          groups: Array.isArray(teams?.teams) ? teams.teams.length : null,
          seats: typeof plan?.limits?.seats === 'number' ? plan.limits.seats : null,
          plan: typeof plan?.planName === 'string' ? plan.planName : null,
        });
      });
    return () => { live = false; };
  }, [accountId, canManageMembers, tab]);

  const tabs: { id: Tab; label: string; count: number | null }[] = [
    { id: 'members', label: t('members'), count: counts.members },
    { id: 'groups', label: t('groups'), count: counts.groups },
    ...(canManageMembers ? [{ id: 'permissions' as const, label: t('permissions'), count: null }] : []),
  ];

  // Arrow keys move between tabs (WAI-ARIA tabs pattern).
  const onKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    setTab(next.id);
    document.getElementById(`team-tab-${next.id}`)?.focus();
  };

  let panel: ReactNode;
  if (tab === 'groups') panel = <TeamsCard canEdit={canManageMembers} />;
  else if (tab === 'permissions') panel = <PermissionsMatrix canEdit={canManageMembers} />;
  else panel = <MembersTab />;

  return (
    <div key={accountId} className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label={t('tabs')} className="inline-flex max-w-full gap-1 overflow-x-auto rounded-lg border border-border bg-muted/60 p-1">
          {tabs.map((item, index) => {
            const on = tab === item.id;
            return (
              <button
                key={item.id}
                id={`team-tab-${item.id}`}
                type="button"
                role="tab"
                aria-selected={on}
                aria-controls="team-tab-panel"
                tabIndex={on ? 0 : -1}
                onClick={() => setTab(item.id)}
                onKeyDown={(event) => onKey(event, index)}
                className={cn(
                  'inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  on ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {item.label}
                {item.count !== null && <span className="text-xs tabular-nums text-muted-foreground">{item.count}</span>}
              </button>
            );
          })}
        </div>
        {counts.members !== null && counts.seats !== null && (
          <p className="text-xs text-muted-foreground tabular-nums">
            {counts.plan ? t('seatsOnPlan', { used: counts.members, total: counts.seats, plan: counts.plan }) : t('seats', { used: counts.members, total: counts.seats })}
          </p>
        )}
      </div>
      <div id="team-tab-panel" role="tabpanel" aria-labelledby={`team-tab-${tab}`}>
        {panel}
      </div>
    </div>
  );
}
