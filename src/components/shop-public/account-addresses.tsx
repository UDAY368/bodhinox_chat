'use client';

/**
 * The buyer's saved addresses (store plan Phase 5): up to five, the same
 * fields as the checkout address. Every change goes to the server, which
 * answers the fresh list.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { MAX_SAVED_ADDRESSES, accountApiPath } from '@/lib/commerce/shop-customer-cookie';
import type { SavedAddress } from '@/lib/commerce/shop-customer';
import { shopErrorKey, shopPostJson } from './shop-post';

const FIELDS = ['name', 'phone', 'line1', 'line2', 'city', 'state', 'postal_code', 'country', 'instructions'] as const;
type Field = typeof FIELDS[number];
type Form = Record<Field, string>;
const EMPTY: Form = { name: '', phone: '', line1: '', line2: '', city: '', state: '', postal_code: '', country: 'IN', instructions: '' };
const MAX: Record<Field, number> = { name: 100, phone: 20, line1: 200, line2: 200, city: 100, state: 100, postal_code: 12, country: 2, instructions: 300 };
const REQUIRED = new Set<Field>(['name', 'phone', 'line1', 'city', 'postal_code', 'country']);
const AUTOCOMPLETE: Record<Field, string> = { name: 'name', phone: 'tel', line1: 'address-line1', line2: 'address-line2', city: 'address-level2',
  state: 'address-level1', postal_code: 'postal-code', country: 'country', instructions: 'off' };

export function AccountAddresses({ handle, initial }: { handle: string; initial: SavedAddress[] }) {
  const t = useTranslations('ShopPublic');
  const label = useTranslations('Storefront.address');
  const [addresses, setAddresses] = useState(initial);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (body: Record<string, unknown>) => {
    setBusy(true); setError(null);
    const result = await shopPostJson<{ addresses: SavedAddress[] }>(`${accountApiPath(handle)}/addresses`, body);
    setBusy(false);
    if (!result.ok) { setError(result.code); return false; }
    setAddresses(result.data.addresses);
    return true;
  };
  const open = (address: SavedAddress | null) => {
    setError(null);
    setEditing(address?.id ?? 'new');
    setForm(address ? Object.fromEntries(FIELDS.map((f) => [f, address[f] ?? ''])) as Form : EMPTY);
  };
  const save = async () => {
    // The state code is not a form field: an edit keeps the stored one unless the state itself changed.
    const before = addresses.find((a) => a.id === editing);
    const stateCode = before && (before.state ?? '') === form.state.trim() ? before.state_code : null;
    const address = { ...Object.fromEntries(FIELDS.map((f) => [f, form[f].trim() || null])), state_code: stateCode };
    if (await send({ action: 'save', id: editing === 'new' ? undefined : editing, address })) setEditing(null);
  };

  const input = 'h-11 w-full rounded-[var(--shop-radius)] border border-black/15 bg-white px-3 text-base text-black';
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm opacity-80">{t('account.addressesIntro', { max: MAX_SAVED_ADDRESSES })}</p>
      {error && <p role="alert" className="rounded-[var(--shop-radius)] bg-red-50 p-3 text-sm text-red-800">{t(shopErrorKey(error))}</p>}
      {addresses.length === 0 && editing === null && <p className="opacity-70">{t('account.noAddresses')}</p>}
      <ul className="grid gap-3 @2xl:grid-cols-2">
        {addresses.map((a) => (
          <li key={a.id} className="flex flex-col gap-1 rounded-[var(--shop-radius)] bg-[var(--shop-surface)] p-4 text-sm ring-1 ring-black/5">
            <p className="font-semibold">{a.name}</p>
            <p className="break-words opacity-80">{[a.line1, a.line2, a.city, a.state, a.postal_code, a.country].filter(Boolean).join(', ')}</p>
            <p className="opacity-80">{a.phone}</p>
            <div className="mt-1 flex gap-2">
              <button type="button" disabled={busy} onClick={() => open(a)} className="min-h-11 rounded-[var(--shop-radius)] border border-black/15 px-4">{t('account.editAddress')}</button>
              <button type="button" disabled={busy} onClick={() => void send({ action: 'delete', id: a.id })}
                className="min-h-11 rounded-[var(--shop-radius)] border border-black/15 px-4 text-red-800">{t('account.deleteAddress')}</button>
            </div>
          </li>
        ))}
      </ul>
      {editing === null ? (
        addresses.length < MAX_SAVED_ADDRESSES
          ? <button type="button" onClick={() => open(null)} className="h-11 self-start rounded-[var(--shop-radius)] bg-[var(--shop-primary)] px-5 font-semibold text-[var(--shop-on-primary)]">{t('account.addAddress')}</button>
          : <p className="text-sm opacity-80">{t('errors.address_limit')}</p>
      ) : (
        <form className="grid gap-3 rounded-[var(--shop-radius)] bg-[var(--shop-surface)] p-4 ring-1 ring-black/5 @2xl:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          {FIELDS.map((f) => (
            <div key={f} className={f === 'line1' || f === 'line2' || f === 'instructions' ? '@2xl:col-span-2' : undefined}>
              <label htmlFor={`saved-${f}`} className="text-xs opacity-70">{label(f)}</label>
              <input id={`saved-${f}`} className={input} value={form[f]} maxLength={MAX[f]} required={REQUIRED.has(f)} autoComplete={AUTOCOMPLETE[f]}
                type={f === 'phone' ? 'tel' : 'text'}
                onChange={(e) => setForm((v) => ({ ...v, [f]: f === 'country' ? e.target.value.toUpperCase() : e.target.value }))} />
            </div>
          ))}
          <div className="flex gap-2 @2xl:col-span-2">
            <button type="submit" disabled={busy} className="h-11 rounded-[var(--shop-radius)] bg-[var(--shop-primary)] px-5 font-semibold text-[var(--shop-on-primary)] disabled:opacity-40">{t('account.saveAddress')}</button>
            <button type="button" disabled={busy} onClick={() => setEditing(null)} className="h-11 rounded-[var(--shop-radius)] border border-black/15 px-5">{t('account.cancel')}</button>
          </div>
        </form>
      )}
    </div>
  );
}
