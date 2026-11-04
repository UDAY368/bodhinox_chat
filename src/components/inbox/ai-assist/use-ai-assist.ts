"use client";

// Which AI assistant features the signed-in member can use (summaries and
// suggested replies). Workspace-level, so it is fetched once per mount; a
// failure or a 403 (role restricted) reads as "nothing available".

import { useEffect, useState } from "react";
import { authFetch } from "@/lib/auth/client";

export interface AssistFeatureState {
  ok: boolean;
  reason: string | null;
}

export interface AssistAvailability {
  summary: AssistFeatureState;
  suggest: AssistFeatureState;
}

export const NO_ASSIST: AssistAvailability = {
  summary: { ok: false, reason: null },
  suggest: { ok: false, reason: null },
};

export function parseAvailability(body: unknown): AssistAvailability {
  const value = body as Partial<Record<"summary" | "suggest", Partial<AssistFeatureState>>> | null;
  const feature = (f: Partial<AssistFeatureState> | undefined): AssistFeatureState =>
    ({ ok: f?.ok === true, reason: typeof f?.reason === "string" ? f.reason : null });
  return { summary: feature(value?.summary), suggest: feature(value?.suggest) };
}

/** null while loading; NO_ASSIST when unavailable or the request failed. */
export function useAssistAvailability(enabled: boolean): AssistAvailability | null {
  const [state, setState] = useState<AssistAvailability | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    authFetch("/api/ai/assist/availability", { cache: "no-store" })
      .then(async (res) => (res.ok ? parseAvailability(await res.json()) : NO_ASSIST))
      .catch(() => NO_ASSIST)
      .then((value) => { if (!cancelled) setState(value); });
    return () => { cancelled = true; };
  }, [enabled]);
  return enabled ? state : NO_ASSIST;
}

/** The message key for a fallback or error reason (AiFallback.<reason> or AiAssist.errors.<reason>). */
export function reasonKey(reason: string | null | undefined): { ns: "AiFallback" | "AiAssist"; key: string } {
  const fallback = ["deployment_off", "not_configured", "feature_off", "no_permission", "quota", "timeout", "provider_error", "invalid_output", "guard_blocked"];
  if (reason && fallback.includes(reason)) return { ns: "AiFallback", key: reason };
  if (reason === "not_found") return { ns: "AiAssist", key: "errors.notFound" };
  if (reason === "no_messages") return { ns: "AiAssist", key: "errors.noMessages" };
  return { ns: "AiAssist", key: "errors.failed" };
}
