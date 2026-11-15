'use client';

/**
 * "Check delivery" on the product page (store plan Phase 5): a pincode box that
 * asks the server whether this shop delivers there, for how much, and whether
 * cash on delivery works. The answer is an estimate for this item; checkout
 * prices the real cart. The pincode stays in this component (no storage).
 */
import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Loader2, Truck } from 'lucide-react';
import { formatMoney } from '@/lib/commerce/money';
import { parsePincode } from '@/lib/commerce/pincode';

interface Answer { pincode: string; deliverable: boolean; unknown: boolean; shippingMinor: number; currency: string | null; cod: boolean }

export function PincodeCheck({ handle, variantId, quantity }: { handle: string; variantId: string | null; quantity: number }) {
  const t = useTranslations('ShopPublic');
  const locale = useLocale();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);

  const check = async () => {
    const pincode = parsePincode(value);
    setAnswer(null);
    if (!pincode) { setError(t('pincode.invalid')); return; }
    if (!variantId) { setError(t('pickOptions')); return; }
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/public/store/${handle}/delivery`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ variantId, pincode, quantity }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && typeof data.deliverable === 'boolean') setAnswer({ pincode, deliverable: data.deliverable, unknown: data.unknown === true, shippingMinor: Number(data.shippingMinor) || 0, currency: typeof data.currency === 'string' ? data.currency : null, cod: data.cod === true });
      else setError(t(res.status === 429 ? 'errors.too_many' : 'errors.generic'));
    } catch {
      setError(t('errors.network'));
    }
    setBusy(false);
  };

  const money = (minor: number, currency: string | null) => {
    if (!currency) return '';
    try { return formatMoney(minor, currency, locale); } catch { return String(minor); }
  };

  return (
    <div className="flex flex-col gap-2 border-t border-black/10 pt-4">
      <label htmlFor="pincode-check" className="flex items-center gap-2 text-sm font-medium"><Truck className="size-4" aria-hidden />{t('pincode.label')}</label>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void check(); }}>
        <input id="pincode-check" inputMode="numeric" autoComplete="postal-code" maxLength={7} value={value} placeholder={t('pincode.placeholder')}
          onChange={(e) => { setValue(e.target.value.replace(/[^0-9 ]/g, '')); setAnswer(null); setError(null); }}
          className="h-11 min-w-0 flex-1 rounded-[var(--shop-radius)] border border-black/15 bg-[var(--shop-surface)] px-3 text-sm" />
        <button type="submit" disabled={busy}
          className="flex h-11 items-center justify-center rounded-[var(--shop-radius)] border border-[var(--shop-primary)] px-4 text-sm font-semibold text-[var(--shop-primary)] disabled:opacity-40">
          {busy ? <Loader2 className="size-4 animate-spin" aria-label={t('pincode.checking')} /> : t('pincode.button')}
        </button>
      </form>
      <div role="status" aria-live="polite" className="text-sm">
        {error && <p className="text-red-700">{error}</p>}
        {answer && (answer.deliverable
          ? <p>{t('pincode.delivers', { pincode: answer.pincode })} · {answer.shippingMinor > 0 ? t('pincode.shipping', { amount: money(answer.shippingMinor, answer.currency) }) : t('pincode.freeShipping')} · {t(answer.cod ? 'pincode.codYes' : 'pincode.codNo')}</p>
          : <p>{t(answer.unknown ? 'pincode.atCheckout' : 'pincode.no')}</p>)}
      </div>
    </div>
  );
}
