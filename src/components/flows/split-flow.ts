import { authFetch } from '@/lib/auth/client';
import { CREATABLE_CHANNEL_SCOPES } from '@/lib/flows/types';
import type { Channel } from '@/types';

/**
 * Splits a legacy 'any' flow into a WhatsApp copy and an Instagram copy
 * (POST /api/flows/[id]/duplicate once per channel, each copying the saved
 * draft). The original stays, so runs pinned to its version finish; the user
 * archives it when ready. Resolves the copies' ids by channel, or null when a
 * copy failed (a copy already made stays, as an ordinary draft).
 */
export async function splitFlow(flowId: string, fetcher: typeof authFetch = authFetch): Promise<Record<Channel, string> | null> {
  const ids: Partial<Record<Channel, string>> = {};
  for (const channel of CREATABLE_CHANNEL_SCOPES) {
    try {
      const res = await fetcher(`/api/flows/${encodeURIComponent(flowId)}/duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel_scope: channel }),
      });
      const json = (await res.json().catch(() => null)) as { flow?: { id?: string } } | null;
      if (!res.ok || !json?.flow?.id) return null;
      ids[channel] = json.flow.id;
    } catch {
      return null;
    }
  }
  return ids as Record<Channel, string>;
}
