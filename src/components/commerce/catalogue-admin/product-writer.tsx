"use client";

/**
 * "Write description" in the product editor (store plan Phase 8, batch 6): the product's name, a few facts (one per line) and a tone
 * go to the workspace's AI provider; the answer is shown as a DRAFT below the field. Nothing is saved and the description is only
 * replaced when the staff member presses "Use this draft"; they still press Save on the product themselves. The request carries
 * no customer data, and it counts as one AI message against the plan.
 */
import { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { authFetch } from "@/lib/auth/client";
import { WRITER_LIMITS, WRITER_TONES, type WriterTone } from "@/lib/ai/product-writer-limits";
import { OptionSelect } from "@/components/ui/option-select";

export function ProductWriter({ name, onUse }: { name: string; onUse: (text: string) => void }) {
  const t = useTranslations("Commerce.catalogue.editor.writer");
  const [open, setOpen] = useState(false);
  const [facts, setFacts] = useState("");
  const [tone, setTone] = useState<WriterTone>("friendly");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);

  const attributes = facts.split("\n").map((l) => l.trim()).filter(Boolean);
  const tooMany = attributes.length > WRITER_LIMITS.attributes || attributes.some((a) => a.length > WRITER_LIMITS.attribute);

  const write = async () => {
    setBusy(true);
    const res = await authFetch("/api/commerce/product-writer", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, attributes, tone }),
    }).catch(() => null);
    setBusy(false);
    const data = (await res?.json().catch(() => ({}))) as { description?: string; code?: string };
    if (!res?.ok || !data.description) {
      const known = ["ai_not_configured", "invalid", "ai_disabled"];
      toast.error(t(`errors.${known.includes(data.code ?? "") ? data.code : res?.status === 429 || res?.status === 402 ? "limit" : "generic"}` as never));
      return;
    }
    setDraft(data.description);
  };

  if (!open) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)} disabled={!name.trim()}>
        <Sparkles className="size-4" />{t("open")}
      </Button>
    );
  }
  return (
    <div className="space-y-2 rounded-lg border border-dashed border-border p-3">
      <div className="space-y-1">
        <Label htmlFor="pw-facts">{t("facts")}</Label>
        <Textarea id="pw-facts" rows={3} value={facts} onChange={(e) => setFacts(e.target.value)} placeholder={t("factsPlaceholder")} />
        <p className="text-xs text-muted-foreground">{t("factsHint", { max: WRITER_LIMITS.attributes })}</p>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="pw-tone">{t("tone")}</Label>
          <OptionSelect fit
            id="pw-tone"
            value={tone}
            onValueChange={(v) => setTone(v as WriterTone)}
            options={[
              ...WRITER_TONES.map((v) => ({ value: v, label: t(`tones.${v}`) })),
            ]}
          />
        </div>
        <Button type="button" size="sm" onClick={write} disabled={busy || !name.trim() || tooMany}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}{t("write")}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => { setOpen(false); setDraft(null); }}>{t("close")}</Button>
      </div>
      <p className="text-xs text-muted-foreground">{t("privacy")}</p>
      {draft !== null && (
        <div className="space-y-2 rounded-lg bg-muted/50 p-3">
          <p className="text-xs font-medium text-muted-foreground">{t("draftLabel")}</p>
          <Textarea aria-label={t("draftLabel")} rows={5} value={draft} maxLength={WRITER_LIMITS.description} onChange={(e) => setDraft(e.target.value)} />
          <div className="flex gap-2">
            <Button type="button" size="sm" onClick={() => { onUse(draft); setDraft(null); }}>{t("use")}</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setDraft(null)}>{t("discard")}</Button>
          </div>
        </div>
      )}
    </div>
  );
}
