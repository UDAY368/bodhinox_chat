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
import { ArrowLeft, Loader2, RotateCcw, SearchX, XCircle } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { GroupedList } from "@/components/ui/grouped-list";
import { InlineError } from "@/components/ui/inline-error";
import { PageHeader } from "@/components/ui/page-header";
import { PageLoading } from "@/components/ui/page-loading";
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
  const [loadFailed, setLoadFailed] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  const confirm = useConfirm();

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
    setLoadFailed(false);
    load()
      .catch((err) => {
        console.error(err);
        setLoadFailed(true);
      })
      .finally(() => setLoading(false));
  }, [params.id, params.runId, load, retryToken]);

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
    return <div className="mx-auto max-w-4xl p-6"><PageLoading /></div>;
  }
  if (loadFailed && !notFound) {
    return (
      <InlineError
        message={t("loadError")}
        onRetry={() => {
          setLoading(true);
          setRetryToken((n) => n + 1);
        }}
      />
    );
  }
  if (notFound || !detail) {
    return (
      <EmptyState
        icon={SearchX}
        title={tEdit("notFound")}
        action={<Button variant="outline" onClick={() => router.push(`/flows/${params.id}/runs`)}>{tRun("backToRuns")}</Button>}
      />
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
      <PageHeader
        className="mb-4"
        title={contactLabel}
        subtitle={
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className={cn("gap-1", meta.classes)}>
                <StatusIcon className="h-3 w-3" />
                {t(runStatusKey(run.status))}
              </Badge>
              <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {run.version ? t("versionLabel", { version: run.version }) : t("unversioned")}
              </span>
            </div>
            <p className="text-xs">
              {t("started", { time: format(new Date(run.started_at), "PP p") })}
              {run.end_reason ? ` · ${tRun("endReason", { reason: run.end_reason })}` : ""}
              {detail.failed_node ? ` · ${tRun("failedAt", { node: detail.failed_node })}` : ""}
            </p>
          </div>
        }
        primaryAction={
          run.status === "failed" && detail.can.replay ? (
            <Button disabled={busy || !detail.replayable.ok}
              title={detail.replayable.ok ? undefined : tRun(`refusal.${detail.replayable.reason ?? "not_failed"}`)}
              onClick={() => void post(`/api/flows/${flow.id}/runs/${run.id}/replay`)}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
              {tRun("replay")}
            </Button>
          ) : run.status === "active" && detail.can.cancel ? (
            <Button variant="outline" disabled={busy}
              onClick={async () => {
                if (await confirm({ title: tRun("cancelConfirm"), confirmLabel: tRun("cancel"), destructive: true })) {
                  void post(`/api/flows/${flow.id}/runs/cancel`, { run_id: run.id });
                }
              }}>
              <XCircle className="h-3.5 w-3.5" />
              {tRun("cancel")}
            </Button>
          ) : undefined
        }
      />
      {run.status === "failed" && !detail.replayable.ok && (
        <p className="-mt-2 mb-4 text-xs text-amber-400" data-testid="replay-refusal">{tRun(`refusal.${detail.replayable.reason ?? "not_failed"}`)}</p>
      )}

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
        <GroupedList>
          <div className="flex flex-col gap-1 p-2">
            {detail.events.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("noEvents")}</p>
            ) : (
              detail.events.map((ev, ix) => <EventLine key={ix} ev={ev} />)
            )}
          </div>
        </GroupedList>
      </section>
    </div>
  );
}
