'use client';

// Settings → WhatsApp: the workspace's connected numbers with their label,
// Meta ids, quality and limit, the default badge and admin actions (make
// default, rename, disconnect). Changes go through /api/whatsapp/numbers/[id];
// nothing here ever sees a token. A disconnected number stays listed (its
// conversations, campaigns and flows keep it) until the same Phone Number ID
// is connected again.

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Check, Loader2, Pencil, Plus, Star, Trash2, X } from 'lucide-react';
import { authFetch } from '@/lib/auth/client';
import { cn } from '@/lib/utils';
import { ACCOUNT_ISSUE_EVENTS } from '@/lib/whatsapp/account-issue';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { SETTINGS_ROW_HAIRLINE, SettingsBlock, SettingsGroup, SettingsMoreMenu } from '../settings-row';
import { numberLabel, type WhatsAppNumberDto } from './use-whatsapp-numbers';

const QUALITY_CLASSES: Record<string, string> = {
  GREEN: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20 dark:text-emerald-400',
  YELLOW: 'bg-amber-500/10 text-amber-600 border-amber-500/20 dark:text-amber-400',
  RED: 'bg-red-500/10 text-red-600 border-red-500/20 dark:text-red-400',
  UNKNOWN: 'bg-muted text-muted-foreground border-border',
};

interface NumbersListProps {
  numbers: WhatsAppNumberDto[];
  selectedId: string | null;
  adding: boolean;
  canEdit: boolean;
  onSelect: (id: string) => void;
  onAdd: () => void;
  /** After a change: reload the list (and the form when the selected number went away). */
  onChanged: (change: { removedId?: string }) => Promise<void> | void;
}

export function NumbersList({ numbers, selectedId, adding, canEdit, onSelect, onAdd, onChanged }: NumbersListProps) {
  const t = useTranslations('whatsappNumbers');
  const confirm = useConfirm();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');

  const tierLabel = (tier: string | null) => {
    if (!tier) return t('settings.unknown');
    const limit = tier.replace(/^TIER_/, '');
    return limit === 'UNLIMITED' ? t('settings.tierUnlimited') : t('settings.tierPerDay', { limit });
  };
  const qualityKey = (q: string | null) => (q && q in QUALITY_CLASSES ? q : 'UNKNOWN');

  async function change(n: WhatsAppNumberDto, init: RequestInit): Promise<Record<string, unknown> | null> {
    setBusyId(n.id);
    try {
      const res = await authFetch(`/api/whatsapp/numbers/${encodeURIComponent(n.id)}`, init);
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        toast.error(typeof body.error === 'string' ? body.error : t('settings.actionFailed'));
        return null;
      }
      return body;
    } catch {
      toast.error(t('settings.actionFailed'));
      return null;
    } finally {
      setBusyId(null);
    }
  }

  const patch = (n: WhatsAppNumberDto, body: Record<string, unknown>) =>
    change(n, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  async function makeDefault(n: WhatsAppNumberDto) {
    if (await patch(n, { is_default: true })) {
      toast.success(t('settings.defaultChanged', { name: numberLabel(n, t) }));
      await onChanged({});
    }
  }

  async function saveName(n: WhatsAppNumberDto) {
    if (await patch(n, { display_name: draftName.trim() || null })) {
      toast.success(t('settings.renamed'));
      setRenamingId(null);
      await onChanged({});
    }
  }

  async function disconnect(n: WhatsAppNumberDto) {
    if (!(await confirm({ title: t('settings.disconnectConfirmHold', { name: numberLabel(n, t), isDefault: String(n.is_default) }), confirmLabel: t('settings.disconnect'), destructive: true }))) return;
    const body = await change(n, { method: 'DELETE' });
    if (!body) return;
    // The server says what happened: new default, flows drafted, campaigns held.
    if (typeof body.message === 'string' && body.message) {
      toast.success(body.message, { duration: 10_000 });
    } else {
      const paused = typeof body.paused_flows === 'number' ? body.paused_flows : 0;
      toast.success(paused > 0 ? t('settings.disconnectedPaused', { count: paused }) : t('settings.disconnected'));
    }
    await onChanged({ removedId: n.id });
  }

  return (
    <SettingsGroup
      title={t('settings.title')}
      footer={t('settings.description')}
      action={canEdit ? (
        <Button variant={adding ? 'secondary' : 'ghost'} size="sm" onClick={onAdd} disabled={adding}>
          <Plus className="size-4" />
          {t('settings.addManually')}
        </Button>
      ) : undefined}
    >
        {numbers.length === 0 && <SettingsBlock><p className="text-muted-foreground text-sm">{t('settings.empty')}</p></SettingsBlock>}
        {numbers.map((n) => {
          const selected = !adding && n.id === selectedId;
          const busy = busyId === n.id;
          const quality = qualityKey(n.quality_rating);
          return (
            <div
              key={n.id}
              data-testid="whatsapp-number-row"
              className={cn(
                SETTINGS_ROW_HAIRLINE,
                'flex min-h-11 flex-wrap items-center gap-3 px-4 py-3',
                selected && 'bg-primary/5'
              )}
            >
              <div className="min-w-0 flex-1 space-y-1">
                {renamingId === n.id ? (
                  <form
                    className="flex items-center gap-2"
                    onSubmit={(e) => { e.preventDefault(); void saveName(n); }}
                  >
                    <Input
                      autoFocus
                      value={draftName}
                      maxLength={200}
                      placeholder={t('settings.renamePlaceholder')}
                      aria-label={t('settings.rename')}
                      onChange={(e) => setDraftName(e.target.value)}
                      className="bg-muted h-8 text-sm"
                    />
                    <Button type="submit" size="icon" variant="ghost" className="size-8" disabled={busy} aria-label={t('settings.save')}>
                      {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
                    </Button>
                    <Button type="button" size="icon" variant="ghost" className="size-8" onClick={() => setRenamingId(null)} aria-label={t('settings.cancel')}>
                      <X className="size-4" />
                    </Button>
                  </form>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-foreground truncate text-sm font-medium">{numberLabel(n, t)}</span>
                    {n.is_default && (
                      <span className="bg-primary/10 text-primary border-primary/20 rounded-full border px-2 py-0.5 text-[10px] font-medium">
                        {t('defaultBadge')}
                      </span>
                    )}
                    <span
                      className={cn(
                        'rounded-full border px-2 py-0.5 text-[10px]',
                        n.status === 'connected'
                          ? 'border-emerald-500/20 text-emerald-600 dark:text-emerald-400'
                          : 'border-red-500/20 text-red-600 dark:text-red-400'
                      )}
                    >
                      {n.status === 'connected' ? t('settings.statusConnected') : t('settings.statusDisconnected')}
                    </span>
                  </div>
                )}
                {n.removed && <p className="text-muted-foreground text-xs">{t('settings.removedHint')}</p>}
                {n.account_issue && ACCOUNT_ISSUE_EVENTS.has(n.account_issue.event) && (
                  <p role="status" data-testid="whatsapp-number-meta-issue" className="text-xs text-red-600 dark:text-red-400">
                    {t(`settings.metaIssue.${n.account_issue.event}`)}
                    {n.account_issue.detail ? ` ${t('settings.metaIssue.detail', { detail: n.account_issue.detail })}` : ''}
                    {n.account_issue.until
                      ? ` ${t('settings.metaIssue.until', { date: new Date(n.account_issue.until).toLocaleString() })}`
                      : ''}
                  </p>
                )}
                <p className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 text-xs">
                  <span>{t('settings.phoneNumberIdLabel', { id: n.phone_number_id })}</span>
                  {n.waba_id && <span>{t('settings.wabaIdLabel', { id: n.waba_id })}</span>}
                  <span className="inline-flex items-center gap-1">
                    {t('settings.quality')}
                    <span className={cn('rounded-full border px-1.5 text-[10px]', QUALITY_CLASSES[quality])}>
                      {t(`settings.ratings.${quality}`)}
                    </span>
                  </span>
                  <span>
                    {t('settings.tier')} {tierLabel(n.messaging_limit_tier)}
                  </span>
                </p>
              </div>
              {/* Select is the row's one action; default, rename and disconnect sit in its more menu. */}
              <div className="flex items-center gap-1">
                {busy && <Loader2 className="text-muted-foreground size-4 animate-spin" />}
                <Button
                  variant={selected ? 'secondary' : 'ghost'}
                  size="sm"
                  onClick={() => onSelect(n.id)}
                  aria-pressed={selected}
                >
                  {selected ? t('settings.selected') : t('settings.select')}
                </Button>
                {canEdit && (
                  <SettingsMoreMenu
                    actions={[
                      { label: t('settings.makeDefault'), icon: Star, disabled: busy, hidden: n.is_default || n.removed, onSelect: () => void makeDefault(n) },
                      { label: t('settings.rename'), icon: Pencil, disabled: busy, hidden: renamingId === n.id,
                        onSelect: () => { setRenamingId(n.id); setDraftName(n.display_name ?? ''); } },
                      { label: t('settings.disconnect'), icon: Trash2, destructive: true, disabled: busy, hidden: n.removed, onSelect: () => void disconnect(n) },
                    ]}
                  />
                )}
              </div>
            </div>
          );
        })}
    </SettingsGroup>
  );
}
