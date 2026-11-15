"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { FileText, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { validateGstin } from "@/lib/billing/gst";
import {
  documentUrl, getOrderTaxInvoice, issueOrderTaxInvoice, saveOrderBuyerTax, type ApiResult, type OrderDetail, type OrderTaxInvoiceState,
} from "./order-api";

/**
 * GST tax invoice: the buyer's GSTIN and legal name (editable until the invoice
 * exists), the invoice link once issued, and "Issue tax invoice". Without a
 * GSTIN in store settings no invoice can be issued, and the panel says so.
 * The server re-checks the GSTIN and every rule.
 */
export function OrderTaxInvoicePanel({ order, canAct, onChanged }: { order: OrderDetail; canAct: boolean; onChanged: () => Promise<void> }) {
  const t = useTranslations("Commerce.orders.taxInvoice");
  const [state, setState] = useState<OrderTaxInvoiceState | null>(null);
  const [gstin, setGstin] = useState("");
  const [legalName, setLegalName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const apply = useCallback((s: OrderTaxInvoiceState) => {
    setState(s);
    setGstin(s.buyer_gstin ?? "");
    setLegalName(s.buyer_legal_name ?? "");
  }, []);

  useEffect(() => {
    let live = true;
    void getOrderTaxInvoice(order.id).then((r) => { if (live && r.ok) apply(r.value); });
    return () => { live = false; };
  }, [order.id, apply]);

  if (!state || order.priced_at === null) return null;
  const locked = state.document_id !== null;
  const invalid = gstin.trim() !== "" && validateGstin(gstin) === null;
  const changed = gstin.trim().toUpperCase() !== (state.buyer_gstin ?? "") || legalName.trim() !== (state.buyer_legal_name ?? "");

  async function run<T>(key: string, call: () => Promise<ApiResult<T>>, success: string, then?: (value: T) => void) {
    setBusy(key);
    try {
      const r = await call();
      if (!r.ok) {
        toast.error(r.code === "invalid_gstin" ? t("invalid") : r.code === "invoice_issued" ? t("locked") : r.code === "seller_gstin_missing" ? t("sellerMissing")
          : r.code === "buyer_gstin_missing" ? t("buyerMissing") : r.code === "bad_transition" ? t("notYet") : r.status === 403 ? t("forbidden") : t("error"));
        return;
      }
      toast.success(success);
      then?.(r.value);
      const fresh = await getOrderTaxInvoice(order.id);
      if (fresh.ok) apply(fresh.value);
      await onChanged();
    } catch {
      toast.error(t("error"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2 rounded-xl border border-border bg-card p-4">
      <h2 className="text-sm font-medium text-foreground">{t("title")}</h2>
      {!state.seller_gstin_configured && <p className="text-xs text-muted-foreground">{t("sellerMissing")}</p>}
      <div className="space-y-1">
        <Label htmlFor="order-buyer-gstin">{t("gstin")}</Label>
        <Input id="order-buyer-gstin" value={gstin} maxLength={15} autoComplete="off" disabled={!canAct || locked || busy !== null}
          aria-invalid={invalid} onChange={(e) => setGstin(e.target.value.toUpperCase())} />
        {invalid && <p className="text-xs text-destructive" role="alert">{t("invalid")}</p>}
      </div>
      <div className="space-y-1">
        <Label htmlFor="order-buyer-legal-name">{t("legalName")}</Label>
        <Input id="order-buyer-legal-name" value={legalName} maxLength={200} autoComplete="off" disabled={!canAct || locked || busy !== null || !gstin.trim()}
          onChange={(e) => setLegalName(e.target.value)} />
      </div>
      {locked ? (
        <a href={documentUrl(state.document_id!)} target="_blank" rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
          <FileText className="h-4 w-4" /> {t("open")}
        </a>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={!canAct || busy !== null || invalid || !changed}
            onClick={() => run("save", () => saveOrderBuyerTax(order.id, { gstin: gstin.trim() || null, legal_name: legalName.trim() || null }), t("saved"))}>
            {busy === "save" && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("save")}
          </Button>
          <Button size="sm" disabled={!canAct || busy !== null || !state.buyer_gstin || changed || !state.seller_gstin_configured}
            onClick={() => run("issue", () => issueOrderTaxInvoice(order.id), t("issued"))}>
            {busy === "issue" && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("issue")}
          </Button>
        </div>
      )}
    </div>
  );
}
