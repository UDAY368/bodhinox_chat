'use client';

/**
 * The checkout extras the shop offers (order note, gift message, delivery date and time slot, the shop's own fields). The values
 * are held by the storefront and sent to the server with the order (and when the buyer taps Save); the server checks them
 * again against the shop's settings. They never change the price.
 */
import { useTranslations } from 'next-intl';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { ExtrasValues, StorefrontView } from './api';

export function CheckoutExtrasForm({ extras, draft, onChange, disabled, digitalOnly = false }: {
  extras: NonNullable<StorefrontView['extras']>;
  draft: ExtrasValues;
  onChange: (next: ExtrasValues) => void;
  disabled: boolean;
  /** A cart of only downloads has nothing to deliver on a date. */
  digitalOnly?: boolean;
}) {
  const t = useTranslations('Storefront.extras');
  const set = (patch: ExtrasValues) => onChange({ ...draft, ...patch });
  const setAnswer = (id: string, value: string | boolean) => set({ custom: { ...(draft.custom ?? {}), [id]: value } });
  return (
    <Card>
      <CardHeader><CardTitle className="text-lg">{t('heading')}</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {extras.deliveryDate && !digitalOnly && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="extras-date">{t('deliveryDate')}</Label>
              <Input id="extras-date" type="date" min={extras.minDate} max={extras.maxDate} required disabled={disabled}
                value={draft.delivery_date ?? ''} onChange={(e) => set({ delivery_date: e.target.value || null })} />
            </div>
            {extras.slots.length > 0 && (
              <div className="space-y-1">
                <Label htmlFor="extras-slot">{t('deliverySlot')}</Label>
                <select id="extras-slot" required disabled={disabled} className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                  value={draft.slot_id ?? ''} onChange={(e) => set({ slot_id: e.target.value || null })}>
                  <option value="">{t('pickSlot')}</option>
                  {extras.slots.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
              </div>
            )}
          </div>
        )}
        {extras.note && (
          <div className="space-y-1">
            <Label htmlFor="extras-note">{t('note')}</Label>
            <Textarea id="extras-note" maxLength={300} rows={2} disabled={disabled} value={draft.note ?? ''}
              onChange={(e) => set({ note: e.target.value })} />
          </div>
        )}
        {extras.giftMessage && (
          <div className="space-y-1">
            <Label htmlFor="extras-gift">{t('giftMessage')}</Label>
            <Textarea id="extras-gift" maxLength={200} rows={2} disabled={disabled} value={draft.gift_message ?? ''}
              onChange={(e) => set({ gift_message: e.target.value })} />
          </div>
        )}
        {extras.fields.map((f) => {
          const id = `extras-${f.id}`;
          const value = draft.custom?.[f.id];
          const label = f.required ? `${f.label} *` : f.label;
          if (f.type === 'checkbox') {
            return (
              <div key={f.id} className="flex items-start gap-2">
                <Checkbox id={id} checked={value === true} disabled={disabled} onCheckedChange={(v) => setAnswer(f.id, v === true)} />
                <Label htmlFor={id} className="text-sm font-normal leading-snug">{label}</Label>
              </div>
            );
          }
          return (
            <div key={f.id} className="space-y-1">
              <Label htmlFor={id}>{label}</Label>
              {f.type === 'select' ? (
                <select id={id} disabled={disabled} required={f.required} className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                  value={typeof value === 'string' ? value : ''} onChange={(e) => setAnswer(f.id, e.target.value)}>
                  <option value="">{t('chooseOption')}</option>
                  {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : (
                <Input id={id} maxLength={200} disabled={disabled} required={f.required} value={typeof value === 'string' ? value : ''}
                  onChange={(e) => setAnswer(f.id, e.target.value)} />
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

/** Drop empty values so the draft compares equal to what the server stored. */
export function normaliseDraft(draft: ExtrasValues): ExtrasValues {
  const out: ExtrasValues = {};
  const text = (v: string | null | undefined) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  if (text(draft.note)) out.note = text(draft.note);
  if (text(draft.gift_message)) out.gift_message = text(draft.gift_message);
  if (text(draft.delivery_date)) out.delivery_date = text(draft.delivery_date);
  if (text(draft.slot_id)) out.slot_id = text(draft.slot_id);
  const custom = Object.fromEntries(Object.entries(draft.custom ?? {}).filter(([, v]) => v === true || (typeof v === 'string' && v.trim())));
  if (Object.keys(custom).length) out.custom = custom as Record<string, string | boolean>;
  return out;
}
