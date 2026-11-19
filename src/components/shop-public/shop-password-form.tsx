'use client';

/** The password box of a password-protected shop. A right password sets the shop's cookie; the page then reloads into the shop. */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';

export function ShopPasswordForm({ handle }: { handle: string }) {
  const t = useTranslations('ShopPublic.lock');
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/public/store/${handle}/unlock`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) { router.refresh(); return; }
      const code = typeof data?.code === 'string' ? data.code : 'generic';
      setError(t(`errors.${code === 'wrong_password' ? 'wrong_password' : code === 'too_many' || code === 'rate_limited' ? 'too_many' : 'generic'}`));
    } catch {
      setError(t('errors.network'));
    }
    setBusy(false);
  };

  return (
    <form className="flex w-full flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <label htmlFor="shop-password" className="sr-only">{t('passwordLabel')}</label>
      <input id="shop-password" type="password" autoComplete="current-password" required maxLength={72} value={password}
        onChange={(e) => setPassword(e.target.value)} placeholder={t('passwordLabel')}
        className="h-11 rounded-[var(--shop-radius)] border border-black/15 bg-white px-3 text-base text-black" />
      <button type="submit" disabled={busy || !password}
        className="h-11 rounded-[var(--shop-radius)] bg-[var(--shop-primary)] font-semibold text-[var(--shop-on-primary)] disabled:opacity-40">
        {busy ? <Loader2 className="mx-auto size-5 animate-spin" aria-label={t('checking')} /> : t('enter')}
      </button>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    </form>
  );
}
