"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { CheckCircle2, CircleAlert, ExternalLink, Loader2 } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { bulkDispatch, type BulkResult } from "./orders-list-api";

export interface BulkOrder { id: string; ref: string }

const SHIPMENT_CODES = new Set([
  "not_connected", "not_configured", "auth", "provider_unreachable", "order_not_paid", "shipment_exists", "refund_in_flight",
  "order_refunded", "address_incomplete", "not_found", "conflict", "invalid", "throttled", "feature_unavailable", "over_shipped", "pickup_order",
]);

/**
 * Create courier shipments, or fetch shipping labels, for the selected orders. The server works through them one
 * at a time and answers each; this sheet only shows those answers. It never sends again by itself: an order whose
 * outcome is unknown says so, and staff check it before trying again (running the same selection again is safe:
 * orders already with a courier answer "already has a shipment").
 */
export function BulkDispatchSheet({ action, orders, onOpenChange, onDone }: {
  action: "create" | "labels" | null;
  orders: BulkOrder[];
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const t = useTranslations("Commerce.orders.listing.bulk");
  const tShip = useTranslations("Validation.shipments");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<BulkResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = () => { setResults(null); setError(null); };
  const close = (open: boolean) => { if (busy) return; if (!open) reset(); onOpenChange(open); };

  const run = async () => {
    if (!action) return;
    setBusy(true);
    setError(null);
    const res = await bulkDispatch(action, orders.map((o) => o.id)).catch(() => null);
    setBusy(false);
    if (!res) { setError(t("failed")); return; }
    if (!res.ok) {
      setError(res.status === 403 ? t("forbidden") : res.code === "no_defaults" ? t("noDefaults") : res.status === 429 ? t("throttled") : t("failed"));
      return;
    }
    setResults(res.results);
    if (action === "create" && res.results.some((r) => r.ok)) onDone();
  };

  const refOf = (id: string) => orders.find((o) => o.id === id)?.ref ?? id.slice(0, 8).toUpperCase();
  const reason = (code: string) => (code === "unknown" ? t("unknown") : SHIPMENT_CODES.has(code) ? tShip(code) : t("failed"));
  const okCount = results?.filter((r) => r.ok).length ?? 0;

  return (
    <Sheet open={action !== null} onOpenChange={close}>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{action === "labels" ? t("labelsTitle") : t("createTitle")}</SheetTitle>
          <SheetDescription>
            {results ? t("summary", { ok: okCount, count: results.length }) : action === "labels" ? t("labelsBody", { count: orders.length }) : t("createBody", { count: orders.length })}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4">
          {error && <p role="alert" className="mb-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
          <ul className="divide-y divide-border rounded-xl border border-border">
            {(results ?? orders.map((o) => ({ order_id: o.id, pending: true as const }))).map((r) => (
              <li key={r.order_id} className="flex min-h-11 items-start gap-3 px-3 py-2.5 text-sm">
                {"pending" in r ? (
                  busy ? <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-muted-foreground" /> : <span className="mt-0.5 h-4 w-4 shrink-0" />
                ) : r.ok ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                ) : (
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="font-medium tabular-nums">{refOf(r.order_id)}</div>
                  {"pending" in r ? null : r.ok ? (
                    action === "labels" && r.url ? null : <div className="text-xs text-muted-foreground">{t("created")}</div>
                  ) : (
                    <div className="text-xs text-muted-foreground">{reason(r.code)}</div>
                  )}
                </div>
                {!("pending" in r) && r.ok && r.url && (
                  <a href={r.url} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "outline", size: "sm" })}>
                    <ExternalLink className="h-3.5 w-3.5" /> {t("openLabel")}
                  </a>
                )}
              </li>
            ))}
          </ul>
        </div>

        <SheetFooter>
          {results ? (
            <Button className="min-h-11 sm:min-h-9" onClick={() => close(false)}>{t("done")}</Button>
          ) : (
            <>
              <Button className="min-h-11 sm:min-h-9" onClick={() => void run()} disabled={busy || orders.length === 0}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                {action === "labels" ? t("labelsGo", { count: orders.length }) : t("createGo", { count: orders.length })}
              </Button>
              <Button variant="ghost" className="min-h-11 sm:min-h-9" onClick={() => close(false)} disabled={busy}>{t("cancel")}</Button>
            </>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
