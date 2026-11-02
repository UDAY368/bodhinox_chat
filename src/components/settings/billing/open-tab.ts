'use client';

// Opening a tab after an awaited request is blocked by popup blockers (the
// click's user activation has expired). So the tab is opened inside the click,
// blank, and pointed at the URL once it is known. When the browser blocked it
// anyway, the caller gets the URL back to show as a link.

/** Only web URLs are ever loaded into the tab. */
function safeUrl(url: string): string {
  const parsed = new URL(url, window.location.origin);
  if (parsed.protocol !== 'https:' && parsed.origin !== window.location.origin) throw new Error('Unsafe URL');
  return parsed.href;
}

/**
 * Call synchronously from a click handler. `resolveUrl` may await requests; if
 * it throws, the blank tab is closed and the error is rethrown.
 */
export async function openInNewTab(resolveUrl: () => Promise<string>): Promise<{ opened: boolean; url: string }> {
  const tab = window.open('', '_blank');
  let url: string;
  try {
    url = safeUrl(await resolveUrl());
  } catch (error) {
    tab?.close();
    throw error;
  }
  if (!tab || tab.closed) return { opened: false, url };
  // The blank tab was opened without 'noopener' (that would hide it from us); cut the link before it navigates.
  tab.opener = null;
  tab.location.href = url;
  return { opened: true, url };
}
