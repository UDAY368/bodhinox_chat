"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { authFetch } from "@/lib/auth/client";
import { channelPath } from "@/lib/channels/routes";
import { scopeIncludes } from "@/lib/channels/capabilities";
import { ChannelStatusBanner } from "@/components/channels/channel-gate";
import { useWorkspaceChannels } from "@/hooks/use-workspace-channels";
import { FlowEditorShell } from "./flow-editor-shell";
import type { FlowRow, FlowNodeRow } from "@/lib/flows/types";
import type { Channel } from "@/types";

/**
 * A channel section's flow editor (/whatsapp/flows/[id], /instagram/flows/[id]).
 *
 * Loads `{flow, nodes}` from `/api/flows/[id]` and hands it to the editor.
 * A flow of the other channel opened here moves to its own section; a legacy
 * 'any' flow opens in either. The API 404s on a flow id the caller cannot
 * see (RLS), which becomes the "Flow not found" state. The section layout
 * (ChannelGate) leaves the setup/attention banner to this full-height page.
 */
export function FlowEditorPage({ channel, flowId }: { channel: Channel; flowId: string }) {
  const router = useRouter();
  const t = useTranslations("Flows.edit");
  const { data: channels } = useWorkspaceChannels();

  const [flow, setFlow] = useState<FlowRow | null>(null);
  const [nodes, setNodes] = useState<FlowNodeRow[]>([]);
  const [draftHash, setDraftHash] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!flowId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch(`/api/flows/${encodeURIComponent(flowId)}`);
        if (res.status === 404) {
          if (!cancelled) setNotFound(true);
          return;
        }
        if (!res.ok) throw new Error(`Failed: ${res.status}`);
        const json = (await res.json()) as { flow: FlowRow; nodes: FlowNodeRow[]; draft_hash?: string };
        if (cancelled) return;
        if (!scopeIncludes(json.flow.channel_scope, channel)) {
          // Another channel's flow: open it in its own section.
          router.replace(channelPath(channel === "whatsapp" ? "instagram" : "whatsapp", "flows", flowId));
          return;
        }
        setFlow(json.flow);
        setNodes(json.nodes ?? []);
        setDraftHash(json.draft_hash ?? null);
      } catch (err) {
        if (!cancelled) {
          console.error(err instanceof Error ? err.name : "flow load failed");
          toast.error(t("loadError"));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [channel, flowId, router, t]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (notFound || !flow) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="text-sm text-muted-foreground">{t("notFound")}</p>
        <button
          type="button"
          onClick={() => router.push(channelPath(channel, "flows"))}
          className="text-sm text-primary hover:opacity-80"
        >
          {t("backToFlows")}
        </button>
      </div>
    );
  }

  return (
    <div className="flow-studio-page flex h-full min-h-0 flex-col">
      {channels && (
        <div className="shrink-0 px-3 pt-2 empty:hidden">
          <ChannelStatusBanner state={channels.channels[channel]} />
        </div>
      )}
      <div className="min-h-0 flex-1">
        <FlowEditorShell initialFlow={flow} initialNodes={nodes} initialDraftHash={draftHash} section={channel} />
      </div>
    </div>
  );
}
