"use client";

/**
 * Flow-wide settings in the editor's Settings popover: what an off-script
 * reply does, the default fallback message sent with it, and the test
 * numbers a draft runs for.
 */

import { useState } from "react";
import { Loader2, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { resolveFallbackPolicy } from "@/lib/flows/fallback";
import type { FallbackMessage, FlowRow } from "@/lib/flows/types";
import { uploadAccountMedia } from "@/lib/storage/upload-media";
import { useFlowEditor } from "./flow-editor-state";
import { FLOW_MEDIA_BUCKET, MEDIA_ACCEPT } from "./forms/node-config-form";

const label = "mb-1 block text-xs text-muted-foreground";
const help = "mt-1 text-[10px] text-muted-foreground";

export function FlowSettings() {
  const { state, setState } = useFlowEditor();
  const t = useTranslations("Flows.menuFallback");
  const policy = state.fallback_policy as FlowRow["fallback_policy"];
  const message = (policy.fallback_message ?? { text: "" }) as FallbackMessage;
  const [uploading, setUploading] = useState(false);
  const [numbers, setNumbers] = useState((state.test_numbers ?? []).join(", "));

  // Built from the latest state, so an upload finishing late keeps text typed meanwhile.
  const setMessage = (patch: Partial<FallbackMessage>) =>
    setState((s) => {
      const next = { ...((s.fallback_policy.fallback_message ?? { text: "" }) as FallbackMessage), ...patch };
      // An empty message is no message: store nothing rather than an invalid one.
      const empty = !next.text?.trim() && !next.media_url;
      return { ...s, fallback_policy: { ...s.fallback_policy, fallback_message: empty ? undefined : next } };
    });

  const upload = async (file: File, kind: "image" | "video") => {
    setUploading(true);
    try {
      const { publicUrl } = await uploadAccountMedia(FLOW_MEDIA_BUCKET, file);
      setMessage({ media_type: kind, media_url: publicUrl });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("uploadFailed"));
    } finally {
      setUploading(false);
    }
  };

  const commitNumbers = () => {
    const list = numbers.split(/[,\n]/).map((n) => n.replace(/\D/g, "")).filter(Boolean).slice(0, 3);
    setNumbers(list.join(", "));
    setState((s) => ({ ...s, test_numbers: list }));
  };

  return (
    <div className="space-y-4 px-6 py-2 text-sm">
      <div>
        <label className="flex flex-wrap items-center gap-2">
          <span>{t("label")}</span>
          <select className="rounded border border-border bg-card px-2 py-1" value={resolveFallbackPolicy(policy).on_unknown_reply}
            onChange={(event) => setState((previous) => ({ ...previous, fallback_policy: { ...previous.fallback_policy,
              on_unknown_reply: event.target.value as FlowRow["fallback_policy"]["on_unknown_reply"],
            } }))}>
            <option value="reprompt">{t("reprompt")}</option>
            <option value="handoff">{t("handoff")}</option>
            <option value="ignore">{t("ignore")}</option>
            <option value="ai">{t("ai")}</option>
          </select>
        </label>
        <p className="mt-1 text-xs text-muted-foreground">{t("help")}</p>
      </div>

      <div>
        <label htmlFor="fallback-text" className={label}>{t("messageLabel")}</label>
        <Textarea id="fallback-text" rows={2} value={message.text ?? ""} maxLength={1024}
          onChange={(e) => setMessage({ text: e.target.value })} className="bg-muted text-xs" />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {message.media_url ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs">
              {t(message.media_type === "video" ? "videoAttached" : "imageAttached")}
              <button type="button" aria-label={t("removeMedia")} onClick={() => setMessage({ media_type: undefined, media_url: undefined })}>
                <X className="size-3" />
              </button>
            </span>
          ) : (
            (["image", "video"] as const).map((kind) => (
              <label key={kind} className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border px-2 py-1 text-xs">
                {uploading ? <Loader2 className="size-3 animate-spin" /> : <Upload className="size-3" />}
                {t(kind === "image" ? "addImage" : "addVideo")}
                <input type="file" className="sr-only" accept={MEDIA_ACCEPT[kind]} disabled={uploading}
                  onChange={(e) => { const file = e.target.files?.[0]; if (file) void upload(file, kind); e.target.value = ""; }} />
              </label>
            ))
          )}
        </div>
        <p className={help}>{t("messageHelp")}</p>
      </div>

      {state.status === "draft" && (
        <div>
          <label htmlFor="test-numbers" className={label}>{t("testNumbersLabel")}</label>
          <Input id="test-numbers" value={numbers} placeholder="919876543210, 14155550100"
            onChange={(e) => setNumbers(e.target.value)} onBlur={commitNumbers}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitNumbers(); } }}
            className="bg-muted font-mono text-xs" />
          <p className={help}>{t("testNumbersHelp")}</p>
          {(state.test_numbers ?? []).length > 0 && (
            <Button type="button" variant="ghost" size="sm" className="mt-1 h-7 px-2 text-xs"
              onClick={() => { setNumbers(""); setState((s) => ({ ...s, test_numbers: [] })); }}>
              {t("stopTesting")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
