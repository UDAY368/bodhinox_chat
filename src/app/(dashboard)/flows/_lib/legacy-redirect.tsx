'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { authFetch } from '@/lib/auth/client';
import { useWorkspaceChannels } from '@/hooks/use-workspace-channels';
import type { FlowChannelScope } from '@/lib/flows/types';
import { legacyFlowsPath } from './legacy-path';

/**
 * The client half of the old /flows and /flows/[id] redirects, used when the
 * server could not resolve the session (an access cookie that needs a
 * refresh): the same rule from GET /api/account/channels and GET
 * /api/flows/[id], both of which refresh the session through authFetch.
 * If the channels cannot be loaded it falls back to WhatsApp, as before.
 */
export function LegacyFlowsRedirect({ flowId }: { flowId?: string }) {
  const router = useRouter();
  const { data, error } = useWorkspaceChannels();

  useEffect(() => {
    if (!data && !error) return;
    const enabled = data?.enabled ?? ['whatsapp'];
    let cancelled = false;
    (async () => {
      let scope: FlowChannelScope | null = null;
      if (flowId) {
        try {
          const res = await authFetch(`/api/flows/${encodeURIComponent(flowId)}`);
          if (res.ok) scope = ((await res.json()) as { flow?: { channel_scope?: FlowChannelScope } }).flow?.channel_scope ?? 'whatsapp';
        } catch {
          // The section's editor shows the error.
        }
      }
      if (!cancelled) router.replace(legacyFlowsPath(enabled, flowId, scope));
    })();
    return () => {
      cancelled = true;
    };
  }, [data, error, flowId, router]);

  return (
    <div className="flex h-full items-center justify-center" role="status">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}
