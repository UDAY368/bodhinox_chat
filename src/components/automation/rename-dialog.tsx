'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import type { AutomationItem } from './automation-items';

/** "Rename automation" from a row's menu: one name box; Enter saves, an empty name is refused. */
export function RenameDialog({ item, onCancel, onSave }: {
  item: AutomationItem | null;
  onCancel: () => void;
  /** Resolves when the save finished (the dialog stays open on failure). */
  onSave: (item: AutomationItem, name: string) => Promise<void>;
}) {
  return (
    <Dialog open={!!item} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent className="bg-popover text-popover-foreground sm:max-w-sm">
        {item && <RenameForm key={item.key} item={item} onCancel={onCancel} onSave={onSave} />}
      </DialogContent>
    </Dialog>
  );
}

function RenameForm({ item, onCancel, onSave }: {
  item: AutomationItem;
  onCancel: () => void;
  onSave: (item: AutomationItem, name: string) => Promise<void>;
}) {
  const t = useTranslations('AutomationList.rename');
  const [name, setName] = useState(item.name);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  return (
    <form
      className="space-y-4"
      onSubmit={async (event) => {
        event.preventDefault();
        const trimmed = name.trim();
        if (!trimmed) { setError(true); return; }
        if (trimmed === item.name) { onCancel(); return; }
        setSaving(true);
        try {
          await onSave(item, trimmed);
        } finally {
          setSaving(false);
        }
      }}
    >
      <DialogHeader>
        <DialogTitle>{t('title')}</DialogTitle>
      </DialogHeader>
      <div className="space-y-1.5">
        <label htmlFor="automation-rename" className="text-[13px] font-semibold text-foreground">{t('name')}</label>
        <Input id="automation-rename" value={name} maxLength={100} autoFocus onFocus={(e) => e.currentTarget.select()}
          aria-invalid={error || undefined} aria-describedby={error ? 'automation-rename-error' : undefined}
          onChange={(e) => { setName(e.target.value); setError(false); }} />
        {error && <p id="automation-rename-error" className="text-xs text-destructive">{t('required')}</p>}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>{t('cancel')}</Button>
        <Button type="submit" disabled={saving}>
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          {t('save')}
        </Button>
      </DialogFooter>
    </form>
  );
}
