'use client';

// Stage 5 (5E): what the inbox folders read — the workspace's labels and the
// label links of the conversations this member may see, their favourites, and
// their pending reminders and snoozes. Each loads on its own: a folder whose
// data failed to load simply matches nothing; the inbox works without them.
import { useCallback, useEffect, useMemo, useState } from 'react';

import { SNOOZES_CHANGED_EVENT } from '@/components/inbox/follow-up-bar';
import { useAuth } from '@/hooks/use-auth';
import { authFetch } from '@/lib/auth/client';
import type { FolderContext } from '@/lib/inbox/inbox-filters';
import type { InboxScope } from '@/lib/inbox/inbox-scope';
import type { ConversationLabel, LabelLink } from '@/lib/inbox/labels';

export interface PendingReminder {
  conversation_id: string;
  remind_at: string;
  kind: 'reminder' | 'snooze';
}

export interface InboxFolders {
  labels: ConversationLabel[];
  links: LabelLink[];
  favouriteIds: ReadonlySet<string>;
  reminders: PendingReminder[];
  context: FolderContext;
  /** Re-reads the labels and links (after a label is created, renamed or applied elsewhere). */
  reloadLabels: () => void;
  /** Marks or unmarks a favourite; resolves false when the server refused it. */
  setFavourite: (conversationId: string, favourite: boolean) => Promise<boolean>;
  /** Applies or removes a label; resolves false when the server refused it. */
  setLabel: (conversationId: string, labelId: string, on: boolean) => Promise<boolean>;
}

/** Label ids per conversation id, from the link rows. */
export function labelsByConversation(links: readonly LabelLink[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const link of links) {
    const set = map.get(link.conversation_id) ?? new Set<string>();
    set.add(link.label_id);
    map.set(link.conversation_id, set);
  }
  return map;
}

/**
 * `loadFailed` reads the "Failed" folder's conversations (only while that filter is on, so the inbox does
 * not run the query otherwise).
 */
export function useInboxFolders(scope: InboxScope, resyncToken: number, loadFailed = false): InboxFolders {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [labels, setLabels] = useState<ConversationLabel[]>([]);
  const [links, setLinks] = useState<LabelLink[]>([]);
  const [favourites, setFavourites] = useState<string[]>([]);
  const [reminders, setReminders] = useState<PendingReminder[]>([]);
  const [labelsVersion, setLabelsVersion] = useState(0);
  const [failed, setFailed] = useState<string[]>([]);

  useEffect(() => {
    if (!loadFailed) return;
    let cancelled = false;
    authFetch('/api/inbox/failed', { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) return;
        const body = (await res.json()) as { conversationIds?: string[] };
        if (!cancelled && Array.isArray(body.conversationIds)) setFailed(body.conversationIds);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [loadFailed, resyncToken]);

  useEffect(() => {
    let cancelled = false;
    const query = scope === 'all' ? '' : `?channel=${scope}`;
    authFetch(`/api/inbox/labels${query}`, { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) return;
        const body = (await res.json()) as { labels?: ConversationLabel[]; links?: LabelLink[] };
        if (cancelled) return;
        setLabels(Array.isArray(body.labels) ? body.labels : []);
        setLinks(Array.isArray(body.links) ? body.links : []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [scope, resyncToken, labelsVersion]);

  useEffect(() => {
    let cancelled = false;
    authFetch('/api/inbox/favourites', { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) return;
        const body = (await res.json()) as { conversation_ids?: string[] };
        if (!cancelled && Array.isArray(body.conversation_ids)) setFavourites(body.conversation_ids);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [resyncToken]);

  // The member's pending reminders and snoozes (personal). The inbox hides a
  // snoozed conversation until it wakes; the Reminders folder lists them all.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await authFetch('/api/inbox/reminders?status=pending', { cache: 'no-store' });
        if (!res.ok) return;
        const body = (await res.json().catch(() => null)) as { reminders?: PendingReminder[] } | null;
        if (!cancelled && Array.isArray(body?.reminders)) setReminders(body.reminders);
      } catch {
        // A convenience: without it every conversation simply stays listed.
      }
    };
    void load();
    const timer = setInterval(() => void load(), 60_000);
    window.addEventListener(SNOOZES_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener(SNOOZES_CHANGED_EVENT, load);
    };
  }, [resyncToken]);

  const favouriteIds = useMemo(() => new Set(favourites), [favourites]);
  const context = useMemo<FolderContext>(() => ({
    userId,
    favouriteIds,
    reminderIds: new Set(reminders.map((r) => r.conversation_id)),
    labelsByConversation: labelsByConversation(links),
    failedIds: new Set(failed),
  }), [userId, favouriteIds, reminders, links, failed]);

  const reloadLabels = useCallback(() => setLabelsVersion((v) => v + 1), []);

  const setFavourite = useCallback(async (conversationId: string, favourite: boolean) => {
    const res = await authFetch('/api/inbox/favourites', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_id: conversationId, favourite }),
    }).catch(() => null);
    if (!res?.ok) return false;
    setFavourites((prev) => (favourite ? [conversationId, ...prev.filter((id) => id !== conversationId)] : prev.filter((id) => id !== conversationId)));
    return true;
  }, []);

  const setLabel = useCallback(async (conversationId: string, labelId: string, on: boolean) => {
    const res = await authFetch(`/api/inbox/labels/${encodeURIComponent(labelId)}/conversations/${encodeURIComponent(conversationId)}`, {
      method: on ? 'PUT' : 'DELETE',
    }).catch(() => null);
    if (!res?.ok) return false;
    setLinks((prev) => {
      const rest = prev.filter((l) => !(l.conversation_id === conversationId && l.label_id === labelId));
      return on ? [...rest, { conversation_id: conversationId, label_id: labelId }] : rest;
    });
    return true;
  }, []);

  return { labels, links, favouriteIds, reminders, context, reloadLabels, setFavourite, setLabel };
}
