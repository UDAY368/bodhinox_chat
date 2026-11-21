'use client';

// Stage 5 (5E): Settings › Inbox › What agents can see. With 'assigned_or_team'
// an agent sees and works only conversations assigned to them, to their team,
// or to nobody (src/lib/inbox/inbox-scope.ts). Owners and admins always see
// everything; the default 'all' is the behaviour before Stage 5. Every member
// reads it; admins and owners change it (PUT /api/inbox/settings checks again).
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { authFetch } from '@/lib/auth/client';
import type { WorkspaceInboxSettings } from '@/lib/inbox/inbox-settings';
import type { AgentVisibility } from '@/types';
import { saveBehaviour } from './assignment-mode-card';
import { cn } from '@/lib/utils';
import { SETTINGS_ROW_HAIRLINE, SettingsGroup } from '../settings-row';

const OPTIONS: { value: AgentVisibility; key: 'all' | 'assignedOrTeam' }[] = [
  { value: 'all', key: 'all' },
  { value: 'assigned_or_team', key: 'assignedOrTeam' },
];

export function VisibilityCard({ canEdit }: { canEdit: boolean }) {
  const t = useTranslations('inboxSettings.visibility');
  const [settings, setSettings] = useState<WorkspaceInboxSettings | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    authFetch('/api/inbox/settings', { cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then((json: { settings: WorkspaceInboxSettings }) => { if (live) setSettings(json.settings); })
      .catch(() => { if (live) setLoadFailed(true); });
    return () => { live = false; };
  }, []);

  const change = async (value: AgentVisibility) => {
    if (!settings || value === settings.agent_visibility) return;
    setSaving(true);
    try {
      setSettings(await saveBehaviour(settings, 'agent_visibility', value));
      toast.success(t('saved'));
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsGroup title={t('title')} footer={t('description')}>
        {loadFailed ? (
          <div className={cn(SETTINGS_ROW_HAIRLINE, 'px-4 py-3')}><p className="text-destructive text-xs" role="alert">{t('loadFailed')}</p></div>
        ) : !settings ? (
          <div className={cn(SETTINGS_ROW_HAIRLINE, 'space-y-2 px-4 py-3')} role="status" aria-busy="true">
            <div className="h-5 w-2/3 animate-pulse rounded bg-muted motion-reduce:animate-none" />
            <div className="h-5 w-1/2 animate-pulse rounded bg-muted motion-reduce:animate-none" />
          </div>
        ) : (
          <RadioGroup
            className="gap-0"
            value={settings.agent_visibility}
            onValueChange={(value) => void change(value as AgentVisibility)}
            disabled={!canEdit || saving}
            aria-label={t('title')}
          >
            {OPTIONS.map((option) => (
              <Label key={option.value} className={cn(SETTINGS_ROW_HAIRLINE, 'flex min-h-11 cursor-pointer items-center gap-3 px-4 py-3 text-sm font-normal has-disabled:cursor-default')}>
                <span className="min-w-0 flex-1">{t(option.key)}</span>
                <RadioGroupItem value={option.value} />
              </Label>
            ))}
          </RadioGroup>
        )}
    </SettingsGroup>
  );
}
