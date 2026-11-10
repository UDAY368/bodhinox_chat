'use client';

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { authFetch } from '@/lib/auth/client';
import type { ChannelChanges, WorkspaceChannels } from '@/lib/channels/workspace';

/**
 * The workspace's channel state (GET /api/account/channels), shared by every
 * component on the page: the nav, the channel layouts and the settings card
 * read one copy, fetched once per workspace, and a save updates all of them.
 * Switching workspace refetches. Nothing is kept in browser storage.
 */
export interface WorkspaceChannelsState {
  data: WorkspaceChannels | null;
  loading: boolean;
  /** True when the last load failed (the previous data, if any, is kept). */
  error: boolean;
}

/** A refused save: the server's message and code (channel_connected, last_channel, plan_required, platform_off). */
export class ChannelsSaveError extends Error {
  constructor(message: string, readonly code: string | null, readonly status: number) {
    super(message);
    this.name = 'ChannelsSaveError';
  }
}

type Entry = { accountId: string | null; state: WorkspaceChannelsState; inflight: Promise<void> | null };

const EMPTY: WorkspaceChannelsState = { data: null, loading: true, error: false };
let entry: Entry = { accountId: null, state: EMPTY, inflight: null };
const listeners = new Set<() => void>();

function publish(accountId: string | null, state: WorkspaceChannelsState) {
  if (entry.accountId !== accountId) return; // a response for a workspace the user has left
  entry = { ...entry, state };
  for (const listener of listeners) listener();
}

function load(accountId: string, force = false): Promise<void> {
  if (entry.accountId !== accountId) entry = { accountId, state: EMPTY, inflight: null };
  if (entry.inflight) return entry.inflight;
  if (!force && entry.state.data && !entry.state.error) return Promise.resolve();
  publish(accountId, { ...entry.state, loading: true });
  const inflight = (async () => {
    try {
      const res = await authFetch('/api/account/channels', { cache: 'no-store' });
      if (!res.ok) throw new Error(`status ${res.status}`);
      publish(accountId, { data: (await res.json()) as WorkspaceChannels, loading: false, error: false });
    } catch {
      publish(accountId, { data: entry.state.data, loading: false, error: true });
    } finally {
      if (entry.accountId === accountId) entry = { ...entry, inflight: null };
    }
  })();
  entry = { ...entry, inflight };
  return inflight;
}

async function save(accountId: string, changes: ChannelChanges): Promise<WorkspaceChannels> {
  const res = await authFetch('/api/account/channels', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channels: changes }),
  });
  const body = (await res.json().catch(() => null)) as (WorkspaceChannels & { error?: string; code?: string }) | null;
  if (!res.ok || !body) throw new ChannelsSaveError(body?.error ?? '', body?.code ?? null, res.status);
  if (entry.accountId !== accountId) entry = { accountId, state: EMPTY, inflight: null };
  publish(accountId, { data: body, loading: false, error: false });
  return body;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useWorkspaceChannels(): WorkspaceChannelsState & {
  refresh: () => Promise<void>;
  /** Saves a change (admins). Throws ChannelsSaveError with the server's message when a rule refuses it. */
  save: (changes: ChannelChanges) => Promise<WorkspaceChannels>;
} {
  const { accountId } = useAuth();
  const snapshot = useSyncExternalStore(subscribe, () => entry, () => entry);
  const state = accountId && snapshot.accountId === accountId ? snapshot.state : EMPTY;

  useEffect(() => {
    if (accountId) void load(accountId);
  }, [accountId]);

  const refresh = useCallback(() => (accountId ? load(accountId, true) : Promise.resolve()), [accountId]);
  const saveChanges = useCallback((changes: ChannelChanges) => {
    if (!accountId) return Promise.reject(new ChannelsSaveError('', null, 401));
    return save(accountId, changes);
  }, [accountId]);

  return { ...state, refresh, save: saveChanges };
}

/** Test seam: forget the shared copy. */
export function resetWorkspaceChannelsForTests() {
  entry = { accountId: null, state: EMPTY, inflight: null };
  for (const listener of listeners) listener();
}
