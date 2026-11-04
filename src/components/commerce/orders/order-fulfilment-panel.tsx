"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, PackageCheck, Star, Truck, Undo2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { canTransition } from "@/lib/commerce/order-format";
import { cancelAndRefundOrder, deliverOrder, dispatchOrder, recordOrderFeedback, type ApiResult, type OrderDetail } from "./order-api";
import { ShipmentCard } from "./shipment-card";

const TRACKING_MAX = 200;

/**
 * Fulfilment: the courier shipment (Shiprocket, when connected), staff-recorded
 * dispatch (with an optional tracking note) and delivery, how the current step
 * is known (courier confirmed / staff recorded / not confirmed), the customer's
 * feedback score, and "Cancel and refund" for a paid order that has not left.
 * The server re-checks every rule; this only offers what the status allows.
 */
export function OrderFulfilmentPanel({ order, canAct, canRefund, onChanged }: {
  order: OrderDetail;
  canAct: boolean;
  canRefund: boolean;
  onChanged: () => Promise<void>;
}) {
  const t = useTranslations("Commerce.orders.lifecycle");
  const tEvidence = useTranslations("Commerce.evidence");
  const [tracking, setTracking] = useState("");
  const [refundNote, setRefundNote] = useState("");
  const [confirmRefund, setConfirmRefund] = useState(false);
  // Set after a 409 offline_payment: part of the money must be returned outside Razorpay first.
  const [outsideNeeded, setOutsideNeeded] = useState(false);
  const [outsideConfirmed, setOutsideConfirmed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const priced = order.priced_at !== null;
  const canDispatch = canTransition(order.status, "dispatched", { priced });
  const canDeliver = canTransition(order.status, "fulfilled", { priced });
  const delivered = order.status === "fulfilled";
  const canCancelRefund = order.status === "paid" && canRefund;
  const shipment = order.shipment ?? null;
  // Tracking moves this order by itself once the courier has the parcel.
  const courierTracked = Boolean(shipment?.awb) && shipment?.create_state === "created";

  async function run<T>(key: string, call: () => Promise<ApiResult<T>>, success: string | ((value: T) => string)) {
    setBusy(key);
    try {
      const r = await call();
      if (!r.ok) {
        if (r.code === "shipment_live") toast.error(t("shipmentLive"));
        else if (r.code === "offline_payment") {
          setOutsideNeeded(true);
          toast.error(t("cancelRefundOutsideNeeded"));
        } else toast.error(r.code === "conflict" ? t("conflict") : r.status === 403 ? t("forbidden") : r.code === "bad_transition" ? t("notAllowed") : t("error"));
      } else toast.success(typeof success === "function" ? success(r.value) : success);
      await onChanged();
    } catch {
      toast.error(t("error"));
    } finally {
      setBusy(null);
    }
  }

  if (!canDispatch && !canDeliver && !delivered && !canCancelRefund && !order.tracking_note && !shipment && order.status !== "dispatched") return null;

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-foreground">{t("title")}</h2>
        {order.evidence && (
          <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground" data-evidence={order.evidence}>
            {tEvidence(order.evidence)}
          </span>
        )}
      </div>
      <ShipmentCard orderId={order.id} orderStatus={order.status} onChanged={() => void onChanged()} />
      {order.tracking_note && (
        <p className="text-xs text-muted-foreground break-words">{t("trackingShown", { note: order.tracking_note })}</p>
      )}
      {canDispatch && (
        <div className="space-y-2">
          <Label htmlFor="order-tracking">{t("trackingLabel")}</Label>
          <Input id="order-tracking" maxLength={TRACKING_MAX} value={tracking} disabled={!canAct || busy !== null}
            placeholder={t("trackingPlaceholder")} onChange={(e) => setTracking(e.target.value)} />
          <Button size="sm" disabled={!canAct || busy !== null}
            onClick={() => run("dispatch", () => dispatchOrder(order.id, { from: order.status, tracking_note: tracking.trim() || null }), t("dispatched"))}>
            {busy === "dispatch" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Truck className="h-4 w-4" />}
            {t("dispatch")}
          </Button>
        </div>
      )}
      {canDeliver && (
        <Button size="sm" variant={canDispatch ? "outline" : "default"} disabled={!canAct || busy !== null}
          onClick={() => run("deliver", () => deliverOrder(order.id, { from: order.status }), t("delivered"))}>
          {busy === "deliver" ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackageCheck className="h-4 w-4" />}
          {t("deliver")}
        </Button>
      )}
      {canDeliver && <p className="text-xs text-muted-foreground">{courierTracked ? t("courierTracked") : t("staffRecorded")}</p>}
      {delivered && (
        <div className="space-y-1">
          <Label>{t("feedbackLabel")}</Label>
          <div className="flex gap-1" role="group" aria-label={t("feedbackLabel")}>
            {[1, 2, 3, 4, 5].map((score) => (
              <Button key={score} size="sm" variant={order.feedback_score === score ? "default" : "outline"}
                aria-pressed={order.feedback_score === score} disabled={!canAct || busy !== null}
                aria-label={t("feedbackScore", { score })}
                onClick={() => run("feedback", () => recordOrderFeedback(order.id, score), t("feedbackSaved"))}>
                <Star className="h-3.5 w-3.5" /> {score}
              </Button>
            ))}
          </div>
        </div>
      )}
      {canCancelRefund && (
        <div className="space-y-2 border-t border-border pt-3">
          {!confirmRefund ? (
            <Button size="sm" variant="outline" disabled={!canAct || busy !== null} onClick={() => setConfirmRefund(true)}>
              <Undo2 className="h-4 w-4" /> {t("cancelRefund")}
            </Button>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">{t("cancelRefundConfirm")}</p>
              <Textarea rows={2} maxLength={500} value={refundNote} placeholder={t("refundNotePlaceholder")}
                onChange={(e) => setRefundNote(e.target.value)} />
              {outsideNeeded && (
                <div className="space-y-2 rounded-md border border-border p-2">
                  <p className="text-xs text-muted-foreground">{t("cancelRefundOutsideNeeded")}</p>
                  <label className="flex items-start gap-2 text-sm">
                    <Checkbox checked={outsideConfirmed} onCheckedChange={(v) => setOutsideConfirmed(v === true)} />
                    <span>{t("cancelRefundOutsideConfirm")}</span>
                  </label>
                </div>
              )}
              <div className="flex gap-2">
                <Button size="sm" variant="destructive" disabled={busy !== null || (outsideNeeded && !outsideConfirmed)}
                  onClick={() => run("refund", () => cancelAndRefundOrder(order.id, refundNote.trim() || null, outsideNeeded && outsideConfirmed),
                    (v) => (v.refundIds.length === 0 && v.refundedOutside ? t("cancelRefundDoneOutside") : t("cancelRefundDone")))}>
                  {busy === "refund" && <Loader2 className="h-4 w-4 animate-spin" />}
                  {t("cancelRefundGo")}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setConfirmRefund(false)}>{t("back")}</Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
