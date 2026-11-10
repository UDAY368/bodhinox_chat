'use client';

// The Instagram section's flows (GET /api/flows?channel=instagram: Instagram
// flows plus legacy flows that run on both channels), for the Instagram tool
// pages: Comments, Conversation starters and Default reply (Stage 2, 2E).
// Also creates a draft Instagram flow with a given trigger (POST /api/flows).

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { authFetch } from '@/lib/auth/client';
import type { FlowTriggerType } from '@/lib/flows/types';

export interface InstagramFlowSummary {
  id: string;
  name: string;
  status: 'draft' | 'active' | 'paused' | 'archived';
  trigger_type: FlowTriggerType;
  channel_scope: 'whatsapp' | 'instagram' | 'any';
}

export function useInstagramFlows() {
  const { accountId } = useAuth();
  const [flows, setFlows] = useState<InstagramFlowSummary[] | null>(null);
  const [failed, setFailed] = useState(false);

  const reload = useCallback(async () => {
    setFailed(false);
    try {
      const res = await authFetch('/api/flows?channel=instagram', { cache: 'no-store' });
      if (!res.ok) throw new Error('load');
      const json = (await res.json()) as { flows?: InstagramFlowSummary[] };
      setFlows((json.flows ?? []).filter((f) => f.channel_scope !== 'whatsapp'));
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    if (!accountId) return;
    setFlows(null);
    void reload();
  }, [accountId, reload]);

  return { flows, failed, reload };
}

/** Creates a draft Instagram flow; returns its id, or null when the server refused. */
export async function createInstagramFlow(name: string, triggerType: FlowTriggerType,
  triggerConfig: Record<string, unknown>): Promise<string | null> {
  const res = await authFetch('/api/flows', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, trigger_type: triggerType, trigger_config: triggerConfig, channel_scope: 'instagram' }),
  });
  if (!res.ok) return null;
  const json = (await res.json().catch(() => ({}))) as { flow?: { id?: unknown } };
  return typeof json.flow?.id === 'string' ? json.flow.id : null;
}
