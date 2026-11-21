'use client';

/**
 * Settings › Team members as a Members | Groups | Permissions segmented
 * control with counts and "N of M seats used". Each tab keeps the app's own
 * card (roster with invites and roles, teams editor, editable permission
 * matrix). Permissions shows to those who can change them, as before (the
 * restriction rows are admin-only).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { authFetch } from '@/lib/auth/client';
import { SegmentedControl } from '@/components/ui/segmented-control';
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

  let panel: ReactNode;
  if (tab === 'groups') panel = <TeamsCard canEdit={canManageMembers} />;
  else if (tab === 'permissions') panel = <PermissionsMatrix canEdit={canManageMembers} />;
  else panel = <MembersTab />;

  return (
    <div key={accountId} className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl
          aria-label={t('tabs')}
          value={tab}
          onValueChange={setTab}
          options={tabs.map((item) => ({ value: item.id, label: item.label, count: item.count ?? undefined }))}
        />
        {counts.members !== null && counts.seats !== null && (
          <p className="text-xs text-muted-foreground tabular-nums">
            {counts.plan ? t('seatsOnPlan', { used: counts.members, total: counts.seats, plan: counts.plan }) : t('seats', { used: counts.members, total: counts.seats })}
          </p>
        )}
      </div>
      <div id="team-tab-panel">{panel}</div>
    </div>
  );
}
