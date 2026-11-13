'use client';

// The workspace's custom contact fields as a table: name, type (text, number,
// date or choice), the choices, and how many contacts have a value. Admins
// create, rename, change a choice field's choices and delete; the type is
// fixed once a field exists. Shown on Contacts > Custom fields and in
// Settings. Writes go through /api/custom-fields (src/lib/contacts/custom-fields.ts).
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { FileText, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { authFetch } from '@/lib/auth/client';
import { CUSTOM_FIELD_TYPES, MAX_FIELD_NAME, checkChoices, parseChoices, type CustomFieldType } from '@/lib/contacts/custom-field-types';
import { useCan } from '@/hooks/use-can';
import { cn } from '@/lib/utils';
import { useCustomFields, type CustomFieldSummary } from './contacts-client';
import { FIELD_SELECT } from './custom-field-input';

const ROW = 'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-2.5 @xl:grid-cols-[minmax(0,1.3fr)_100px_minmax(0,1.6fr)_120px_76px] @xl:gap-x-4';

export function CustomFieldsTab({ createOpen, onCreateOpenChange, onCount }: {
  /** The new-field dialog, opened by the page header's button; without these the tab shows its own button. */
  createOpen?: boolean;
  onCreateOpenChange?: (open: boolean) => void;
  onCount?: (count: number) => void;
}) {
  const t = useTranslations('Contacts.redesign');
  const canEdit = useCan('edit-settings');
  const { fields, loading, reload } = useCustomFields();
  const [editing, setEditing] = useState<{ field: CustomFieldSummary | null } | null>(null);
  const [deleting, setDeleting] = useState<CustomFieldSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const controlled = onCreateOpenChange !== undefined;
  const dialog = editing ?? (createOpen ? { field: null } : null);
  const setDialog = (next: { field: CustomFieldSummary | null } | null) => {
    if (!next) {
      setEditing(null);
      onCreateOpenChange?.(false);
    } else if (next.field === null && controlled) onCreateOpenChange(true);
    else setEditing(next);
  };

  useEffect(() => {
    if (!loading) onCount?.(fields.length);
  }, [loading, fields.length, onCount]);

  const typeName = (type: CustomFieldType) => t(`fieldsTab.types.${type}`);

  async function remove() {
    if (!deleting) return;
    setBusy(true);
    const res = await authFetch(`/api/custom-fields/${deleting.id}`, { method: 'DELETE' }).catch(() => null);
    const payload = (await res?.json().catch(() => null)) as { error?: string; segments?: string[] } | null;
    setBusy(false);
    if (res?.status === 409 && payload?.segments) {
      toast.error(t('fieldsTab.segmentNeedsField', { names: payload.segments.join(', ') }));
      return;
    }
    if (!res?.ok) {
      toast.error(t('fieldsTab.deleteFailed'));
      return;
    }
    toast.success(t('fieldsTab.deleted', { name: deleting.field_name }));
    setDeleting(null);
    await reload();
  }

  return (
    <div className="space-y-4">
      {!controlled && canEdit && (
        <div className="flex justify-end">
          <Button onClick={() => setDialog({ field: null })}>
            <Plus className="size-4" />
            {t('fieldsTab.newField')}
          </Button>
        </div>
      )}
      {loading ? (
        <div className="flex justify-center py-16"><Loader2 className="size-5 animate-spin text-muted-foreground" aria-label={t('loading')} /></div>
      ) : fields.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-border bg-card px-6 py-16 text-center">
          <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground"><FileText className="size-5" /></span>
          <h2 className="text-base font-semibold text-foreground">{t('fieldsTab.emptyTitle')}</h2>
          <p className="max-w-sm text-sm text-muted-foreground">{t('fieldsTab.emptyText')}</p>
          {canEdit && (
            <Button variant="outline" onClick={() => setDialog({ field: null })}>
              <Plus className="size-4" />
              {t('fieldsTab.newField')}
            </Button>
          )}
        </div>
      ) : (
        <>
          <p className="text-[13px] text-muted-foreground">{t('fieldsTab.hint')}</p>
          <div role="table" aria-label={t('tabs.fields')} className="@container overflow-hidden rounded-2xl border border-border bg-card text-[13px] shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
            <div role="row" className={cn(ROW, 'hidden bg-muted/50 text-xs font-semibold text-muted-foreground @xl:grid')}>
              <span role="columnheader">{t('fieldsTab.name')}</span>
              <span role="columnheader">{t('fieldsTab.type')}</span>
              <span role="columnheader">{t('fieldsTab.choices')}</span>
              <span role="columnheader">{t('fieldsTab.filled')}</span>
              <span role="columnheader"><span className="sr-only">{t('columns.actions')}</span></span>
            </div>
            {fields.map((f) => (
              <div role="row" key={f.id} className={cn(ROW, 'border-t border-border hover:bg-muted/30 @max-xl:[&:nth-child(2)]:border-t-0')}>
                <span role="cell" className="min-w-0 truncate font-semibold text-foreground">{f.field_name}</span>
                <span role="cell" className="@xl:order-none">
                  <span className="inline-flex rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{typeName(f.field_type)}</span>
                </span>
                <span role="cell" className="col-span-2 min-w-0 truncate text-muted-foreground @xl:col-span-1" title={f.choices.join(', ')}>
                  {f.field_type === 'choice' ? f.choices.join(', ') : t('fieldsTab.anyValue', { type: typeName(f.field_type).toLowerCase() })}
                </span>
                <span role="cell" className="text-muted-foreground tabular-nums">
                  {t('fieldsTab.contacts', { count: f.filled })}
                </span>
                <span role="cell" className="flex justify-end gap-0.5">
                  {canEdit && (
                    <>
                      <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={t('fieldsTab.editField', { name: f.field_name })} onClick={() => setDialog({ field: f })}>
                        <Pencil className="size-4" />
                      </Button>
                      <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" aria-label={t('fieldsTab.deleteField', { name: f.field_name })} onClick={() => setDeleting(f)}>
                        <Trash2 className="size-4" />
                      </Button>
                    </>
                  )}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {dialog && (
        <FieldDialog
          field={dialog.field}
          onClose={() => setDialog(null)}
          onSaved={async () => {
            setDialog(null);
            await reload();
          }}
        />
      )}

      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('fieldsTab.deleteTitle', { name: deleting?.field_name ?? '' })}</DialogTitle>
            <DialogDescription>
              {[
                deleting?.filled ? t('fieldsTab.deleteLosesValues', { count: deleting.filled }) : '',
                deleting?.segments ? t('fieldsTab.deleteSegments', { count: deleting.segments }) : '',
                t('fieldsTab.cannotUndo'),
              ].filter(Boolean).join(' ')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-popover border-border">
            <Button variant="outline" onClick={() => setDeleting(null)}>{t('cancel')}</Button>
            <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              {t('fieldsTab.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const SERVER_ERRORS = ['name_required', 'name_too_long', 'name_taken', 'name_reserved', 'invalid_type', 'too_few', 'too_many', 'too_long'] as const;

function FieldDialog({ field, onClose, onSaved }: { field: CustomFieldSummary | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const t = useTranslations('Contacts.redesign');
  const [name, setName] = useState(field?.field_name ?? '');
  const [type, setType] = useState<CustomFieldType>(field?.field_type ?? 'text');
  const [choices, setChoices] = useState(field?.choices.join('\n') ?? '');
  const [errors, setErrors] = useState<{ name?: string; choices?: string }>({});
  const [saving, setSaving] = useState(false);
  /** Saved segments that filter on a removed choice: shown before the change is saved, which then needs a confirm. */
  const [affected, setAffected] = useState<{ choices: string; segments: string[] } | null>(null);
  const confirming = affected !== null && affected.choices === choices;

  async function save() {
    const list = parseChoices(choices);
    const problem = type === 'choice' ? checkChoices(list) : null;
    const next = {
      name: name.trim() ? undefined : t('fieldsTab.errors.name_required'),
      choices: problem ? t(`fieldsTab.errors.${problem}`) : undefined,
    };
    setErrors(next);
    if (next.name || next.choices) return;
    setSaving(true);
    const res = await authFetch(field ? `/api/custom-fields/${field.id}` : '/api/custom-fields', {
      method: field ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(field
        ? { name: name.trim(), ...(field.field_type === 'choice' ? { choices: list, ...(confirming ? { confirm: true } : {}) } : {}) }
        : { name: name.trim(), type, ...(type === 'choice' ? { choices: list } : {}) }),
    }).catch(() => null);
    const payload = (await res?.json().catch(() => null)) as { error?: string; segments?: string[] } | null;
    setSaving(false);
    if (res?.status === 409 && payload?.error === 'choice_in_segment' && payload.segments) {
      setAffected({ choices, segments: payload.segments });
      return;
    }
    if (res?.status === 409 && payload?.error === 'segment_needs_field' && payload.segments) {
      setErrors({ choices: t('fieldsTab.choiceSegmentNeedsField', { names: payload.segments.join(', ') }) });
      return;
    }
    if (!res?.ok) {
      const code = (SERVER_ERRORS as readonly string[]).includes(payload?.error ?? '') ? payload!.error! : null;
      if (code && ['too_few', 'too_many', 'too_long'].includes(code)) setErrors({ choices: t(`fieldsTab.errors.${code}`) });
      else if (code) setErrors({ name: t(`fieldsTab.errors.${code}`) });
      else toast.error(t('fieldsTab.saveFailed'));
      return;
    }
    toast.success(field ? t('fieldsTab.saved') : t('fieldsTab.created', { name: name.trim() }));
    await onSaved();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto bg-popover border-border text-popover-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{field ? t('fieldsTab.editTitle') : t('fieldsTab.newTitle')}</DialogTitle>
          <DialogDescription>{t('fieldsTab.dialogDesc')}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="field-name">{t('fieldsTab.name')}</Label>
            <Input id="field-name" value={name} maxLength={MAX_FIELD_NAME} placeholder={t('fieldsTab.namePlaceholder')}
              aria-invalid={!!errors.name} aria-describedby={errors.name ? 'field-name-error' : undefined}
              onChange={(e) => setName(e.target.value)} />
            {errors.name && <p id="field-name-error" className="text-xs font-medium text-destructive">{errors.name}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="field-type">{t('fieldsTab.type')}</Label>
            <select id="field-type" value={type} disabled={!!field} onChange={(e) => setType(e.target.value as CustomFieldType)} className={FIELD_SELECT}>
              {CUSTOM_FIELD_TYPES.map((value) => (
                <option key={value} value={value}>{t(`fieldsTab.types.${value}`)}</option>
              ))}
            </select>
            {field && <p className="text-xs text-muted-foreground">{t('fieldsTab.typeFixed')}</p>}
          </div>
          {type === 'choice' && (
            <div className="space-y-1.5">
              <Label htmlFor="field-choices">{t('fieldsTab.choices')}</Label>
              <Textarea id="field-choices" rows={4} value={choices} placeholder={t('fieldsTab.choicesPlaceholder')}
                aria-invalid={!!errors.choices} aria-describedby="field-choices-hint"
                onChange={(e) => setChoices(e.target.value)} />
              <p id="field-choices-hint" className={cn('text-xs', errors.choices ? 'font-medium text-destructive' : 'text-muted-foreground')}>
                {errors.choices ?? (field ? t('fieldsTab.choicesEditHint') : t('fieldsTab.choicesHint'))}
              </p>
              {confirming && affected && (
                <p role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-foreground">
                  {t('fieldsTab.choiceInSegment', { names: affected.segments.join(', ') })}
                </p>
              )}
            </div>
          )}
          <DialogFooter className="bg-popover border-border">
            <Button type="button" variant="outline" onClick={onClose}>{t('cancel')}</Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              {confirming ? t('fieldsTab.saveAndUpdateSegments') : field ? t('fieldsTab.save') : t('fieldsTab.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
