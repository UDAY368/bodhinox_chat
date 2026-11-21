'use client';

// Stage 5 (5E): Settings › Inbox › Automatic assignment. The mode (off, an even
// spread over online agents, or the routing rules, the default) is saved through
// PUT /api/inbox/settings; each agent's limit on open conversations through
// PUT /api/account/members/:userId/capacity. Every member reads the mode; admins
// and owners change both (the routes check the role again).
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { authFetch } from '@/lib/auth/client';
import type { WorkspaceInboxSettings } from '@/lib/inbox/inbox-settings';
import { AUTO_ASSIGN_MODES, INBOX_BEHAVIOUR_KEYS, type AccountMember, type AutoAssignMode, type InboxBehaviourSettings } from '@/types';
import { cn } from '@/lib/utils';
import { SETTINGS_ROW_HAIRLINE, SettingsGroup, SettingsRow } from '../settings-row';

/**
 * The PUT body that changes one Stage 5 setting: the loaded core settings
 * (the route requires them) with every other Stage 5 setting left out, so the
 * stored values of the pause, assignment and visibility cards are kept.
 */
export function behaviourBody<K extends keyof InboxBehaviourSettings>(
  settings: WorkspaceInboxSettings,
  key: K,
  value: InboxBehaviourSettings[K],
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...settings };
  for (const other of INBOX_BEHAVIOUR_KEYS) delete body[other];
  body[key] = value;
  return body;
}

/** Saves one Stage 5 setting; resolves the stored settings or throws with the server's message. */
export async function saveBehaviour<K extends keyof InboxBehaviourSettings>(
  settings: WorkspaceInboxSettings,
  key: K,
  value: InboxBehaviourSettings[K],
): Promise<WorkspaceInboxSettings> {
  const res = await authFetch('/api/inbox/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(behaviourBody(settings, key, value)),
  });
  const json = (await res.json().catch(() => ({}))) as { settings?: WorkspaceInboxSettings; error?: unknown };
  if (!res.ok || !json.settings) throw new Error(typeof json.error === 'string' ? json.error : '');
  return json.settings;
}

/** '' is no limit; otherwise a whole number from 1 to 1000, else undefined (invalid). */
export function parseCapacityField(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return n >= 1 && n <= 1000 ? n : undefined;
}

interface CapacityRow {
  member: AccountMember;
  max: number | null;
  open: number;
  draft: string;
}

export function AssignmentModeCard({ canEdit }: { canEdit: boolean }) {
  const t = useTranslations('inboxSettings.assignment');
  const [settings, setSettings] = useState<WorkspaceInboxSettings | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rows, setRows] = useState<CapacityRow[]>([]);

  useEffect(() => {
    let live = true;
    authFetch('/api/inbox/settings', { cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then((json: { settings: WorkspaceInboxSettings }) => { if (live) setSettings(json.settings); })
      .catch(() => { if (live) setLoadFailed(true); });
    return () => { live = false; };
  }, []);

  // Capacities are admin-only reads; members who can receive conversations only.
  useEffect(() => {
    if (!canEdit) return;
    let live = true;
    (async () => {
      try {
        const res = await authFetch('/api/account/members', { cache: 'no-store' });
        if (!res.ok) return;
        const { members } = (await res.json()) as { members: AccountMember[] };
        const assignable = members.filter((m) => m.role !== 'viewer');
        const loaded = await Promise.all(assignable.map(async (member) => {
          const r = await authFetch(`/api/account/members/${encodeURIComponent(member.user_id)}/capacity`, { cache: 'no-store' });
          const body = r.ok ? ((await r.json()) as { capacity: { max_open_conversations: number | null; open_conversations: number } }) : null;
          const max = body?.capacity.max_open_conversations ?? null;
          return { member, max, open: body?.capacity.open_conversations ?? 0, draft: max === null ? '' : String(max) };
        }));
        if (live) setRows(loaded);
      } catch {
        // The capacity list is optional; the mode still saves without it.
      }
    })();
    return () => { live = false; };
  }, [canEdit]);

  const changeMode = async (mode: AutoAssignMode) => {
    if (!settings || mode === settings.auto_assign_mode) return;
    setSaving(true);
    try {
      setSettings(await saveBehaviour(settings, 'auto_assign_mode', mode));
      toast.success(t('saved'));
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const saveCapacity = async (row: CapacityRow) => {
    const max = parseCapacityField(row.draft);
    if (max === undefined) {
      toast.error(t('capacityHelp'));
      return;
    }
    setSaving(true);
    try {
      const res = await authFetch(`/api/account/members/${encodeURIComponent(row.member.user_id)}/capacity`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ max_open_conversations: max }),
      });
      if (!res.ok) throw new Error();
      const { capacity } = (await res.json()) as { capacity: { max_open_conversations: number | null; open_conversations: number } };
      setRows((prev) => prev.map((r) => (r.member.user_id === row.member.user_id
        ? { ...r, max: capacity.max_open_conversations, open: capacity.open_conversations }
        : r)));
      toast.success(t('saved'));
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
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
            value={settings.auto_assign_mode}
            onValueChange={(value) => void changeMode(value as AutoAssignMode)}
            disabled={!canEdit || saving}
            aria-label={t('title')}
          >
            {AUTO_ASSIGN_MODES.map((mode) => (
              <Label key={mode} className={cn(SETTINGS_ROW_HAIRLINE, 'flex min-h-11 cursor-pointer items-center gap-3 px-4 py-3 text-sm font-normal has-disabled:cursor-default')}>
                <span className="min-w-0 flex-1">{t(mode)}</span>
                <RadioGroupItem value={mode} />
              </Label>
            ))}
          </RadioGroup>
        )}
      </SettingsGroup>
      {settings && canEdit && rows.length > 0 && (
        <SettingsGroup title={t('capacity')} footer={t('capacityHelp')}>
          {rows.map((row) => {
            const id = `capacity-${row.member.user_id}`;
            const changed = row.draft.trim() !== (row.max === null ? '' : String(row.max));
            return (
              <SettingsRow
                key={row.member.user_id}
                htmlFor={id}
                label={<span className="block truncate">{row.member.full_name || row.member.email || row.member.user_id}</span>}
                hint={t('openNow', { count: row.open })}
              >
                <div className="flex items-center gap-2 sm:justify-end">
                  <Input
                    id={id}
                    inputMode="numeric"
                    className="h-11 w-full sm:h-8 sm:w-24"
                    placeholder={t('noLimit')}
                    value={row.draft}
                    disabled={saving}
                    onChange={(event) => {
                      const draft = event.target.value;
                      setRows((prev) => prev.map((r) => (r.member.user_id === row.member.user_id ? { ...r, draft } : r)));
                    }}
                  />
                  <Button size="sm" variant="outline" className="min-h-11 shrink-0 sm:min-h-8" disabled={saving || !changed} onClick={() => void saveCapacity(row)}>
                    {t('save')}
                  </Button>
                </div>
              </SettingsRow>
            );
          })}
        </SettingsGroup>
      )}
    </div>
  );
}
