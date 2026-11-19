"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { parseTags, TAG_LIMITS } from "@/lib/commerce/order-tags";
import { updateOrder } from "./order-api";

/** The order's internal tags: chips with a remove button, and one field to add. Staff only; never shown to the customer. */
export function OrderTags({ orderId, tags, canEdit, onSaved }: {
  orderId: string;
  tags: string[];
  canEdit: boolean;
  onSaved: (tags: string[]) => void;
}) {
  const t = useTranslations("Commerce.orders.tags");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  async function save(next: string[]) {
    setBusy(true);
    try {
      const r = await updateOrder(orderId, { tags: next });
      if (!r.ok) {
        toast.error(r.status === 400 ? t("invalid") : t("saveError"));
        return;
      }
      onSaved(r.value.tags ?? next);
      setDraft("");
    } catch {
      toast.error(t("saveError"));
    } finally {
      setBusy(false);
    }
  }

  function add() {
    if (!draft.trim()) return;
    const next = parseTags([...tags, draft]);
    if (!next) toast.error(t("invalid"));
    else if (next.length !== tags.length) void save(next);
    else setDraft("");
  }

  return (
    <div className="space-y-2 rounded-xl border border-border bg-card p-4">
      <Label htmlFor="order-tag">{t("label")}</Label>
      {tags.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <li key={tag} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-foreground">
              {tag}
              {canEdit && (
                <button type="button" disabled={busy} aria-label={t("remove", { tag })} className="rounded-full text-muted-foreground hover:text-foreground"
                  onClick={() => void save(tags.filter((x) => x !== tag))}>
                  <X className="h-3 w-3" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && tags.length < TAG_LIMITS.maxTags && (
        <div className="flex gap-2">
          <Input id="order-tag" value={draft} maxLength={TAG_LIMITS.maxLength} placeholder={t("placeholder")} disabled={busy}
            onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
          <Button type="button" size="icon-sm" variant="outline" aria-label={t("add")} disabled={busy || !draft.trim()} onClick={add}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      )}
      <p className="text-xs text-muted-foreground">{t("help")}</p>
    </div>
  );
}
