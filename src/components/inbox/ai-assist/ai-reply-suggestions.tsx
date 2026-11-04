"use client";

// Suggested replies (Phase 13). Mounted above the composer when a member asks
// for suggestions. "Use" only puts the text into the composer: the member
// edits it and presses Send themselves; nothing is ever sent from here. A
// health or other sensitive question shows "route to qualified staff"
// instead of any text. Output is rendered as plain text.

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2, Sparkles, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { authFetch } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { reasonKey } from "./use-ai-assist";

export interface ReplyOptionView {
  suggestionId: string;
  text: string;
}

export interface CitationView {
  title: string | null;
  source_url: string | null;
}

export type SuggestionsState =
  | { kind: "loading" }
  | { kind: "options"; options: ReplyOptionView[]; citations: CitationView[] }
  | { kind: "route_to_staff"; categories: string[] }
  | { kind: "error"; reason: string | null };

const SAFE_URL = /^https?:\/\//i;

export function parseReplies(body: unknown): SuggestionsState {
  const b = body as {
    ok?: boolean; reason?: unknown; options?: unknown; citations?: unknown;
    routeToStaff?: { categories?: unknown } | null;
  } | null;
  if (!b || b.ok !== true) return { kind: "error", reason: typeof b?.reason === "string" ? b.reason : null };
  if (b.routeToStaff) {
    const categories = Array.isArray(b.routeToStaff.categories) ? b.routeToStaff.categories.filter((c): c is string => typeof c === "string") : [];
    return { kind: "route_to_staff", categories };
  }
  const options = (Array.isArray(b.options) ? b.options : [])
    .filter((o): o is ReplyOptionView => typeof o?.suggestionId === "string" && typeof o?.text === "string");
  const citations = (Array.isArray(b.citations) ? b.citations : [])
    .map((c) => ({ title: typeof c?.title === "string" ? c.title : null, source_url: typeof c?.source_url === "string" && SAFE_URL.test(c.source_url) ? c.source_url : null }))
    .filter((c) => c.title || c.source_url);
  return options.length ? { kind: "options", options, citations } : { kind: "error", reason: "invalid_output" };
}

/**
 * The panel after an option is dismissed; null when none is left (the
 * caller closes the panel rather than keep showing a rejected option).
 */
export function afterDismiss(state: SuggestionsState, suggestionId: string): SuggestionsState | null {
  if (state.kind !== "options") return state;
  const options = state.options.filter((o) => o.suggestionId !== suggestionId);
  return options.length ? { ...state, options } : null;
}

export function AiReplySuggestions({
  conversationId,
  onUse,
  onClose,
}: {
  conversationId: string;
  onUse: (option: ReplyOptionView) => void;
  onClose: () => void;
}) {
  const [state, setState] = useState<SuggestionsState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    authFetch("/api/ai/assist/replies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId, count: 3 }),
    })
      .then(async (res) => parseReplies(await res.json().catch(() => null)))
      .catch((): SuggestionsState => ({ kind: "error", reason: null }))
      .then((next) => { if (!cancelled) setState(next); });
    return () => { cancelled = true; };
  }, [conversationId]);

  const dismiss = useCallback((option: ReplyOptionView) => {
    const next = afterDismiss(state, option.suggestionId);
    if (next) setState(next);
    else onClose();
    void authFetch(`/api/ai/assist/suggestions/${option.suggestionId}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "rejected" }),
    }).catch(() => undefined);
  }, [state, onClose]);

  return <AiReplySuggestionsView state={state} onUse={onUse} onDismiss={dismiss} onClose={onClose} />;
}

export function AiReplySuggestionsView({
  state,
  onUse,
  onDismiss,
  onClose,
}: {
  state: SuggestionsState;
  onUse: (option: ReplyOptionView) => void;
  onDismiss: (option: ReplyOptionView) => void;
  onClose: () => void;
}) {
  const t = useTranslations("AiAssist");
  const tFallback = useTranslations("AiFallback");
  const message = (reason: string | null) => {
    const k = reasonKey(reason);
    return k.ns === "AiFallback" ? tFallback(k.key) : t(k.key);
  };

  return (
    <section aria-label={t("suggestionsTitle")} data-ai-suggestions className="bg-muted/40 relative mb-2 rounded-lg p-3 text-sm">
      <button type="button" aria-label={t("close")} onClick={onClose} className="text-muted-foreground hover:text-foreground absolute top-2 right-2">
        <X className="h-4 w-4" />
      </button>
      <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold">
        <Sparkles className="h-3.5 w-3.5" />
        {t("suggestionsTitle")}
      </p>
      {state.kind === "loading" && (
        <p className="text-muted-foreground flex items-center gap-2 text-xs">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t("loadingSuggestions")}
        </p>
      )}
      {state.kind === "error" && <p role="status" className="text-muted-foreground text-xs">{message(state.reason)}</p>}
      {state.kind === "route_to_staff" && (
        <div role="alert" className="rounded-md bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
          <p className="flex items-center gap-1.5 font-semibold">
            <AlertTriangle className="h-3.5 w-3.5" />
            {t("routeToStaffTitle")}
          </p>
          <p className="mt-1">{t("routeToStaffBody")}</p>
        </div>
      )}
      {state.kind === "options" && (
        <>
          <ul className="space-y-2">
            {state.options.map((option) => (
              <li key={option.suggestionId} className="bg-background border-border flex items-start gap-2 rounded-md border p-2">
                <p className="min-w-0 flex-1 whitespace-pre-wrap">{option.text}</p>
                <div className="flex shrink-0 gap-1">
                  <Button size="sm" variant="secondary" className="h-7 px-2 text-xs" onClick={() => onUse(option)}>{t("use")}</Button>
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => onDismiss(option)}>{t("dismiss")}</Button>
                </div>
              </li>
            ))}
          </ul>
          {state.citations.length > 0 && (
            <p className="text-muted-foreground mt-2 text-[11px]">
              {t("sources")}{" "}
              {state.citations.map((c, i) => (
                <span key={i}>
                  {i > 0 && ", "}
                  {c.source_url
                    ? <a href={c.source_url} target="_blank" rel="noopener noreferrer nofollow" className="underline">{c.title || c.source_url}</a>
                    : c.title}
                </span>
              ))}
            </p>
          )}
          <p className="text-muted-foreground mt-1 text-[11px]">{t("reviewBeforeSending")}</p>
        </>
      )}
    </section>
  );
}
