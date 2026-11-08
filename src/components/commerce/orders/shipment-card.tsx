"use client";

/**
 * Order panel: the Shiprocket shipment card mounted by order-fulfilment-panel.tsx
 * (Phase 9, design §7). Owner: T4 (mounted by T5).
 *
 * Renders nothing unless Shiprocket is connected or the order already has a
 * shipment, so staff-recorded dispatch stays the only path otherwise. Create
 * shipment (admins with commerce.shipments; a paid order without a live
 * shipment) asks for the package with the wallet warning; then AWB, courier,
 * tracking status, tracking link, label, cancel (before pickup) and "Assign
 * courier again" after a definite refusal.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, FileText, Loader2, PackagePlus, RotateCcw, Truck, X } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCan } from "@/hooks/use-can";
import { authFetch } from "@/lib/auth/client";
import { shipmentTrackingUrl, type OrderShipmentView } from "@/lib/fulfilment/types";

export interface ShipmentCardProps {
  orderId: string;
  /** The order status (a shipment can be created only for a paid order, or an unpaid cash-on-delivery order still confirmed). */
  orderStatus: string;
  /** A cash-on-delivery order whose cash is not recorded: it ships unpaid. */
  unpaidCod?: boolean;
  /** Called after a create, cancel or assign-again so the panel reloads. */
  onChanged?: () => void;
}

interface ShipmentState {
  connected: boolean;
  shipment: OrderShipmentView | null;
  defaults: { length_cm: number | null; breadth_cm: number | null; height_cm: number | null; weight_grams: number | null };
}

type Dims = { length_cm: string; breadth_cm: string; height_cm: string; weight_grams: string };
const TRANSITIONAL = (s: OrderShipmentView) => s.create_state === "creating" || s.awb_state === "assigning";
const POLL_MS = 5_000;
const POLL_LIMIT = 24;
const TRACKING_STATUSES = new Set([
  "created", "awb_assigned", "pickup_scheduled", "picked_up", "in_transit", "out_for_delivery", "delivery_failed",
  "rto_initiated", "rto_in_transit", "delivered", "lost", "rto_delivered", "cancelled",
]);
/** Shiprocket's public tracking page (form not confirmed by Shiprocket's docs; design §0). */
const PICKED_UP_RANK = 30;

async function errorText(res: Response, fallback: string): Promise<string> {
  const json = await res.json().catch(() => ({}));
  return typeof json.error === "string" ? json.error : fallback;
}

export function ShipmentCard({ orderId, orderStatus, unpaidCod = false, onChanged }: ShipmentCardProps) {
  const readyToShip = orderStatus === "paid" || (orderStatus === "confirmed" && unpaidCod);
  const t = useTranslations("Commerce.shipments");
  const canManage = useCan("edit-settings");
  const [state, setState] = useState<ShipmentState | null>(null);
  const [form, setForm] = useState<Dims | null>(null);
  const [busy, setBusy] = useState<"create" | "cancel" | "awb" | "label" | null>(null);
  const polls = useRef(0);
  const endpoint = `/api/commerce/orders/${orderId}/shipment`;

  const load = useCallback(async () => {
    const res = await authFetch(endpoint, { cache: "no-store" });
    if (!res.ok) return null;
    const json = (await res.json()) as ShipmentState;
    setState(json);
    return json;
  }, [endpoint]);

  useEffect(() => {
    let live = true;
    polls.current = 0;
    void load().catch(() => { if (live) setState(null); });
    return () => { live = false; };
  }, [load]);

  // While Shiprocket is creating the order or assigning the courier, re-read for a minute or two.
  useEffect(() => {
    const shipment = state?.shipment;
    if (!shipment || !TRANSITIONAL(shipment) || polls.current >= POLL_LIMIT) return;
    const timer = setTimeout(() => { polls.current += 1; void load().catch(() => undefined); }, POLL_MS);
    return () => clearTimeout(timer);
  }, [state, load]);

  if (!state || (!state.connected && !state.shipment)) return null;
  const shipment = state.shipment;
  const live = shipment && shipment.create_state !== "failed" && shipment.create_state !== "cancelled";
  const trackUrl = shipmentTrackingUrl(shipment?.awb);
  const canCreate = state.connected && canManage && readyToShip && !live;

  const openForm = () => {
    const d = state.defaults;
    const text = (v: number | null) => (v === null ? "" : String(v));
    setForm({ length_cm: text(d.length_cm), breadth_cm: text(d.breadth_cm), height_cm: text(d.height_cm), weight_grams: text(d.weight_grams) });
  };

  const act = async (kind: "create" | "cancel" | "awb", request: () => Promise<Response>, done: string, fallback: string) => {
    setBusy(kind);
    try {
      const res = await request();
      if (!res.ok) throw new Error(await errorText(res, fallback));
      toast.success(done);
      setForm(null);
      polls.current = 0;
      await load();
      onChanged?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : fallback);
    } finally {
      setBusy(null);
    }
  };

  const create = () => {
    if (!form) return;
    const body = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, Number(v)]));
    if (!window.confirm(t("confirm"))) return;
    void act("create", () => authFetch(endpoint, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }), t("created"), t("failed"));
  };

  const cancel = () => {
    if (!window.confirm(t("cancelConfirm"))) return;
    void act("cancel", () => authFetch(endpoint, { method: "DELETE" }), t("cancelled"), t("failed"));
  };

  const assignAgain = () => {
    if (!window.confirm(t("assignConfirm"))) return;
    void act("awb", () => authFetch(`${endpoint}/awb`, { method: "POST" }), t("assignQueued"), t("failed"));
  };

  const label = async () => {
    setBusy("label");
    try {
      const res = await authFetch(`${endpoint}/label`, { cache: "no-store" });
      if (!res.ok) throw new Error(await errorText(res, t("failed")));
      const { url } = (await res.json()) as { url: string };
      if (/^https:\/\//.test(url)) window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("failed"));
    } finally {
      setBusy(null);
    }
  };

  const formValid = !!form && Object.values(form).every((v) => v.trim() !== "" && Number.isFinite(Number(v)) && Number(v) > 0);
  const stateLine = (s: OrderShipmentView): string | null => {
    if (s.create_state === "creating") return t("stateCreating");
    if (s.create_state === "unknown") return t("stateUnknown");
    if (s.create_state === "failed") return t("stateFailed", { code: s.last_error_code ?? "" });
    if (s.create_state === "cancelled") return t("stateCancelled");
    if (s.awb_state === "none" || s.awb_state === "assigning") return t("awbAssigning");
    if (s.awb_state === "unknown") return t("awbUnknown");
    if (s.awb_state === "failed") return t("awbFailed", { code: s.last_error_code ?? "" });
    return null;
  };
  const statusLabel = (s: OrderShipmentView) =>
    s.tracking_status && TRACKING_STATUSES.has(s.tracking_status) ? t(`statuses.${s.tracking_status}`) : t("noTracking");

  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Truck className="h-4 w-4" />
        {t("title")}
        {shipment && live && shipment.awb_state === "assigned" && <Badge variant="secondary">{statusLabel(shipment)}</Badge>}
      </div>

      {shipment && (
        <div className="space-y-1 text-sm">
          {stateLine(shipment) && <p className="text-muted-foreground">{stateLine(shipment)}</p>}
          {shipment.awb && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-muted-foreground">{t("awb")}</dt>
              <dd className="font-mono">{shipment.awb}</dd>
              {shipment.courier_name && (<><dt className="text-muted-foreground">{t("courier")}</dt><dd>{shipment.courier_name}</dd></>)}
              <dt className="text-muted-foreground">{t("status")}</dt>
              <dd>{statusLabel(shipment)}</dd>
            </dl>
          )}
          {shipment.awb_state === "assigned" && shipment.last_error_code === "pickup_failed" && (
            <p className="text-xs text-amber-600 dark:text-amber-400">{t("pickupFailed")}</p>
          )}
          <p className="text-xs text-muted-foreground">{t("reference", { reference: shipment.reference })}</p>
          <div className="flex flex-wrap gap-2 pt-1">
            {trackUrl && live && (
              <a href={trackUrl} target="_blank" rel="noopener noreferrer"
                className={buttonVariants({ size: "sm", variant: "outline" })}>
                <ExternalLink className="mr-1 h-4 w-4" />{t("track")}
              </a>
            )}
            {canManage && live && shipment.awb_state === "assigned" && (
              <Button size="sm" variant="outline" onClick={() => void label()} disabled={!!busy}>
                {busy === "label" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <FileText className="mr-1 h-4 w-4" />}
                {t("label")}
              </Button>
            )}
            {canManage && live && shipment.create_state === "created" && shipment.awb_state === "failed" && state.connected && (
              <Button size="sm" variant="outline" onClick={assignAgain} disabled={!!busy}>
                {busy === "awb" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-1 h-4 w-4" />}
                {t("assignAgain")}
              </Button>
            )}
            {canManage && live && shipment.create_state === "created" && shipment.awb_state !== "assigning"
              && shipment.awb_state !== "unknown" && (shipment.tracking_rank ?? 0) < PICKED_UP_RANK && state.connected && (
              <Button size="sm" variant="outline" onClick={cancel} disabled={!!busy}>
                {busy === "cancel" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <X className="mr-1 h-4 w-4" />}
                {t("cancel")}
              </Button>
            )}
          </div>
        </div>
      )}

      {canCreate && !form && (
        <Button size="sm" onClick={openForm}>
          <PackagePlus className="mr-1 h-4 w-4" />{t("create")}
        </Button>
      )}
      {canCreate && form && (
        <div className="space-y-3">
          <p className="text-xs text-amber-600 dark:text-amber-400">{t("walletWarning")}</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {(["length_cm", "breadth_cm", "height_cm", "weight_grams"] as const).map((key) => (
              <div key={key}>
                <Label htmlFor={`shipment-${orderId}-${key}`} className="mb-1 block text-xs text-muted-foreground">{t(`dims.${key}`)}</Label>
                <Input id={`shipment-${orderId}-${key}`} type="number" inputMode="decimal" min={0} step={key === "weight_grams" ? "1" : "0.1"}
                  value={form[key]} onChange={(e) => setForm((f) => (f ? { ...f, [key]: e.target.value } : f))} />
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={create} disabled={!formValid || !!busy}>
              {busy === "create" && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {t("createConfirm")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setForm(null)} disabled={!!busy}>{t("close")}</Button>
          </div>
        </div>
      )}
      {state.connected && !canManage && readyToShip && !live && (
        <p className="text-xs text-muted-foreground">{t("adminOnly")}</p>
      )}
    </div>
  );
}
