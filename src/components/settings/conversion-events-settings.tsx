'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Archive, Loader2, Pencil, Plus, RotateCcw } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { authFetch } from '@/lib/auth/client';
import { SettingsPanelHead } from './settings-panel-head';

// Settings › Conversion events (Stage 5, 5F). Admins name the results a flow
// counts with an Actions step's "Log conversion" (a booked call, a sign-up),
// rename them, and archive or restore them; a type is never deleted, so the log
// keeps its name. Every member sees the list and each type's count over the
// last 30 days. The routes enforce the admin role, Origin + CSRF and tenancy
// (src/app/api/account/conversion-events).

interface EventType {
  id: string;
  name: string;
  archived: boolean;
  recent_count: number;
}

const NAME_MAX = 60;

async function errorText(res: Response, fallback: string): Promise<string> {
  const json = (await res.json().catch(() => null)) as { error?: string } | null;
  return json?.error ?? fallback;
}

export function ConversionEventsSettings({ canEdit }: { canEdit: boolean }) {
  const t = useTranslations('Settings.conversionEvents');
  const [types, setTypes] = useState<EventType[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await authFetch('/api/account/conversion-events', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      setTypes(((await res.json()) as { types?: EventType[] }).types ?? []);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const validName = (value: string) => value.trim().length >= 1 && value.trim().length <= NAME_MAX;

  async function add() {
    if (!validName(name)) return;
    setBusy('new');
    try {
      const res = await authFetch('/api/account/conversion-events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!res.ok) {
        toast.error(await errorText(res, t('nameInvalid')));
        return;
      }
      setName('');
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function patch(id: string, body: { name?: string; archived?: boolean }) {
    setBusy(id);
    try {
      const res = await authFetch(`/api/account/conversion-events/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        toast.error(await errorText(res, t('notFound')));
        return;
      }
      setEditing(null);
      await load();
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="max-w-2xl" data-testid="conversion-events-settings">
      <SettingsPanelHead title={t('title')} description={t('description')} />
      {!canEdit && <p className="mb-4 text-sm text-muted-foreground" role="note">{t('readOnly')}</p>}

      {canEdit && (
        <form
          className="mb-5 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <Input
            aria-label={t('name')}
            placeholder={t('namePlaceholder')}
            value={name}
            maxLength={NAME_MAX}
            onChange={(e) => setName(e.target.value)}
          />
          <Button type="submit" disabled={!validName(name) || busy === 'new'}>
            {busy === 'new' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            {t('add')}
          </Button>
        </form>
      )}

      {failed ? (
        <p className="text-sm text-destructive" role="alert">{t('loadFailed')}</p>
      ) : types === null ? (
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden />
      ) : types.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {types.map((type) => (
            <li key={type.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              {editing?.id === type.id ? (
                <form
                  className="flex flex-1 gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (validName(editing.name)) void patch(type.id, { name: editing.name.trim() });
                  }}
                >
                  <Input
                    aria-label={t('name')}
                    value={editing.name}
                    maxLength={NAME_MAX}
                    autoFocus
                    onChange={(e) => setEditing({ id: type.id, name: e.target.value })}
                  />
                  <Button type="submit" size="sm" disabled={!validName(editing.name) || busy === type.id}>{t('save')}</Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>{t('cancel')}</Button>
                </form>
              ) : (
                <>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{type.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {t('recent')}: {t('count', { count: type.recent_count })}
                    </p>
                  </div>
                  {type.archived && <Badge variant="outline" className="text-[10px]">{t('archived')}</Badge>}
                  {canEdit && (
                    <div className="flex gap-1">
                      {!type.archived && (
                        <Button size="sm" variant="ghost" onClick={() => setEditing({ id: type.id, name: type.name })}
                          aria-label={`${t('rename')}: ${type.name}`}>
                          <Pencil className="h-3.5 w-3.5" />
                          {t('rename')}
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" disabled={busy === type.id}
                        onClick={() => void patch(type.id, { archived: !type.archived })}
                        aria-label={`${type.archived ? t('restore') : t('archive')}: ${type.name}`}>
                        {type.archived ? <RotateCcw className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
                        {type.archived ? t('restore') : t('archive')}
                      </Button>
                    </div>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
