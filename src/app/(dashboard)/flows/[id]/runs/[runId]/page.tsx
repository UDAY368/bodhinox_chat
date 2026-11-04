"use client";

/**
 * One flow run: its timeline, the states of its outbound sends, and Replay /
 * Cancel when the member may use them. Replay re-runs only the step the run
 * failed on, on the run's own version, and is refused (with the reason shown)
 * when a send's outcome is uncertain or it already went out.
 */

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { format } from "date-fns";
import { ArrowLeft, Loader2, RotateCcw, XCircle } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { authFetch } from "@/lib/auth/client";
import { cn } from "@/lib/utils";
import { EventLine, STATUS_META, runStatusKey, type EventRow, type RunRow } from "../run-shared";

interface Intent {
  kind: "flow" | "flow-api" | "flow-ai" | "flow-fallback";
  node_key: string | null;
  seq: number | null;
  attempt: number | null;
  part: string | null;
  status: string;
  last_error: string | null;
  updated_at: string;
}

interface RunDetail {
  flow: { id: string; name: string; status: string };
  run: RunRow & { transition_seq: number };
  events: EventRow[];
  intents: Intent[];
  replayable: { ok: boolean; reason?: string };
  failed_node: string | null;
  can: { replay: boolean; cancel: boolean };
}

const INTENT_COLOR: Record<string, string> = {
  accepted: "text-emerald-300",
  failed: "text-red-300",
  unknown: "text-amber-300",
  pending: "text-amber-300",
  dispatching: "text-amber-300",
};

export default function FlowRunDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string; runId: string }>();
  const t = useTranslations("Flows.logs");
  const tRun = useTranslations("Flows.runDetail");
  const tEdit = useTranslations("Flows.edit");
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await authFetch(`/api/flows/${params.id}/runs/${params.runId}`);
    if (res.status === 404) {
      setNotFound(true);
      return;
    }
    if (!res.ok) throw new Error(`Failed: ${res.status}`);
    setDetail((await res.json()) as RunDetail);
  }, [params.id, params.runId]);

  useEffect(() => {
    if (!params.id || !params.runId) return;
    load()
      .catch((err) => {
        console.error(err);
        toast.error(t("loadError"));
      })
      .finally(() => setLoading(false));
  }, [params.id, params.runId, load, t]);

  async function post(path: string, body?: Record<string, unknown>) {
    setBusy(true);
    try {
      const res = await authFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        toast.error(typeof json?.error === "string" ? json.error : tRun("actionFailed"));
      } else {
        toast.success(path.endsWith("/replay") ? tRun("replayQueued") : tRun("cancelDone"));
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (notFound || !detail) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="text-sm text-muted-foreground">{tEdit("notFound")}</p>
        <button type="button" onClick={() => router.push(`/flows/${params.id}/runs`)} className="text-sm text-primary hover:opacity-80">
          {tRun("backToRuns")}
        </button>
      </div>
    );
  }

  const { run, flow } = detail;
  const meta = STATUS_META[run.status] ?? STATUS_META.failed;
  const StatusIcon = meta.icon;
  const contactLabel = run.contact?.name?.trim() || run.contact?.phone || t("unknownContact");

  return (
    <div className="mx-auto max-w-4xl p-6" data-testid="flow-run-detail">
      <button type="button" onClick={() => router.push(`/flows/${flow.id}/runs`)}
        className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3 w-3" />
        {flow.name}
      </button>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold text-foreground">{contactLabel}</h1>
        <Badge variant="outline" className={cn("gap-1", meta.classes)}>
          <StatusIcon className="h-3 w-3" />
          {t(runStatusKey(run.status))}
        </Badge>
        <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {run.version ? t("versionLabel", { version: run.version }) : t("unversioned")}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {t("started", { time: format(new Date(run.started_at), "PP p") })}
        {run.end_reason ? ` · ${tRun("endReason", { reason: run.end_reason })}` : ""}
        {detail.failed_node ? ` · ${tRun("failedAt", { node: detail.failed_node })}` : ""}
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {run.status === "failed" && detail.can.replay && (
          <Button size="sm" disabled={busy || !detail.replayable.ok}
            title={detail.replayable.ok ? undefined : tRun(`refusal.${detail.replayable.reason ?? "not_failed"}`)}
            onClick={() => void post(`/api/flows/${flow.id}/runs/${run.id}/replay`)}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
            {tRun("replay")}
          </Button>
        )}
        {run.status === "active" && detail.can.cancel && (
          <Button size="sm" variant="outline" disabled={busy}
            onClick={() => void post(`/api/flows/${flow.id}/runs/cancel`, { run_id: run.id })}>
            <XCircle className="h-3.5 w-3.5" />
            {tRun("cancel")}
          </Button>
        )}
        {run.status === "failed" && !detail.replayable.ok && (
          <p className="text-xs text-amber-400" data-testid="replay-refusal">{tRun(`refusal.${detail.replayable.reason ?? "not_failed"}`)}</p>
        )}
      </div>

      <section className="mt-6">
        <h2 className="mb-2 text-sm font-semibold">{tRun("intentsTitle")}</h2>
        {detail.intents.length === 0 ? (
          <p className="text-xs text-muted-foreground">{tRun("noIntents")}</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-xs">
              <thead className="bg-muted/50 text-left text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">{tRun("colStep")}</th>
                  <th className="px-3 py-2 font-medium">{tRun("colKind")}</th>
                  <th className="px-3 py-2 font-medium">{tRun("colTransition")}</th>
                  <th className="px-3 py-2 font-medium">{tRun("colStatus")}</th>
                  <th className="px-3 py-2 font-medium">{tRun("colUpdated")}</th>
                </tr>
              </thead>
              <tbody>
                {detail.intents.map((intent, i) => (
                  <tr key={i} className="border-t border-border">
                    <td className="px-3 py-1.5"><code className="text-[10px]">{intent.node_key ?? "—"}{intent.part ? ` (${intent.part})` : ""}</code></td>
                    <td className="px-3 py-1.5 text-muted-foreground">{tRun(`kind.${intent.kind}`)}</td>
                    <td className="px-3 py-1.5 text-muted-foreground">{intent.seq ?? "—"}{intent.attempt !== null ? ` / ${intent.attempt}` : ""}</td>
                    <td className={cn("px-3 py-1.5 font-mono", INTENT_COLOR[intent.status] ?? "text-muted-foreground")}>
                      {intent.status}{intent.last_error ? ` · ${intent.last_error}` : ""}
                    </td>
                    <td className="px-3 py-1.5 text-muted-foreground">{format(new Date(intent.updated_at), "PP HH:mm:ss")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-[11px] text-muted-foreground">{tRun("intentsHelp")}</p>
      </section>

      <section className="mt-6">
        <h2 className="mb-2 text-sm font-semibold">{tRun("timelineTitle")}</h2>
        <div className="flex flex-col gap-1 rounded-lg border border-border bg-card p-2">
          {detail.events.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("noEvents")}</p>
          ) : (
            detail.events.map((ev, ix) => <EventLine key={ix} ev={ev} />)
          )}
        </div>
      </section>
    </div>
  );
}
