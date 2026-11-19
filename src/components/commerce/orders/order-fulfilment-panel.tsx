"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Star } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { canDeliver, isUnpaidCodOrder, refundedBeforeShipping } from "@/lib/commerce/order-state";
import { recordOrderFeedback, type OrderDetail } from "./order-api";
import { ShipmentCard } from "./shipment-card";

/**
 * The order view's Shipment section: the courier shipments (when a courier is connected), the
 * tracking note, how the current step is known (courier confirmed / staff recorded / not confirmed)
 * and the customer's feedback score once delivered. Shipping and delivering are the view's next-step
 * button; the server re-checks every rule.
 */
export function OrderFulfilmentPanel({ order, canAct, onChanged }: {
  order: OrderDetail;
  canAct: boolean;
  onChanged: () => Promise<void>;
}) {
  const t = useTranslations("Commerce.orders.lifecycle");
  const tEvidence = useTranslations("Commerce.evidence");
  const [busy, setBusy] = useState(false);
  const refundedInFull = refundedBeforeShipping(order);
  const shipment = order.shipment ?? null;
  // Tracking moves this order by itself once the courier has the parcel.
  const courierTracked = Boolean(shipment?.awb) && shipment?.create_state === "created";

  async function feedback(score: number) {
    setBusy(true);
    try {
      const r = await recordOrderFeedback(order.id, score);
      if (r.ok) toast.success(t("feedbackSaved"));
      else toast.error(r.code === "conflict" ? t("conflict") : r.status === 403 ? t("forbidden") : r.code === "bad_transition" ? t("notAllowed") : t("error"));
      await onChanged();
    } catch {
      toast.error(t("error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {order.evidence && (
        <span className="inline-flex rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground" data-evidence={order.evidence}>
          {tEvidence(order.evidence)}
        </span>
      )}
      <ShipmentCard orderId={order.id} orderStatus={order.status} unpaidCod={isUnpaidCodOrder(order)} refundedInFull={refundedInFull}
        onChanged={() => void onChanged()} />
      {refundedInFull && order.status === "paid" && <p className="text-xs text-muted-foreground">{t("refundedInFull")}</p>}
      {order.tracking_note && (
        <p className="text-xs text-muted-foreground break-words">{t("trackingShown", { note: order.tracking_note })}</p>
      )}
      {canDeliver(order) && <p className="text-xs text-muted-foreground">{courierTracked ? t("courierTracked") : t("staffRecorded")}</p>}
      {order.status === "fulfilled" && (
        <div className="space-y-1">
          <Label>{t("feedbackLabel")}</Label>
          <div className="flex flex-wrap gap-1" role="group" aria-label={t("feedbackLabel")}>
            {[1, 2, 3, 4, 5].map((score) => (
              <Button key={score} size="sm" variant={order.feedback_score === score ? "default" : "outline"} className="min-h-11 sm:min-h-8"
                aria-pressed={order.feedback_score === score} disabled={!canAct || busy}
                aria-label={t("feedbackScore", { score })} onClick={() => void feedback(score)}>
                <Star className="h-3.5 w-3.5" /> {score}
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
