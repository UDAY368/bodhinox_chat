'use client';

// ============================================================
// SegmentBuilderDialog — create or edit a saved segment: a name and
// a list of conditions that must all match (lib/audience/filter),
// with a live count of matching and marketable contacts.
// ============================================================

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authFetch } from '@/lib/auth/client';
import { previewSegment, type ListSummary, type SegmentSummary } from '@/lib/audience/client';
import type { AudienceCondition } from '@/lib/audience/filter';
import { CAMPAIGN_OUTCOMES } from '@/lib/audience/outcomes';
import type { CustomField, Tag } from '@/types';

type Field = AudienceCondition['field'];
const FIELDS: Field[] = ['tags', 'list', 'campaign', 'custom_field', 'name', 'phone', 'email', 'company', 'created_at', 'opted_out', 'blocked'];
const selectClass = 'h-8 rounded-md border border-border bg-muted px-2 text-sm text-foreground';

function blank(field: Field): AudienceCondition {
  switch (field) {
    case 'tags': return { field, op: 'has_any', tagIds: [] };
    case 'list': return { field, op: 'in_any', listIds: [] };
    case 'campaign': return { field, broadcastId: '', op: 'received' };
    case 'custom_field': return { field, fieldId: '', op: 'is', value: '' };
    case 'created_at': return { field, op: 'after', value: new Date().toISOString().slice(0, 10) };
    case 'opted_out':
    case 'blocked': return { field, op: 'is', value: false };
    default: return { field, op: 'contains', value: '' };
  }
}

function complete(c: AudienceCondition): boolean {
  if (c.field === 'tags') return c.tagIds.length > 0;
  if (c.field === 'list') return c.listIds.length > 0;
  if (c.field === 'campaign') return c.broadcastId !== '';
  if (c.field === 'custom_field' && !c.fieldId) return false;
  if ('value' in c && typeof c.value === 'string' && ['is', 'is_not', 'contains'].includes(c.op)) return c.value.trim().length > 0;
  return true;
}

export function SegmentBuilderDialog({
  open,
  onOpenChange,
  segment,
  tags,
  lists,
  campaigns,
  customFields,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Edit this segment, or create a new one when null. */
  segment: SegmentSummary | null;
  tags: Tag[];
  lists: ListSummary[];
  /** Earlier campaigns for retargeting conditions. */
  campaigns: { id: string; name: string }[];
  customFields: CustomField[];
  onSaved: (segment: SegmentSummary) => void;
}) {
  const t = useTranslations('Contacts.segments');
  const [name, setName] = useState('');
  const [conditions, setConditions] = useState<AudienceCondition[]>([]);
  const [count, setCount] = useState<{ total: number; sendable: number } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(segment?.name ?? '');
    setConditions(segment?.filter.conditions ?? [blank('tags')]);
    setCount(null);
  }, [open, segment]);

  const ready = conditions.length > 0 && conditions.every(complete);
  const filterKey = useMemo(() => JSON.stringify(conditions), [conditions]);

  // Live count, debounced so typing does not fire a request per key.
  useEffect(() => {
    if (!open || !ready) return setCount(null);
    const timer = setTimeout(() => {
      previewSegment({ filter: { conditions } }).then(setCount).catch(() => setCount(null));
    }, 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ready, filterKey]);

  function update(index: number, next: AudienceCondition) {
    setConditions((prev) => prev.map((c, i) => (i === index ? next : c)));
  }

  async function save() {
    setSaving(true);
    try {
      const res = await authFetch(segment ? `/api/segments/${segment.id}` : '/api/segments', {
        method: segment ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), filter: { conditions } }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || t('saveFailed'));
        return;
      }
      toast.success(t('saved'));
      onSaved(payload.segment as SegmentSummary);
      onOpenChange(false);
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{segment ? t('editTitle') : t('newTitle')}</DialogTitle>
          <DialogDescription className="text-muted-foreground">{t('builderDesc')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="segment-name" className="text-muted-foreground">{t('nameLabel')}</Label>
            <Input id="segment-name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} placeholder={t('namePlaceholder')} />
          </div>

          <div className="space-y-2">
            <Label className="text-muted-foreground">{t('conditionsLabel')}</Label>
            {conditions.map((c, index) => (
              <div key={index} className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2" data-testid="segment-condition">
                <select
                  aria-label={t('fieldLabel')}
                  className={selectClass}
                  value={c.field}
                  onChange={(e) => update(index, blank(e.target.value as Field))}
                >
                  {FIELDS.map((f) => <option key={f} value={f}>{t(`fields.${f}`)}</option>)}
                </select>

                {c.field === 'tags' && (
                  <>
                    <select aria-label={t('operatorLabel')} className={selectClass} value={c.op}
                      onChange={(e) => update(index, { ...c, op: e.target.value as 'has_any' | 'has_none' })}>
                      <option value="has_any">{t('ops.has_any')}</option>
                      <option value="has_none">{t('ops.has_none')}</option>
                    </select>
                    <div className="flex flex-wrap gap-1">
                      {tags.map((tag) => {
                        const on = c.tagIds.includes(tag.id);
                        return (
                          <button key={tag.id} type="button" aria-pressed={on}
                            onClick={() => update(index, { ...c, tagIds: on ? c.tagIds.filter((id) => id !== tag.id) : [...c.tagIds, tag.id] })}
                            className={`rounded-full border px-2 py-0.5 text-xs ${on ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground'}`}>
                            {tag.name}
                          </button>
                        );
                      })}
                      {tags.length === 0 && <span className="text-xs text-muted-foreground">{t('noTags')}</span>}
                    </div>
                  </>
                )}

                {c.field === 'list' && (
                  <>
                    <select aria-label={t('operatorLabel')} className={selectClass} value={c.op}
                      onChange={(e) => update(index, { ...c, op: e.target.value as 'in_any' | 'in_none' })}>
                      <option value="in_any">{t('ops.in_any')}</option>
                      <option value="in_none">{t('ops.in_none')}</option>
                    </select>
                    <div className="flex flex-wrap gap-1">
                      {lists.map((list) => {
                        const on = c.listIds.includes(list.id);
                        return (
                          <button key={list.id} type="button" aria-pressed={on}
                            onClick={() => update(index, { ...c, listIds: on ? c.listIds.filter((id) => id !== list.id) : [...c.listIds, list.id] })}
                            className={`rounded-full border px-2 py-0.5 text-xs ${on ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground'}`}>
                            {list.name}
                          </button>
                        );
                      })}
                      {lists.length === 0 && <span className="text-xs text-muted-foreground">{t('noLists')}</span>}
                    </div>
                  </>
                )}

                {c.field === 'campaign' && (
                  <>
                    <select aria-label={t('campaignLabel')} className={selectClass} value={c.broadcastId}
                      onChange={(e) => update(index, { ...c, broadcastId: e.target.value })}>
                      <option value="">{t('chooseCampaign')}</option>
                      {campaigns.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                      {/* A saved condition may name a campaign older than the recent list. */}
                      {c.broadcastId && !campaigns.some((b) => b.id === c.broadcastId) && (
                        <option value={c.broadcastId}>{t('olderCampaign')}</option>
                      )}
                    </select>
                    <select aria-label={t('operatorLabel')} className={selectClass} value={c.op}
                      onChange={(e) => update(index, { ...c, op: e.target.value as typeof c.op })}>
                      {CAMPAIGN_OUTCOMES.map((op) => <option key={op} value={op}>{t(`campaignOps.${op}`)}</option>)}
                    </select>
                  </>
                )}

                {c.field === 'custom_field' && (
                  <>
                    <select aria-label={t('customFieldLabel')} className={selectClass} value={c.fieldId}
                      onChange={(e) => update(index, { ...c, fieldId: e.target.value })}>
                      <option value="">{t('chooseField')}</option>
                      {customFields.map((f) => <option key={f.id} value={f.id}>{f.field_name}</option>)}
                    </select>
                    <select aria-label={t('operatorLabel')} className={selectClass} value={c.op}
                      onChange={(e) => update(index, { ...c, op: e.target.value as typeof c.op })}>
                      {(['is', 'is_not', 'contains', 'is_empty', 'is_not_empty'] as const).map((op) => <option key={op} value={op}>{t(`ops.${op}`)}</option>)}
                    </select>
                    {['is', 'is_not', 'contains'].includes(c.op) && (
                      <Input aria-label={t('valueLabel')} className="h-8 w-40" value={c.value ?? ''} onChange={(e) => update(index, { ...c, value: e.target.value })} />
                    )}
                  </>
                )}

                {(c.field === 'name' || c.field === 'phone' || c.field === 'email' || c.field === 'company') && (
                  <>
                    <select aria-label={t('operatorLabel')} className={selectClass} value={c.op}
                      onChange={(e) => update(index, { ...c, op: e.target.value as typeof c.op })}>
                      {(['contains', 'is_empty', 'is_not_empty'] as const).map((op) => <option key={op} value={op}>{t(`ops.${op}`)}</option>)}
                    </select>
                    {c.op === 'contains' && (
                      <Input aria-label={t('valueLabel')} className="h-8 w-40" value={c.value ?? ''} onChange={(e) => update(index, { ...c, value: e.target.value })} />
                    )}
                  </>
                )}

                {c.field === 'created_at' && (
                  <>
                    <select aria-label={t('operatorLabel')} className={selectClass} value={c.op}
                      onChange={(e) => update(index, { ...c, op: e.target.value as 'before' | 'after' })}>
                      <option value="after">{t('ops.after')}</option>
                      <option value="before">{t('ops.before')}</option>
                    </select>
                    <Input aria-label={t('valueLabel')} type="date" className="h-8 w-40" value={c.value}
                      onChange={(e) => update(index, { ...c, value: e.target.value })} />
                  </>
                )}

                {(c.field === 'opted_out' || c.field === 'blocked') && (
                  <select aria-label={t('valueLabel')} className={selectClass} value={String(c.value)}
                    onChange={(e) => update(index, { ...c, value: e.target.value === 'true' })}>
                    <option value="true">{t('yes')}</option>
                    <option value="false">{t('no')}</option>
                  </select>
                )}

                <Button type="button" variant="ghost" size="sm" className="ml-auto" aria-label={t('removeCondition')}
                  disabled={conditions.length === 1}
                  onClick={() => setConditions((prev) => prev.filter((_, i) => i !== index))}>
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" disabled={conditions.length >= 20}
              onClick={() => setConditions((prev) => [...prev, blank('name')])}>
              <Plus className="size-4" />
              {t('addCondition')}
            </Button>
            <p className="text-xs text-muted-foreground">{t('allMustMatch')}</p>
          </div>

          <p className="text-sm text-foreground" data-testid="segment-count" aria-live="polite">
            {count ? t('matchCount', { total: count.total, sendable: count.sendable }) : ready ? t('counting') : t('incomplete')}
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} className="border-border text-muted-foreground hover:bg-muted">
            {t('cancel')}
          </Button>
          <Button onClick={save} disabled={saving || !ready || !name.trim()}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            {t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
