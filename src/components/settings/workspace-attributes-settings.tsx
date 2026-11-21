'use client';

// ============================================================
// Workspace attributes — Settings → Fields & tags (admin+).
// Account-wide values used as {{workspace.key}} in flow and
// automation text. Secret values are write-only: the server never
// returns them, and they only resolve in automation webhooks.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Braces, Loader2, Lock, Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { GroupedListRow } from '@/components/ui/grouped-list';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { authFetch } from '@/lib/auth/client';
import type { WorkspaceAttribute } from '@/lib/workspace/attributes';
import { planAllows, usePlan } from '@/lib/billing/client';
import { UpgradeBadge } from '@/components/ui/upgrade-badge';
import { SETTINGS_ROW_HAIRLINE, SettingsGroup } from './settings-row';

export function WorkspaceAttributesSettings() {
  const t = useTranslations('Settings.workspaceAttributes');
  const [attributes, setAttributes] = useState<WorkspaceAttribute[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [secret, setSecret] = useState(false);
  const [adding, setAdding] = useState(false);
  const allowed = planAllows(usePlan(), 'workspace_attributes');

  const load = useCallback(async () => {
    try {
      const res = await authFetch('/api/workspace-attributes', { cache: 'no-store' });
      if (!res.ok) throw new Error();
      setAttributes(((await res.json()) as { attributes: WorkspaceAttribute[] }).attributes);
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setBusy(true);
    try {
      const res = await authFetch('/api/workspace-attributes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: key.trim(), value, is_secret: secret }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || t('saveFailed'));
        return;
      }
      toast.success(t('saved'));
      setAdding(false);
      setKey('');
      setValue('');
      setSecret(false);
      await load();
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function remove(attributeKey: string) {
    setBusy(true);
    try {
      const res = await authFetch(`/api/workspace-attributes/${attributeKey}`, { method: 'DELETE' });
      if (!res.ok) throw new Error();
      toast.success(t('deleted'));
      setAttributes((prev) => prev.filter((a) => a.key !== attributeKey));
    } catch {
      toast.error(t('deleteFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsGroup title={<><Braces className="size-4 text-primary" />
          {t('title')}
          {!allowed && <UpgradeBadge />}</>} footer={t('description', { example: '{{workspace.support_email}}' })}>
      {loading ? (
        <div className={cn(SETTINGS_ROW_HAIRLINE, 'space-y-2 px-4 py-3')} aria-busy="true">
          <div className="h-5 w-2/3 animate-pulse rounded bg-muted" />
          <div className="h-5 w-1/2 animate-pulse rounded bg-muted" />
        </div>
      ) : attributes.length === 0 ? (
        <div className={cn(SETTINGS_ROW_HAIRLINE, 'flex min-h-11 items-center px-4 py-3 text-sm text-muted-foreground')}>{t('empty')}</div>
      ) : (
        <ul className="contents">{attributes.map((a) => (
          <li key={a.key} className={cn(SETTINGS_ROW_HAIRLINE, 'flex min-h-11 items-center gap-3 px-4 py-2 text-sm')}>
            <code className="shrink-0 font-mono text-xs text-foreground">{`{{workspace.${a.key}}}`}</code>
            <span className="min-w-0 flex-1 truncate text-right text-muted-foreground">
              {a.is_secret ? (
                <span className="inline-flex items-center gap-1"><Lock className="size-3" />{t('hidden')}</span>
              ) : a.value}
            </span>
            <Button variant="ghost" size="icon" className="size-11 shrink-0 text-destructive sm:size-9" disabled={busy} onClick={() => remove(a.key)} aria-label={t('deleteAria', { key: a.key })}>
              <Trash2 className="size-4" />
            </Button>
          </li>
        ))}</ul>
      )}
      {allowed && !loading && (
        <GroupedListRow
          leading={<Plus className="size-4 text-primary" aria-hidden />}
          title={<span className="text-primary">{t('add')}</span>}
          onClick={() => setAdding(true)}
        />
      )}
      <Sheet open={adding} onOpenChange={setAdding}>
        <SheetContent size="sm" className="w-full gap-4 overflow-y-auto p-4">
          <SheetHeader className="p-0 pr-8">
            <SheetTitle>{t('add')}</SheetTitle>
            <SheetDescription>{t('secretHint')}</SheetDescription>
          </SheetHeader>
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <div className="space-y-1.5">
              <Label htmlFor="workspace-attribute-key">{t('keyLabel')}</Label>
              <Input id="workspace-attribute-key" placeholder={t('keyPlaceholder')} value={key} maxLength={40}
                onChange={(e) => setKey(e.target.value.toLowerCase())} className="font-mono" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="workspace-attribute-value">{t('valueLabel')}</Label>
              <Input id="workspace-attribute-value" value={value} maxLength={1000}
                type={secret ? 'password' : 'text'} autoComplete="off" onChange={(e) => setValue(e.target.value)} />
            </div>
            <label className="flex min-h-11 items-center justify-between gap-3 text-sm font-medium">
              {t('secretLabel')}
              <Switch checked={secret} onCheckedChange={(checked) => setSecret(checked === true)} />
            </label>
            <Button type="submit" className="min-h-11 w-full" disabled={busy || !key.trim() || !value || !allowed}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              {t('save')}
            </Button>
          </form>
        </SheetContent>
      </Sheet>
    </SettingsGroup>
  );
}
