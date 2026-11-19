'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

/** One report a minute while a tab shows the page (and one on arrival): the shop owner's live view counts these. */
export const BEACON_INTERVAL_MS = 60_000;

/** The path under the shop ("/", "/p/<id>") from a full pathname. */
export function shopPathOf(pathname: string, handle: string): string {
  const base = `/s/${handle}`;
  return pathname.startsWith(base) ? pathname.slice(base.length) || '/' : '/';
}

/**
 * The live-view beacon (store plan Phase 8, batch 7). It sends only the page path, with no cookie, id or storage, and nothing
 * else about the visitor; the server keeps a per-minute count per page. Failures are ignored. Renders nothing.
 */
export function LiveBeacon({ handle }: { handle: string }) {
  const pathname = usePathname();
  useEffect(() => {
    const path = shopPathOf(pathname, handle);
    const send = () => {
      if (document.visibilityState !== 'visible') return;
      fetch(`/api/public/store/${handle}/live`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }), keepalive: true, credentials: 'same-origin',
      }).catch(() => undefined);
    };
    send();
    const timer = window.setInterval(send, BEACON_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [handle, pathname]);
  return null;
}
