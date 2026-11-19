'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

/** The unsubscribe button. The token is posted in the body (never put in a URL a script could read back). */
export function UnsubscribeForm({ handle, token }: { handle: string; token: string }) {
  const t = useTranslations('ShopPublic.unsubscribe');
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'invalid' | 'error'>('idle');
  const submit = async () => {
    setState('busy');
    try {
      const res = await fetch(`/api/public/store/${encodeURIComponent(handle)}/unsubscribe`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
      });
      setState(res.ok ? 'done' : res.status === 400 ? 'invalid' : 'error');
    } catch {
      setState('error');
    }
  };
  if (state === 'done') return <p role="status" className="font-medium">{t('done')}</p>;
  return (
    <>
      <button type="button" onClick={submit} disabled={state === 'busy' || !token}
        className="min-h-12 rounded-lg bg-black px-6 py-3 text-sm font-semibold text-white disabled:opacity-50">
        {t('button')}
      </button>
      {(state === 'invalid' || !token) && <p role="alert" className="text-sm text-red-700">{t('invalid')}</p>}
      {state === 'error' && <p role="alert" className="text-sm text-red-700">{t('error')}</p>}
    </>
  );
}
