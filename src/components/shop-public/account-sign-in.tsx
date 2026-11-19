'use client';

/**
 * Sign-in on the public shop's account page (store plan Phase 5): the buyer's
 * phone, then the WhatsApp code. The server sets the account cookie; the page
 * then reloads its data. Nothing is kept in the browser's storage.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { accountApiPath } from '@/lib/commerce/shop-customer-cookie';
import { shopErrorKey, shopPostJson } from './shop-post';

export function AccountSignIn({ handle, available }: { handle: string; available: boolean }) {
  const t = useTranslations('ShopPublic');
  const router = useRouter();
  const api = accountApiPath(handle);
  const [phone, setPhone] = useState('+91');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendCode = async () => {
    setBusy(true); setError(null);
    const result = await shopPostJson<{ challengeId: string }>(`${api}/sign-in`, { phone });
    setBusy(false);
    if (!result.ok) { setError(result.code); return; }
    setChallenge(result.data.challengeId);
  };
  const verify = async () => {
    if (!challenge) return;
    setBusy(true); setError(null);
    const result = await shopPostJson<{ ok: true }>(`${api}/sign-in/verify`, { challengeId: challenge, code: code.trim() });
    setBusy(false);
    if (!result.ok) { setError(result.code); return; }
    router.refresh();
  };

  const field = 'h-11 rounded-[var(--shop-radius)] border border-black/15 bg-white px-3 text-base text-black';
  const button = 'h-11 rounded-[var(--shop-radius)] bg-[var(--shop-primary)] font-semibold text-[var(--shop-on-primary)] disabled:opacity-40';
  return (
    <section aria-labelledby="account-sign-in" className="mx-auto flex w-full max-w-sm flex-col gap-3 py-8">
      <h1 id="account-sign-in" className="text-2xl font-semibold" style={{ fontFamily: 'var(--shop-font-heading)' }}>{t('account.signIn')}</h1>
      {!available ? <p className="text-sm">{t('account.signInUnavailable')}</p> : (
        <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void (challenge ? verify() : sendCode()); }}>
          <p className="text-sm opacity-80">{t('account.signInIntro')}</p>
          {error && <p role="alert" className="rounded-[var(--shop-radius)] bg-red-50 p-3 text-sm text-red-800">{t(shopErrorKey(error))}</p>}
          {!challenge ? (
            <>
              <label htmlFor="account-phone" className="text-xs opacity-70">{t('phoneLabel')}</label>
              <input id="account-phone" type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} className={field} />
              <button type="submit" disabled={busy} className={button}>
                {busy ? <Loader2 className="mx-auto size-5 animate-spin" aria-label={t('loading')} /> : t('sendCode')}
              </button>
            </>
          ) : (
            <>
              <label htmlFor="account-code" className="text-xs opacity-70">{t('codeLabel')}</label>
              <input id="account-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} className={`${field} text-center text-lg tracking-[0.4em]`} />
              <button type="submit" disabled={busy || code.length !== 6} className={button}>
                {busy ? <Loader2 className="mx-auto size-5 animate-spin" aria-label={t('loading')} /> : t('account.signIn')}
              </button>
              <button type="button" className="min-h-11 text-sm underline" onClick={() => { setChallenge(null); setCode(''); setError(null); }}>{t('changeNumber')}</button>
            </>
          )}
        </form>
      )}
    </section>
  );
}
