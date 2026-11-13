"use client";

// Translation in the inbox composer (AI page > Assistant features >
// Translation). On request only: the customer's latest messages shown in the
// team language (staff only), and the member's draft rewritten in the
// customer's language, put back into the box for the member to check and send.
// POST /api/ai/assist/translate; availability from GET on the same route.
// Nothing is sent or stored here.

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Languages, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { authFetch } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { reasonKey } from "./use-ai-assist";

export interface TranslateState {
  /** Translation is on for the workspace and this member may use it. */
  available: boolean;
  language: string | null;
  busy: boolean;
  incoming: { text: string; language: string | null } | null;
  translateIncoming: () => Promise<void>;
  translateDraft: (draft: string) => Promise<string | null>;
  clear: () => void;
}

/** Translation for one conversation (the state resets when the conversation changes). */
export function useAiTranslate(conversationId: string, enabled: boolean): TranslateState {
  const t = useTranslations("AiStudio.translate");
  const tf = useTranslations("AiFallback");
  const ta = useTranslations("AiAssist");
  const [availability, setAvailability] = useState<{ ok: boolean; language: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [incoming, setIncoming] = useState<{ id: string; text: string; language: string | null } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    authFetch("/api/ai/assist/translate", { cache: "no-store" })
      .then(async (res) => (res.ok ? res.json() : null))
      .catch(() => null)
      .then((data) => { if (!cancelled) setAvailability({ ok: data?.ok === true, language: typeof data?.language === "string" ? data.language : null }); });
    return () => { cancelled = true; };
  }, [enabled]);

  const explain = useCallback((reason: unknown) => {
    const key = reasonKey(typeof reason === "string" ? reason : null);
    toast.error(key.ns === "AiFallback" ? tf(key.key) : ta(key.key));
  }, [tf, ta]);

  const call = useCallback(async (body: Record<string, unknown>): Promise<{ text: string; language: string | null } | null> => {
    setBusy(true);
    try {
      const res = await authFetch("/api/ai/assist/translate", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId, ...body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok !== true) { explain(data.reason); return null; }
      return { text: String(data.text ?? ""), language: typeof data.language === "string" ? data.language : null };
    } catch {
      toast.error(t("failed"));
      return null;
    } finally {
      setBusy(false);
    }
  }, [conversationId, explain, t]);

  const translateIncoming = useCallback(async () => {
    const result = await call({ direction: "incoming" });
    if (result) setIncoming({ id: conversationId, ...result });
  }, [call, conversationId]);

  const translateDraft = useCallback(async (draft: string) => {
    if (!draft.trim()) { toast.error(t("needText")); return null; }
    const result = await call({ direction: "outgoing", text: draft.trim() });
    if (result) toast.success(t("replaced"));
    return result?.text ?? null;
  }, [call, t]);

  return {
    available: enabled && availability?.ok === true,
    language: availability?.language ?? null,
    busy,
    // A translation belongs to the conversation it was made for.
    incoming: incoming && incoming.id === conversationId ? { text: incoming.text, language: incoming.language } : null,
    translateIncoming,
    translateDraft,
    clear: () => setIncoming(null),
  };
}

/** The Translate menu: the customer's messages, or the member's draft. */
export function TranslateMenu({ state, draft, onDraft, className }: {
  state: TranslateState;
  draft: string;
  onDraft: (text: string) => void;
  className?: string;
}) {
  const t = useTranslations("AiStudio.translate");
  if (!state.available) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label={t("button")} title={t("button")} disabled={state.busy}
        className={className ?? "inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-150 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"}>
        {state.busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Languages className="size-4" aria-hidden />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => void state.translateIncoming()}>{t("incoming")}</DropdownMenuItem>
        <DropdownMenuItem disabled={!draft.trim()} onClick={async () => { const text = await state.translateDraft(draft); if (text) onDraft(text); }}>
          {t("outgoing")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The customer's messages in the team language, above the composer (staff only). */
export function TranslationPanel({ state }: { state: TranslateState }) {
  const t = useTranslations("AiStudio.translate");
  const tl = useTranslations("AiStudio.languages");
  if (!state.incoming) return null;
  const language = state.incoming.language;
  return (
    <div className="mb-2 flex items-start gap-2 rounded-xl border border-border bg-card px-3.5 py-2.5 text-sm" role="status">
      <Languages className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-muted-foreground">{language ? t("panelTitle", { language: tl(language) }) : t("panelTitleAny")}</p>
        <p className="whitespace-pre-wrap break-words">{state.incoming.text}</p>
      </div>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={t("close")} onClick={state.clear}><X aria-hidden /></Button>
    </div>
  );
}
