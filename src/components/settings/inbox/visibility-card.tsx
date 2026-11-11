'use client';

// Stage 5 (5E): Settings › Inbox › What agents can see. With 'assigned_or_team'
// an agent sees and works only conversations assigned to them, to their team,
// or to nobody (src/lib/inbox/inbox-scope.ts). Owners and admins always see
// everything; the default 'all' is the behaviour before Stage 5. Every member
// reads it; admins and owners change it (PUT /api/inbox/settings checks again).
import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { authFetch } from '@/lib/auth/client';
import type { WorkspaceInboxSettings } from '@/lib/inbox/inbox-settings';
import type { AgentVisibility } from '@/types';
import { saveBehaviour } from './assignment-mode-card';

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
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">{t('title')}</CardTitle>
        <CardDescription className="text-muted-foreground">{t('description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {loadFailed ? (
          <p className="text-destructive text-xs">{t('loadFailed')}</p>
        ) : !settings ? (
          <Loader2 className="text-primary size-4 animate-spin" />
        ) : (
          <RadioGroup
            value={settings.agent_visibility}
            onValueChange={(value) => void change(value as AgentVisibility)}
            disabled={!canEdit || saving}
            aria-label={t('title')}
          >
            {OPTIONS.map((option) => (
              <Label key={option.value} className="flex items-center gap-2 text-sm font-normal">
                <RadioGroupItem value={option.value} />
                {t(option.key)}
              </Label>
            ))}
          </RadioGroup>
        )}
      </CardContent>
    </Card>
  );
}
