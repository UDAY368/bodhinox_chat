"use client";

/**
 * "Send products" from the inbox: one product, a list of up to 30 products in
 * sections, or the whole catalogue. Products come from the catalogue linked to
 * the conversation's number, which is also the number it sends from. The
 * server refuses a closed 24-hour window, a blocked contact or a number with
 * no catalogue; its message is shown as is.
 */

import { useEffect, useState } from "react";
import { Loader2, Plus, Send, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { COMMERCE_NODE_LIMITS as L } from "@/lib/flows/commerce-nodes";
import { cn } from "@/lib/utils";
import { sendProduct, sendRejectedDefinitely, type ProductPublic, type SendProductBody } from "./catalog-api";
import { ProductPicker } from "./product-picker";

export type SendProductKind = "product" | "product_list" | "catalog";

export interface DraftSection {
  title: string;
  products: { id: string; name: string }[];
}

/** The request body for the current draft, or null while something required is missing. */
export function draftBody(kind: SendProductKind, draft: {
  header: string; body: string; footer: string; single: string | null; thumbnail: string | null; sections: DraftSection[];
}): SendProductBody | null {
  const footer = draft.footer.trim() || undefined;
  if (kind === "product") return draft.single ? { kind, product_id: draft.single, body: draft.body.trim() || undefined, footer } : null;
  if (kind === "catalog") {
    return draft.body.trim() ? { kind, body: draft.body.trim(), footer, thumbnail_product_id: draft.thumbnail ?? undefined } : null;
  }
  const sections = draft.sections.filter((s) => s.products.length > 0);
  const total = sections.reduce((sum, s) => sum + s.products.length, 0);
  if (!draft.header.trim() || !draft.body.trim() || !sections.length || total > L.maxProducts) return null;
  if (sections.length > 1 && sections.some((s) => !s.title.trim())) return null;
  return {
    kind,
    header: draft.header.trim(),
    body: draft.body.trim(),
    footer,
    sections: sections.map((s) => ({ title: s.title.trim(), product_ids: s.products.map((p) => p.id) })),
  };
}

const blankSection = (): DraftSection => ({ title: "", products: [] });

export function SendProductDialog({ open, onOpenChange, conversationId }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
}) {
  const t = useTranslations("Commerce.catalog.sendDialog");
  const [kind, setKind] = useState<SendProductKind>("product");
  const [header, setHeader] = useState("");
  const [body, setBody] = useState("");
  const [footer, setFooter] = useState("");
  const [single, setSingle] = useState<string | null>(null);
  const [thumbnail, setThumbnail] = useState<string | null>(null);
  const [sections, setSections] = useState<DraftSection[]>([blankSection()]);
  const [sending, setSending] = useState(false);
  // One id per send: a double click or a retry after an unknown outcome never
  // sends twice; a definite refusal gets a new one.
  const [requestId, setRequestId] = useState("");

  useEffect(() => {
    if (open) setRequestId(crypto.randomUUID());
  }, [open]);

  const payload = draftBody(kind, { header, body, footer, single, thumbnail, sections });
  const total = sections.reduce((sum, s) => sum + s.products.length, 0);
  const ready = Boolean(payload && requestId) && !sending;

  const reset = () => {
    setHeader("");
    setBody("");
    setFooter("");
    setSingle(null);
    setThumbnail(null);
    setSections([blankSection()]);
  };

  const send = async () => {
    if (!payload || !ready) return;
    setSending(true);
    try {
      const res = await sendProduct(conversationId, requestId, payload);
      if (!res.ok) {
        if (sendRejectedDefinitely(res.status, res.code)) setRequestId(crypto.randomUUID());
        toast.error(res.error || t("failed"));
        return;
      }
      toast.success(t("sent"));
      reset();
      onOpenChange(false);
    } catch {
      toast.error(t("failed"));
    } finally {
      setSending(false);
    }
  };

  const toggleInSection = (index: number, product: ProductPublic) => {
    setSections((prev) => prev.map((s, i) => {
      const has = s.products.some((p) => p.id === product.id);
      if (i === index) return { ...s, products: has ? s.products.filter((p) => p.id !== product.id) : [...s.products, { id: product.id, name: product.name }] };
      // A product appears once per message: picking it here moves it from another section.
      return { ...s, products: s.products.filter((p) => p.id !== product.id) };
    }));
  };

  const field = "mb-1 block text-xs text-muted-foreground";
  const kinds: SendProductKind[] = ["product", "product_list", "catalog"];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div role="tablist" aria-label={t("kindLabel")} className="grid grid-cols-3 gap-1 rounded-md bg-muted p-1">
            {kinds.map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={kind === k}
                onClick={() => setKind(k)}
                className={cn("rounded px-2 py-1 text-xs", kind === k ? "bg-background text-foreground shadow-sm" : "text-muted-foreground")}
              >
                {t(`kinds.${k}`)}
              </button>
            ))}
          </div>

          {kind === "product_list" && (
            <div>
              <Label htmlFor="send-product-header" className={field}>{t("header", { max: L.header })}</Label>
              <Input id="send-product-header" value={header} maxLength={L.header} onChange={(e) => setHeader(e.target.value)} />
            </div>
          )}
          <div>
            <Label htmlFor="send-product-body" className={field}>
              {kind === "product" ? t("bodyOptional", { max: L.body }) : t("body", { max: L.body })}
            </Label>
            <Textarea id="send-product-body" value={body} maxLength={L.body} rows={3} onChange={(e) => setBody(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="send-product-footer" className={field}>{t("footer", { max: L.footer })}</Label>
            <Input id="send-product-footer" value={footer} maxLength={L.footer} onChange={(e) => setFooter(e.target.value)} />
          </div>

          {kind === "product" && (
            <div>
              <span className={field}>{t("product")}</span>
              <ProductPicker conversationId={conversationId} selected={single ? [single] : []} keyOf={(p) => p.id}
                onToggle={(p) => setSingle((cur) => (cur === p.id ? null : p.id))} />
            </div>
          )}

          {kind === "catalog" && (
            <div>
              <span className={field}>{t("thumbnail")}</span>
              <ProductPicker conversationId={conversationId} selected={thumbnail ? [thumbnail] : []} keyOf={(p) => p.id}
                onToggle={(p) => setThumbnail((cur) => (cur === p.id ? null : p.id))} />
            </div>
          )}

          {kind === "product_list" && (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">{t("listLimits", { products: L.maxProducts, sections: L.maxSections, count: total })}</p>
              {sections.map((section, index) => (
                <div key={index} className="space-y-2 rounded-md border border-border p-2">
                  <div className="flex items-end gap-2">
                    <div className="flex-1">
                      <Label htmlFor={`send-product-section-${index}`} className={field}>{t("sectionTitle", { max: L.sectionTitle })}</Label>
                      <Input id={`send-product-section-${index}`} value={section.title} maxLength={L.sectionTitle}
                        onChange={(e) => setSections((prev) => prev.map((s, i) => (i === index ? { ...s, title: e.target.value } : s)))} />
                    </div>
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={t("removeSection")} disabled={sections.length <= 1}
                      onClick={() => setSections((prev) => prev.filter((_, i) => i !== index))}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  {section.products.length > 0 && (
                    <p className="text-xs text-foreground">{section.products.map((p) => p.name).join(", ")}</p>
                  )}
                  <ProductPicker conversationId={conversationId} selected={section.products.map((p) => p.id)} keyOf={(p) => p.id}
                    disabled={total >= L.maxProducts} onToggle={(p) => toggleInSection(index, p)} />
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" disabled={sections.length >= L.maxSections}
                onClick={() => setSections((prev) => [...prev, blankSection()])}>
                <Plus className="h-3.5 w-3.5" />
                {t("addSection")}
              </Button>
            </div>
          )}
          <p className="text-xs text-muted-foreground">{t("windowHelp")}</p>
        </div>
        <DialogFooter>
          <Button onClick={() => void send()} disabled={!ready}>
            {sending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Send className="mr-1 h-4 w-4" />}
            {t("send")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
