'use client';

// Settings -> Privacy & access (Phase 14): workspace export (owners and admins),
// support access (owners and admins), delete workspace (owner; members see a
// pending request), leave workspace (non-owners), create another workspace and
// delete my account (everyone).

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { authFetch } from '@/lib/auth/client';
import { SettingsPanelHead } from '../settings-panel-head';
import { HelpLink } from '@/components/help/help-link';
import { SupportAccess } from './support-access';
import { WorkspaceExportCard } from './workspace-export-card';
import { DeleteWorkspaceCard, type LifecycleState } from './delete-workspace-card';
import { CreateWorkspaceCard, DeleteAccountCard, LeaveWorkspaceCard } from './account-cards';

export function PrivacySection() {
  const t = useTranslations('Settings.privacy');
  const { account, isOwner, canManageMembers } = useAuth();
  const [lifecycle, setLifecycle] = useState<LifecycleState | null>(null);

  useEffect(() => {
    let live = true;
    authFetch('/api/account/deletion', { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<{ lifecycle?: LifecycleState }>) : null))
      .then((body) => {
        if (live && body?.lifecycle) setLifecycle(body.lifecycle);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const workspaceName = account?.name ?? '';

  return (
    <section className="max-w-3xl animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} action={<HelpLink section="privacy" />} />
      {canManageMembers ? <WorkspaceExportCard /> : null}
      {canManageMembers ? <SupportAccess /> : null}
      {isOwner ? null : <LeaveWorkspaceCard workspaceName={workspaceName} />}
      <CreateWorkspaceCard />
      <DeleteWorkspaceCard workspaceName={workspaceName} isOwner={isOwner} lifecycle={lifecycle} onChange={setLifecycle} />
      <DeleteAccountCard />
    </section>
  );
}
