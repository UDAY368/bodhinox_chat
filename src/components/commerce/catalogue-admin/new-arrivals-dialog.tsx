"use client";

/**
 * "Send as new arrivals": pick an approved carousel template whose card count
 * matches the chosen products, an audience, and start the campaign. The server
 * (POST /api/commerce/new-arrivals) fills the cards and creates the campaign
 * through the same path as the broadcast wizard; this dialog only collects the
 * choices.
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fetchLists, fetchSegments, type ListSummary, type SegmentSummary } from "@/lib/audience/client";
import { createClient } from "@/lib/data/client";
import { templateSendNeeds } from "@/lib/whatsapp/template-send-params";
import { templateKindOf } from "@/lib/whatsapp/template-validators";
import type { MessageTemplate } from "@/types";
import { sendNewArrivals } from "./catalogue-api";
import { OptionSelect } from "@/components/ui/option-select";
import { SegmentedControl } from "@/components/ui/segmented-control";

type AudienceKind = "all" | "segment" | "list";

export function NewArrivalsDialog({ open, onOpenChange, productIds, onDone }: {
  open: boolean; onOpenChange: (open: boolean) => void; productIds: string[]; onDone: () => void;
}) {
  const t = useTranslations("Commerce.catalogue.newArrivals");
  const [templates, setTemplates] = useState<MessageTemplate[] | null>(null);
  const [segments, setSegments] = useState<SegmentSummary[]>([]);
  const [lists, setLists] = useState<ListSummary[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [kind, setKind] = useState<AudienceKind>("all");
  const [targetId, setTargetId] = useState("");
  const [name, setName] = useState(() => t("defaultName"));
  const [values, setValues] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    createClient().from("message_templates").select("*").eq("status", "APPROVED").order("created_at", { ascending: false })
      .then(({ data }: { data: MessageTemplate[] | null }) => setTemplates((data ?? []).filter((x) => templateKindOf(x) === "carousel")), () => setTemplates([]));
    fetchSegments().then(setSegments).catch(() => setSegments([]));
    fetchLists().then(setLists).catch(() => setLists([]));
  }, [open]);

  const usable = useMemo(() => (templates ?? []).filter((x) => (x.cards?.length ?? 0) === productIds.length), [templates, productIds.length]);
  const template = usable.find((x) => x.id === templateId) ?? null;
  const topVars = template ? templateSendNeeds(template).bodyVars : [];
  const bodyValues = topVars.map((n) => values[n] ?? "");

  const audienceReady = kind === "all" || !!targetId;
  const ready = !!template && !!name.trim() && audienceReady && bodyValues.every((v) => v.trim());

  async function submit() {
    if (!template) return;
    setBusy(true); setError(null);
    const audience = kind === "all" ? { type: "all" } : kind === "segment" ? { type: "segment", segmentId: targetId } : { type: "list", listId: targetId };
    const r = await sendNewArrivals({ name: name.trim(), templateId: template.id, productIds, audience, bodyValues: topVars.length ? bodyValues.map((v) => v.trim()) : undefined });
    setBusy(false);
    if (!r.ok) { setError(r.error || t("failed")); return; }
    toast.success(t("started"));
    onOpenChange(false);
    onDone();
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent size="md" className="w-full gap-0">
        <SheetHeader>
          <SheetTitle>{t("title")}</SheetTitle>
          <SheetDescription>{t("description", { count: productIds.length })}</SheetDescription>
        </SheetHeader>
        <div className="flex-1 space-y-4 overflow-y-auto px-4 pb-4">
        {templates === null ? (
          <div className="flex justify-center p-4"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label={t("loading")} /></div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="na-template">{t("template")}</Label>
              <OptionSelect fit
                id="na-template"
                value={templateId}
                onValueChange={(v) => setTemplateId(v)}
                options={[
                  { value: "", label: t("choose") },
                  ...usable.map((x) => ({ value: x.id, label: x.name })),
                ]}
              />
              {usable.length === 0 && <p className="text-xs text-muted-foreground">{t("noTemplates", { count: productIds.length })}</p>}
            </div>
            {topVars.map((n) => (
              <div key={n} className="space-y-1.5">
                <Label htmlFor={`na-var-${n}`}>{t("messageValue", { n })}</Label>
                <Input id={`na-var-${n}`} value={values[n] ?? ""} maxLength={1024}
                  onChange={(e) => setValues((v) => ({ ...v, [n]: e.target.value }))} />
              </div>
            ))}
            <div className="space-y-1.5">
              <Label>{t("audience")}</Label>
              <SegmentedControl
                aria-label={t("audience")}
                value={kind}
                onValueChange={(v) => { setKind(v as AudienceKind); setTargetId(""); }}
                options={[
                  { value: "all", label: t("audAll") },
                  { value: "segment", label: t("audSegment") },
                  { value: "list", label: t("audList") },
                ]}
              />
              {kind !== "all" && (
                <OptionSelect fit
                  aria-label={t("audience")}
                  value={targetId}
                  onValueChange={(v) => setTargetId(v)}
                  options={[
                    { value: "", label: t("choose") },
                    ...(kind === "segment" ? segments : lists).map((x) => ({ value: x.id, label: x.name })),
                  ]}
                />
              )}
              <p className="text-xs text-muted-foreground">{t("consentNote")}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="na-name">{t("campaignName")}</Label>
              <Input id="na-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
            </div>
            <p className="text-xs text-muted-foreground">{t("orderNote")}</p>
            {error && <p role="alert" className="rounded-lg bg-destructive/10 p-2 text-sm text-destructive">{error}</p>}
          </div>
        )}
        </div>
        <SheetFooter className="border-t border-border sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
          <Button disabled={!ready || busy} onClick={() => void submit()}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} {t("send")}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
