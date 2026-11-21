'use client';

// The inbox's Agent filter: the workspace's members to choose from and the
// chosen member and mode. Kept in the list's own state, like the company
// filter; the server applies it ("Handled by" included) when it pages the list.
// A link with ?agent=<member id> (Analytics > Team: "Open their chats") starts
// on that member's handled chats.
import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

import { useAuth } from '@/hooks/use-auth';
import { createClient } from '@/lib/data/client';
import type { AgentFilter } from '@/lib/inbox/inbox-filters';

export interface FilterMember { id: string; name: string }

const MEMBER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function useAgentFilter() {
  const { accountId } = useAuth();
  const searchParams = useSearchParams();
  const [members, setMembers] = useState<FilterMember[]>([]);
  const [agent, setAgent] = useState<AgentFilter | null>(() => {
    const linked = searchParams?.get('agent');
    return linked && MEMBER_ID.test(linked) ? { memberId: linked.toLowerCase(), mode: 'handled' } : null;
  });

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

  return { members, agent, setAgent };
}
