'use client';

/** Small buttons of the buyer's account pages (store plan Phase 5): sign out, and "Order again". */
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { accountApiPath } from '@/lib/commerce/shop-customer-cookie';
import { addToCart, type BrowserCartLine } from './cart-store';
import { shopErrorKey, shopPostJson } from './shop-post';

export function SignOutButton({ handle }: { handle: string }) {
  const t = useTranslations('ShopPublic');
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const signOut = async () => {
    setBusy(true);
    await shopPostJson(`${accountApiPath(handle)}/sign-out`, {});
    setBusy(false);
    router.refresh();
  };
  return (
    <button type="button" onClick={signOut} disabled={busy} className="min-h-11 rounded-[var(--shop-radius)] border border-black/15 px-4 text-sm disabled:opacity-40">
      {t('account.signOut')}
    </button>
  );
}

/** Puts the order's still-available items back into the browser cart; the cart page prices them. */
export function ReorderButton({ handle, orderId }: { handle: string; orderId: string }) {
  const t = useTranslations('ShopPublic');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ added: number; skipped: number } | null>(null);
  const reorder = async () => {
    setBusy(true); setError(null);
    const result = await shopPostJson<{ lines: BrowserCartLine[]; skipped: number }>(`${accountApiPath(handle)}/reorder`, { orderId });
    setBusy(false);
    if (!result.ok) { setError(result.code); return; }
    for (const line of result.data.lines) addToCart(handle, line.variantId, line.qty);
    setDone({ added: result.data.lines.length, skipped: result.data.skipped });
  };
  return (
    <div className="flex flex-col gap-2">
      <button type="button" onClick={reorder} disabled={busy}
        className="h-11 rounded-[var(--shop-radius)] bg-[var(--shop-primary)] px-5 font-semibold text-[var(--shop-on-primary)] disabled:opacity-40">
        {busy ? <Loader2 className="mx-auto size-5 animate-spin" aria-label={t('loading')} /> : t('account.reorder')}
      </button>
      {error && <p role="alert" className="rounded-[var(--shop-radius)] bg-red-50 p-3 text-sm text-red-800">{t(shopErrorKey(error))}</p>}
      {done && (
        <div role="status" className="flex flex-col gap-1 rounded-[var(--shop-radius)] bg-black/5 p-3 text-sm">
          <p>{done.added > 0 ? t('account.reorderAdded') : t('account.reorderNone')}</p>
          {done.added > 0 && done.skipped > 0 && <p>{t('account.reorderSkipped', { count: done.skipped })}</p>}
          {done.added > 0 && <Link href={`/s/${handle}/cart`} className="inline-flex min-h-11 items-center font-semibold underline">{t('viewCart')}</Link>}
        </div>
      )}
    </div>
  );
}
