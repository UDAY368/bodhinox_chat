'use client';

import { useEffect, useState } from 'react';
import { readConsent, writeConsent } from './consent-store';
import { cleanRef, clearStoredRef, persistRef, writeRef } from './referral-store';

export interface ConsentLabels { title: string; text: string; accept: string; decline: string }

/**
 * Remembers the ?ref= code of the link the visitor came in by (the only optional storage the shop uses). With the visitor's
 * agreement it is kept in the browser; without it, in memory for the visit. The banner appears only when such a code arrives and
 * no choice was made yet, with equal Accept and Decline buttons.
 */
export function ReferralCapture({ handle, labels }: { handle: string; labels: ConsentLabels }) {
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    const ref = cleanRef(new URLSearchParams(window.location.search).get('ref'));
    if (!ref) return;
    const consent = readConsent(handle);
    writeRef(handle, ref, consent === 'yes');
    // After the effect (not inside it): the banner is shown only on the client, once a code has arrived.
    if (consent === null) void Promise.resolve().then(() => setAsking(true));
  }, [handle]);
  if (!asking) return null;
  const choose = (value: 'yes' | 'no') => {
    writeConsent(handle, value);
    if (value === 'yes') persistRef(handle); else clearStoredRef(handle);
    setAsking(false);
  };
  const button = 'inline-flex min-h-11 items-center rounded-[var(--shop-radius)] border border-current px-4 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2';
  return (
    <section aria-labelledby="shop-consent-title"
      className="fixed inset-x-3 bottom-3 z-40 mx-auto flex max-w-xl flex-col gap-3 rounded-[var(--shop-radius)] bg-[var(--shop-surface)] p-4 text-[var(--shop-text)] shadow-lg ring-1 ring-black/20 @2xl:flex-row @2xl:items-center">
      <div className="min-w-0 flex-1">
        <h2 id="shop-consent-title" className="text-sm font-semibold">{labels.title}</h2>
        <p className="mt-1 text-sm">{labels.text}</p>
      </div>
      <div className="flex gap-2">
        <button type="button" className={button} onClick={() => choose('yes')}>{labels.accept}</button>
        <button type="button" className={button} onClick={() => choose('no')}>{labels.decline}</button>
      </div>
    </section>
  );
}
