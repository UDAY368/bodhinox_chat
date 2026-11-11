'use client';

// The inbox's Agent filter: the workspace's members to choose from, the chosen
// member and mode, and (for "Handled by") the ids of the chats they handled,
// read from GET /api/inbox/handled-by. Kept in the list's own state, like the
// company filter. A failed lookup keeps only the current-assignee matches.
import { useEffect, useState } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { authFetch } from '@/lib/auth/client';
import { createClient } from '@/lib/data/client';
import type { AgentFilter } from '@/lib/inbox/inbox-filters';

export interface FilterMember { id: string; name: string }

export function useAgentFilter(resyncToken?: string | number) {
  const { accountId } = useAuth();
  const [members, setMembers] = useState<FilterMember[]>([]);
  const [agent, setAgent] = useState<AgentFilter | null>(null);
  // Keyed by the member it was read for, so a newer choice never shows an older member's chats.
  const [handled, setHandled] = useState<{ memberId: string; ids: ReadonlySet<string> } | null>(null);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    void createClient().from('profiles').select('*').order('full_name').then(({ data }) => {
      if (cancelled || !Array.isArray(data)) return;
      setMembers((data as Array<{ user_id: string; full_name: string | null }>)
        .filter((p) => p.user_id)
        .map((p) => ({ id: p.user_id, name: p.full_name?.trim() || '' })));
    });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  const memberId = agent?.mode === 'handled' ? agent.memberId : null;
  useEffect(() => {
    if (!memberId) return;
    let cancelled = false;
    authFetch(`/api/inbox/handled-by?member=${encodeURIComponent(memberId)}`, { cache: 'no-store' })
      .then(async (res) => {
        const json = (await res.json().catch(() => null)) as { conversationIds?: string[] } | null;
        if (!cancelled && res.ok && Array.isArray(json?.conversationIds)) setHandled({ memberId, ids: new Set(json.conversationIds) });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [memberId, resyncToken]);

  const handledIds = handled && handled.memberId === memberId ? handled.ids : null;
  return { members, agent, setAgent, handledIds };
}
