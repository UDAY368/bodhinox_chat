'use client';

/**
 * Settings → Plan: the platform's per-message rate card (Meta prices by
 * template category and destination country), used for campaign cost
 * estimates. Renders only for platform admins: GET /api/analytics/rate-card
 * says canEdit (PLATFORM_ADMIN_EMAILS); the PUT is checked again on the server.
 * Prices are in the currency's minor unit (paise, cents) and may be fractional.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { GroupedListRow } from '@/components/ui/grouped-list';
import { Label } from '@/components/ui/label';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { authFetch } from '@/lib/auth/client';
import type { RateCard, RateCategory } from '@/lib/analytics/rate-card';
import { SETTINGS_ROW_HAIRLINE, SettingsGroup, SettingsRow } from './settings-row';

const ENDPOINT = '/api/analytics/rate-card';
// lib/analytics/rate-card's RATE_CATEGORIES (that module is server-only).
const RATE_CATEGORIES: readonly RateCategory[] = ['marketing', 'utility', 'authentication', 'service'];
const key = (c: Pick<RateCard, 'category' | 'countryCode' | 'currency'>) => `${c.category}|${c.countryCode}|${c.currency}`;

/** Edits as the PUT body: changed or added prices, and null for removed rows. */
export function rateCardChanges(original: RateCard[], edited: Map<string, { card: RateCard; price: string | null }>) {
  const before = new Map(original.map((c) => [key(c), c.priceMinor]));
  const cards: { category: RateCategory; country_code: string; currency: string; price_minor: number | null }[] = [];
  for (const [k, { card, price }] of edited) {
    const value = price === null ? null : Number(price);
    if (value !== null && (price!.trim() === '' || !Number.isFinite(value))) return null;
    if (value === before.get(k) || (value === null && !before.has(k))) continue;
    cards.push({ category: card.category, country_code: card.countryCode, currency: card.currency, price_minor: value });
  }
  return cards;
}

export type RateCardSaveOutcome = 'saved' | 'step_up' | 'enroll' | 'invalid_code' | 'failed';

/**
 * Saves the changes. Platform admins need a recent MFA check: with `mfaCode`
 * the session steps up first (POST /api/auth/mfa-step-up), then the PUT runs.
 * 'step_up' asks for a code; 'enroll' means no authenticator is set up yet.
 */
export async function saveRateCardChanges(
  changes: NonNullable<ReturnType<typeof rateCardChanges>>,
  mfaCode: string | null,
  fetcher: typeof authFetch = authFetch,
): Promise<RateCardSaveOutcome> {
  if (mfaCode !== null) {
    const stepped = await fetcher('/api/auth/mfa-step-up', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: mfaCode.trim() }),
    });
    if (!stepped.ok) return 'invalid_code';
  }
  const res = await fetcher(ENDPOINT, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cards: changes }),
  });
  if (res.ok) return 'saved';
  const body = (await res.json().catch(() => ({}))) as { code?: string };
  if (body.code === 'mfa_step_up_required') return 'step_up';
  if (body.code === 'mfa_enrollment_required') return 'enroll';
  return 'failed';
}

export function RateCardEditor() {
  const t = useTranslations('Analytics.cost.rateCard');
  const [canEdit, setCanEdit] = useState(false);
  const [cards, setCards] = useState<RateCard[]>([]);
  const [edits, setEdits] = useState(new Map<string, { card: RateCard; price: string | null }>());
  const [category, setCategory] = useState<RateCategory>('marketing');
  const [draft, setDraft] = useState({ countryCode: '', currency: 'INR', price: '' });
  const [saving, setSaving] = useState(false);
  // Shown after the server asks for a fresh two-step check.
  const [stepUp, setStepUp] = useState(false);
  const [mfaCode, setMfaCode] = useState('');
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    const res = await authFetch(ENDPOINT, { cache: 'no-store' });
    if (!res.ok) return;
    const body = (await res.json()) as { cards: RateCard[]; canEdit: boolean };
    setCanEdit(body.canEdit);
    setCards(body.cards);
    setEdits(new Map());
  }, []);

  useEffect(() => { void load().catch(() => undefined); }, [load]);

  const rows = useMemo(() => {
    const merged = new Map(cards.map((c) => [key(c), { card: c, price: String(c.priceMinor) as string | null }]));
    for (const [k, v] of edits) merged.set(k, v);
    return [...merged.entries()].filter(([, v]) => v.card.category === category)
      .sort(([a], [b]) => a.localeCompare(b));
  }, [cards, edits, category]);

  if (!canEdit) return null;

  const edit = (card: RateCard, price: string | null) =>
    setEdits((prev) => new Map(prev).set(key(card), { card, price }));

  const addDraft = () => {
    const countryCode = draft.countryCode.trim().toUpperCase(), currency = draft.currency.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(countryCode) || !/^[A-Z]{3}$/.test(currency) || draft.price.trim() === '' || !(Number(draft.price) >= 0)) {
      toast.error(t('invalidRow'));
      return false;
    }
    edit({ category, countryCode, currency, priceMinor: Number(draft.price) }, draft.price.trim());
    setDraft({ countryCode: '', currency, price: '' });
    return true;
  };

  const save = async () => {
    const changes = rateCardChanges(cards, edits);
    if (changes === null) { toast.error(t('invalidRow')); return; }
    if (changes.length === 0) return;
    setSaving(true);
    try {
      const outcome = await saveRateCardChanges(changes, stepUp ? mfaCode : null);
      if (outcome === 'saved') {
        setStepUp(false);
        setMfaCode('');
        toast.success(t('saved'));
        await load();
      } else if (outcome === 'step_up') {
        setStepUp(true);
        toast.error(t('mfaRequired'));
      } else if (outcome === 'enroll') {
        toast.error(t('mfaEnrollRequired'));
      } else if (outcome === 'invalid_code') {
        toast.error(t('stepUpInvalid'));
      } else {
        toast.error(t('saveFailed'));
      }
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsGroup
      testId="rate-card-editor"
      title={t('title')}
      footer={t('description')}
      action={
        <Button size="sm" className="min-h-11 sm:min-h-8" onClick={save} disabled={saving || edits.size === 0 || (stepUp && mfaCode.trim().length < 6)}>
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {stepUp ? t('stepUpSubmit') : t('save')}
        </Button>
      }
    >
      <div className={cn(SETTINGS_ROW_HAIRLINE, 'px-4 py-2.5')}>
        <SegmentedControl
          aria-label={t('title')}
          value={category}
          onValueChange={setCategory}
          options={RATE_CATEGORIES.map((c) => ({ value: c, label: t(`categories.${c}`) }))}
        />
      </div>
      {rows.length === 0 && (
        <div className={cn(SETTINGS_ROW_HAIRLINE, 'flex min-h-11 items-center px-4 py-3 text-sm text-muted-foreground')}>{t('empty')}</div>
      )}
      {rows.map(([k, { card, price }]) => (
        <div key={k} className={cn(SETTINGS_ROW_HAIRLINE, 'flex min-h-11 items-center gap-3 px-4 py-2', price === null && 'opacity-50')}>
          <span className="min-w-0 flex-1 text-sm font-medium">{card.countryCode} · <span className="text-muted-foreground">{card.currency}</span></span>
          <Input
            aria-label={t('priceFor', { country: card.countryCode, currency: card.currency })}
            inputMode="decimal"
            className="w-28 sm:w-32"
            disabled={price === null}
            value={price ?? ''}
            onChange={(e) => edit(card, e.target.value)}
          />
          <Button size="icon" variant="ghost" className="size-11 shrink-0 text-destructive sm:size-9" aria-label={t('remove')} disabled={price === null} onClick={() => edit(card, null)}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <GroupedListRow
        leading={<Plus className="size-4 text-primary" aria-hidden />}
        title={<span className="text-primary">{t('add')}</span>}
        onClick={() => setAdding(true)}
      />
      {stepUp && (
        <SettingsRow label={t('stepUpCode')} htmlFor="rate-card-step-up">
          <Input id="rate-card-step-up" placeholder={t('stepUpCode')} inputMode="numeric" autoComplete="one-time-code"
            maxLength={10} value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} />
        </SettingsRow>
      )}
      <Sheet open={adding} onOpenChange={setAdding}>
        <SheetContent size="sm" className="w-full gap-4 overflow-y-auto p-4">
          <SheetHeader className="p-0 pr-8">
            <SheetTitle>{t('add')}</SheetTitle>
            <SheetDescription>{t(`categories.${category}`)}</SheetDescription>
          </SheetHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => { e.preventDefault(); if (addDraft()) setAdding(false); }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="rate-card-country">{t('country')}</Label>
              <Input id="rate-card-country" placeholder="IN" maxLength={2}
                value={draft.countryCode} onChange={(e) => setDraft({ ...draft, countryCode: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rate-card-currency">{t('currency')}</Label>
              <Input id="rate-card-currency" placeholder="INR" maxLength={3}
                value={draft.currency} onChange={(e) => setDraft({ ...draft, currency: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rate-card-price">{t('price')}</Label>
              <Input id="rate-card-price" placeholder="78.46" inputMode="decimal"
                value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value })} />
            </div>
            <Button type="submit" className="min-h-11 w-full">{t('add')}</Button>
          </form>
        </SheetContent>
      </Sheet>
    </SettingsGroup>
  );
}
