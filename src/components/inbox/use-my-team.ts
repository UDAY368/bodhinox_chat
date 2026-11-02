'use client';

import { useEffect, useState } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { authFetch } from '@/lib/auth/client';

interface TeamRow { member_ids: string[] }

/**
 * Members of every team the signed-in member belongs to (themselves
 * included), for the inbox "My team" filter. null while loading, on error,
 * or when they are in no team, so the filter is only offered when it means
 * something. Reloads when the workspace changes.
 */
export function useMyTeamMembers(): ReadonlySet<string> | null {
  const { user, accountId } = useAuth();
  const userId = user?.id ?? null;
  const [members, setMembers] = useState<ReadonlySet<string> | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!userId || !accountId) return;
    authFetch('/api/teams', { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error();
        const { teams } = (await res.json()) as { teams: TeamRow[] };
        const mine = teams.filter((team) => team.member_ids.includes(userId));
        if (!cancelled) setMembers(mine.length ? new Set(mine.flatMap((team) => team.member_ids)) : null);
      })
      .catch(() => {
        if (!cancelled) setMembers(null);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, accountId]);

  return members;
}
