/**
 * The lock screen of a shop that is not open: "coming soon" (the shop's name or logo and an optional
 * message from the owner) or a password form. Shown by the shop layout in place of every page, so a
 * locked shop reveals nothing but its name, logo and message.
 */
import type { CSSProperties } from 'react';
import { getTranslations } from 'next-intl/server';
import type { PublicShop } from '@/lib/commerce/public-shop';
import { themeCssVars } from '@/lib/commerce/shop-templates';
import { ShopPasswordForm } from './shop-password-form';

export async function ShopLock({ shop, mode, message }: { shop: PublicShop; mode: 'password' | 'coming_soon'; message: string | null }) {
  const t = await getTranslations('ShopPublic.lock');
  const style = { ...themeCssVars(shop.theme), fontFamily: 'var(--shop-font-body)' } as CSSProperties;
  return (
    <div style={style} className="@container grid min-h-screen place-items-center bg-[var(--shop-bg)] px-4 text-[var(--shop-text)]">
      <main className="flex w-full max-w-sm flex-col items-center gap-5 py-12 text-center">
        {shop.logoUrl
          // eslint-disable-next-line @next/next/no-img-element -- shop images come from our own route or the shop's https URL
          ? <img src={shop.logoUrl} alt={shop.name} className="h-16 w-auto max-w-[220px] object-contain" />
          : <h1 className="text-2xl font-semibold" style={{ fontFamily: 'var(--shop-font-heading)' }}>{shop.name}</h1>}
        {mode === 'coming_soon' ? (
          <>
            <h2 className="text-xl font-semibold" style={{ fontFamily: 'var(--shop-font-heading)' }}>{t('comingSoonTitle')}</h2>
            <p className="whitespace-pre-line opacity-80">{message ?? t('comingSoonDefault')}</p>
          </>
        ) : (
          <>
            <h2 className="text-xl font-semibold" style={{ fontFamily: 'var(--shop-font-heading)' }}>{t('passwordTitle')}</h2>
            <p className="opacity-80">{t('passwordHelp')}</p>
            <ShopPasswordForm handle={shop.handle} />
          </>
        )}
      </main>
    </div>
  );
}
