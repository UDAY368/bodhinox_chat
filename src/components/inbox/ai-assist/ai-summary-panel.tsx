"use client";

// AI conversation summary for staff (Phase 13). Shown only when the
// workspace turned summaries on and the member may use them. The output is
// staff-facing text, rendered as plain text (never HTML or markdown), and is
// never sent to the customer.

import { useCallback, useState } from "react";
import { AlertTriangle, FileText, Loader2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { authFetch } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { reasonKey } from "./use-ai-assist";

export interface SummaryView {
  summary: string;
  openQuestions: string[];
  nextSteps: string[];
  dataAsOf: string;
  sensitive: string[];
}

type PanelState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "done"; view: SummaryView }
  | { kind: "error"; reason: string | null };

export function parseSummary(body: unknown): SummaryView | null {
  const b = body as Partial<SummaryView> & { ok?: boolean } | null;
  if (!b || b.ok !== true || typeof b.summary !== "string") return null;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return {
    summary: b.summary,
    openQuestions: list(b.openQuestions),
    nextSteps: list(b.nextSteps),
    dataAsOf: typeof b.dataAsOf === "string" ? b.dataAsOf : "",
    sensitive: list(b.sensitive),
  };
}

export function AiSummaryPanel({ conversationId }: { conversationId: string }) {
  const [state, setState] = useState<PanelState>({ kind: "idle" });

  const run = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const res = await authFetch("/api/ai/assist/summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId }),
      });
      const body = await res.json().catch(() => null);
      const view = parseSummary(body);
      setState(view ? { kind: "done", view } : { kind: "error", reason: typeof body?.reason === "string" ? body.reason : null });
    } catch {
      setState({ kind: "error", reason: null });
    }
  }, [conversationId]);

  return <AiSummaryPanelView state={state} onRun={run} onClose={() => setState({ kind: "idle" })} />;
}

export function AiSummaryPanelView({ state, onRun, onClose }: { state: PanelState; onRun: () => void; onClose: () => void }) {
  const t = useTranslations("AiAssist");
  const tFallback = useTranslations("AiFallback");
  const message = (reason: string | null) => {
    const k = reasonKey(reason);
    return k.ns === "AiFallback" ? tFallback(k.key) : t(k.key);
  };

  return (
    <div className="border-border border-t px-4 py-2" data-ai-summary>
      {state.kind !== "done" && (
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs" disabled={state.kind === "loading"} onClick={onRun}>
            {state.kind === "loading" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
            {state.kind === "loading" ? t("summarizing") : t("summarize")}
          </Button>
          {state.kind === "error" && <p role="status" className="text-muted-foreground text-xs">{message(state.reason)}</p>}
        </div>
      )}
      {state.kind === "done" && (
        <section aria-label={t("summaryTitle")} className="bg-muted/40 relative rounded-lg p-3 text-sm">
          <button type="button" aria-label={t("close")} onClick={onClose} className="text-muted-foreground hover:text-foreground absolute top-2 right-2">
            <X className="h-4 w-4" />
          </button>
          <p className="mb-1 text-xs font-semibold">{t("summaryTitle")}</p>
          {state.view.sensitive.length > 0 && (
            <p role="alert" className="mb-2 flex items-start gap-1.5 rounded-md bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {t("sensitiveBanner")}
            </p>
          )}
          <p className="whitespace-pre-wrap">{state.view.summary}</p>
          {state.view.openQuestions.length > 0 && (
            <>
              <p className="mt-2 text-xs font-semibold">{t("openQuestions")}</p>
              <ul className="list-disc pl-5">{state.view.openQuestions.map((q, i) => <li key={i}>{q}</li>)}</ul>
            </>
          )}
          {state.view.nextSteps.length > 0 && (
            <>
              <p className="mt-2 text-xs font-semibold">{t("nextSteps")}</p>
              <ul className="list-disc pl-5">{state.view.nextSteps.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </>
          )}
          <p className="text-muted-foreground mt-2 text-[11px]">
            {t("reviewNote")}
            {state.view.dataAsOf && <> {t("dataAsOf", { time: new Date(state.view.dataAsOf).toLocaleString() })}</>}
          </p>
        </section>
      )}
    </div>
  );
}
