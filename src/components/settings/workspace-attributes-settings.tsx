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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { authFetch } from '@/lib/auth/client';
import type { WorkspaceAttribute } from '@/lib/workspace/attributes';
import { planAllows, usePlan } from '@/lib/billing/client';
import { UpgradeBadge } from '@/components/ui/upgrade-badge';

export function WorkspaceAttributesSettings() {
  const t = useTranslations('Settings.workspaceAttributes');
  const [attributes, setAttributes] = useState<WorkspaceAttribute[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [secret, setSecret] = useState(false);
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
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <Braces className="size-4 text-primary" />
          {t('title')}
          {!allowed && <UpgradeBadge />}
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          {t('description', { example: '{{workspace.support_email}}' })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <Loader2 className="size-5 animate-spin text-primary" />
        ) : attributes.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {attributes.map((a) => (
              <li key={a.key} className="flex items-center gap-3 px-3 py-2 text-sm">
                <code className="shrink-0 font-mono text-xs text-foreground">{`{{workspace.${a.key}}}`}</code>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {a.is_secret ? (
                    <span className="inline-flex items-center gap-1"><Lock className="size-3" />{t('hidden')}</span>
                  ) : a.value}
                </span>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => remove(a.key)} aria-label={t('deleteAria', { key: a.key })}>
                  <Trash2 className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Input aria-label={t('keyLabel')} placeholder={t('keyPlaceholder')} value={key} maxLength={40}
            onChange={(e) => setKey(e.target.value.toLowerCase())} className="w-44 font-mono" />
          <Input aria-label={t('valueLabel')} placeholder={t('valueLabel')} value={value} maxLength={1000}
            type={secret ? 'password' : 'text'} autoComplete="off" onChange={(e) => setValue(e.target.value)} className="min-w-[180px] flex-1" />
          <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Checkbox checked={secret} onCheckedChange={(checked) => setSecret(checked === true)} />
            {t('secretLabel')}
          </label>
          <Button variant="outline" size="sm" onClick={save} disabled={busy || !key.trim() || !value || !allowed}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            {t('save')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t('secretHint')}</p>
      </CardContent>
    </Card>
  );
}
