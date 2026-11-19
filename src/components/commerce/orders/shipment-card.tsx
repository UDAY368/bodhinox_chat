"use client";

/**
 * Order panel: the courier shipments card mounted by order-fulfilment-panel.tsx
 * (Phase 9, design §7; split shipments: Store Phase 5).
 *
 * Renders nothing unless a courier is connected or the order already has a
 * shipment, so staff-recorded dispatch stays the only path otherwise. Create
 * shipment (admins with commerce.shipments; a paid or partially shipped order
 * with units not yet in a live shipment) asks which lines and quantities go in
 * this parcel and for the package, with the wallet warning. Every shipment is
 * listed with its lines, AWB, courier, tracking status, tracking link, label,
 * cancel (before pickup) and "Assign courier again" after a definite refusal.
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
import { isReadyToShip } from "@/lib/commerce/order-state";
import { shipmentTrackingUrl, type OrderShipmentView } from "@/lib/fulfilment/types";

export interface ShipmentCardProps {
  orderId: string;
  /** The order status (a shipment can be created for a paid or partially shipped order, or an unpaid cash-on-delivery order still confirmed). */
  orderStatus: string;
  /** A cash-on-delivery order whose cash is not recorded: it ships unpaid. */
  unpaidCod?: boolean;
  /** Refunded in full before it left: no shipment may be created. */
  refundedInFull?: boolean;
  /** Called after a create, cancel, assign-again or pickup request so the panel reloads. */
  onChanged?: () => void;
}

interface ShipmentLine { id: string; name: string | null; quantity: number; shipped: number }

interface ShipmentState {
  connected: boolean;
  shipment: OrderShipmentView | null;
  /** Every shipment of the order, live ones first; absent from older responses. */
  shipments?: OrderShipmentView[];
  /** The order's lines with the units already in live shipments; absent from older responses. */
  lines?: ShipmentLine[];
  /** The connected couriers the admin may pick (the first is the default); absent from older responses. */
  couriers?: { id: string; name: string; tested_live: boolean }[];
  defaults: { length_cm: number | null; breadth_cm: number | null; height_cm: number | null; weight_grams: number | null };
}

type Dims = { length_cm: string; breadth_cm: string; height_cm: string; weight_grams: string };
type Busy = { kind: "create" | "cancel" | "awb" | "pickup" | "label"; id?: string } | null;
const isLive = (s: OrderShipmentView) => s.create_state !== "failed" && s.create_state !== "cancelled";
const TRANSITIONAL = (s: OrderShipmentView) => s.create_state === "creating" || s.awb_state === "assigning";
const POLL_MS = 5_000;
const POLL_LIMIT = 24;
const TRACKING_STATUSES = new Set([
  "created", "awb_assigned", "pickup_scheduled", "picked_up", "in_transit", "out_for_delivery", "delivery_failed",
  "rto_initiated", "rto_in_transit", "delivered", "lost", "rto_delivered", "cancelled",
]);
const PICKED_UP_RANK = 30;

async function errorText(res: Response, fallback: string): Promise<string> {
  const json = await res.json().catch(() => ({}));
  return typeof json.error === "string" ? json.error : fallback;
}

/** The tracking page of a shipment's own courier, or null. */
function trackingUrl(shipment: OrderShipmentView): string | null {
  if (shipment.provider === "delhivery")
    return shipment.awb && /^[A-Za-z0-9-]{4,40}$/.test(shipment.awb) ? `https://www.delhivery.com/track/package/${shipment.awb}` : null;
  return shipment.provider && shipment.provider !== "shiprocket" ? null : shipmentTrackingUrl(shipment.awb);
}

export function ShipmentCard({ orderId, orderStatus, unpaidCod = false, refundedInFull = false, onChanged }: ShipmentCardProps) {
  const readyToShip = !refundedInFull && isReadyToShip({ status: orderStatus, unpaidCod });
  const t = useTranslations("Commerce.shipments");
  const canManage = useCan("edit-settings");
  const [state, setState] = useState<ShipmentState | null>(null);
  const [form, setForm] = useState<Dims | null>(null);
  /** Units of each order line that go in the new parcel (line id -> text). */
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [courierId, setCourierId] = useState<string>("");
  const [busy, setBusy] = useState<Busy>(null);
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

  const shipments = state ? state.shipments ?? (state.shipment ? [state.shipment] : []) : [];
  const transitional = shipments.some((s) => isLive(s) && TRANSITIONAL(s));

  // While the courier is creating an order or assigning the AWB, re-read for a minute or two.
  useEffect(() => {
    if (!transitional || polls.current >= POLL_LIMIT) return;
    const timer = setTimeout(() => { polls.current += 1; void load().catch(() => undefined); }, POLL_MS);
    return () => clearTimeout(timer);
  }, [state, transitional, load]);

  if (!state || (!state.connected && !shipments.length)) return null;
  const lines = state.lines ?? [];
  const remaining = (line: ShipmentLine) => Math.max(0, line.quantity - line.shipped);
  const anyLive = shipments.some(isLive);
  // Something is left to ship: a unit not in any live shipment (older responses: no live shipment at all).
  const unshipped = state.lines ? lines.some((l) => remaining(l) > 0) : !anyLive;
  const couriers = state.couriers ?? [];
  const chosen = couriers.find((c) => c.id === courierId) ?? couriers[0] ?? null;
  const canCreate = state.connected && canManage && readyToShip && unshipped;
  const nameOf = new Map(lines.map((l) => [l.id, l.name]));

  const openForm = () => {
    const d = state.defaults;
    const text = (v: number | null) => (v === null ? "" : String(v));
    setCourierId(couriers[0]?.id ?? "");
    setPicked(Object.fromEntries(lines.filter((l) => remaining(l) > 0).map((l) => [l.id, String(remaining(l))])));
    setForm({ length_cm: text(d.length_cm), breadth_cm: text(d.breadth_cm), height_cm: text(d.height_cm), weight_grams: text(d.weight_grams) });
  };

  const act = async (kind: "create" | "cancel" | "awb" | "pickup", id: string | undefined, request: () => Promise<Response>, done: string) => {
    setBusy({ kind, id });
    try {
      const res = await request();
      if (!res.ok) throw new Error(await errorText(res, t("failed")));
      toast.success(done);
      setForm(null);
      polls.current = 0;
      await load();
      onChanged?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("failed"));
    } finally {
      setBusy(null);
    }
  };

  const pickedItems = lines.filter((l) => remaining(l) > 0)
    .map((l) => ({ order_item_id: l.id, quantity: Number(picked[l.id] ?? "0"), max: remaining(l) }));
  const itemsValid = pickedItems.every((i) => Number.isInteger(i.quantity) && i.quantity >= 0 && i.quantity <= i.max)
    && pickedItems.some((i) => i.quantity > 0);
  const dimsValid = !!form && (["length_cm", "breadth_cm", "height_cm"] as const)
    .every((k) => form[k].trim() !== "" && Number.isFinite(Number(form[k])) && Number(form[k]) > 0);
  // An empty weight takes the weight of the parcel's own items from the catalogue (only when lines are named).
  const weightValid = !!form && (form.weight_grams.trim() === "" ? !!state.lines
    : Number.isInteger(Number(form.weight_grams)) && Number(form.weight_grams) > 0);
  const formValid = dimsValid && weightValid && (!state.lines || itemsValid);

  const create = () => {
    if (!form || !formValid) return;
    const wallet = !chosen || chosen.id === "shiprocket";
    if (!window.confirm(wallet ? t("confirm") : t("confirmCourier", { name: chosen.name }))) return;
    const body: Record<string, unknown> = {
      length_cm: Number(form.length_cm), breadth_cm: Number(form.breadth_cm), height_cm: Number(form.height_cm),
      weight_grams: form.weight_grams.trim() === "" ? null : Number(form.weight_grams),
      ...(state.lines ? { items: pickedItems.filter((i) => i.quantity > 0).map(({ order_item_id, quantity }) => ({ order_item_id, quantity })) } : {}),
      ...(chosen ? { provider: chosen.id } : {}),
    };
    void act("create", undefined, () => authFetch(endpoint, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }), t("created"));
  };

  const of = (s: OrderShipmentView) => `?shipment_id=${encodeURIComponent(s.id)}`;
  const cancel = (s: OrderShipmentView) => {
    if (!window.confirm(t("cancelConfirm"))) return;
    void act("cancel", s.id, () => authFetch(`${endpoint}${of(s)}`, { method: "DELETE" }), t("cancelled"));
  };
  const assignAgain = (s: OrderShipmentView) => {
    if (!window.confirm(t("assignConfirm"))) return;
    void act("awb", s.id, () => authFetch(`${endpoint}/awb${of(s)}`, { method: "POST" }), t("assignQueued"));
  };
  const pickupAgain = (s: OrderShipmentView) => {
    void act("pickup", s.id, () => authFetch(`${endpoint}/pickup${of(s)}`, { method: "POST" }), t("pickupRequested"));
  };
  const label = async (s: OrderShipmentView) => {
    setBusy({ kind: "label", id: s.id });
    try {
      const res = await authFetch(`${endpoint}/label${of(s)}`, { cache: "no-store" });
      if (!res.ok) throw new Error(await errorText(res, t("failed")));
      const { url } = (await res.json()) as { url: string };
      if (/^https:\/\//.test(url)) window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("failed"));
    } finally {
      setBusy(null);
    }
  };

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
  const spinning = (kind: NonNullable<Busy>["kind"], s: OrderShipmentView) => busy?.kind === kind && busy.id === s.id;
  // Live shipments, and the newest ended one only when nothing is live (as before split shipments).
  const shown = anyLive ? shipments.filter(isLive) : shipments.slice(0, 1);

  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Truck className="h-4 w-4" />
        {t("title")}
        {shown.length > 1 && <Badge variant="outline">{t("parcels", { count: shown.length })}</Badge>}
      </div>

      {shown.map((shipment, index) => {
        const live = isLive(shipment);
        const trackUrl = trackingUrl(shipment);
        const line = stateLine(shipment);
        return (
          <div key={shipment.id} className={`space-y-1 text-sm ${index > 0 ? "border-t border-border pt-3" : ""}`}>
            <div className="flex flex-wrap items-center gap-2">
              {shown.length > 1 && <span className="font-medium">{t("parcel", { number: shown.length - index })}</span>}
              {live && shipment.awb_state === "assigned" && <Badge variant="secondary">{statusLabel(shipment)}</Badge>}
            </div>
            {line && <p className="text-muted-foreground">{line}</p>}
            {!!shipment.items?.length && (
              <ul className="text-xs text-muted-foreground">
                {shipment.items.map((item) => (
                  <li key={item.order_item_id}>{item.quantity} × {nameOf.get(item.order_item_id) ?? t("unknownItem")}</li>
                ))}
              </ul>
            )}
            {shipment.awb && (
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                <dt className="text-muted-foreground">{t("awb")}</dt>
                <dd className="font-mono">{shipment.awb}</dd>
                {shipment.provider && shipment.provider !== "shiprocket" && (<><dt className="text-muted-foreground">{t("bookedWith")}</dt><dd>{shipment.provider === "delhivery" ? "Delhivery" : "Shipway"}</dd></>)}
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
                <Button size="sm" variant="outline" onClick={() => void label(shipment)} disabled={!!busy}>
                  {spinning("label", shipment) ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <FileText className="mr-1 h-4 w-4" />}
                  {t("label")}
                </Button>
              )}
              {canManage && live && shipment.awb_state === "assigned" && shipment.last_error_code === "pickup_failed"
                && (shipment.tracking_rank ?? 0) < PICKED_UP_RANK && state.connected && (
                <Button size="sm" variant="outline" onClick={() => pickupAgain(shipment)} disabled={!!busy}>
                  {spinning("pickup", shipment) ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-1 h-4 w-4" />}
                  {t("pickupAgain")}
                </Button>
              )}
              {canManage && live && shipment.create_state === "created" && shipment.awb_state === "failed" && state.connected && (
                <Button size="sm" variant="outline" onClick={() => assignAgain(shipment)} disabled={!!busy}>
                  {spinning("awb", shipment) ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-1 h-4 w-4" />}
                  {t("assignAgain")}
                </Button>
              )}
              {canManage && live && shipment.create_state === "created" && shipment.awb_state !== "assigning"
                && shipment.awb_state !== "unknown" && (shipment.tracking_rank ?? 0) < PICKED_UP_RANK && state.connected && (
                <Button size="sm" variant="outline" onClick={() => cancel(shipment)} disabled={!!busy}>
                  {spinning("cancel", shipment) ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <X className="mr-1 h-4 w-4" />}
                  {t("cancel")}
                </Button>
              )}
            </div>
          </div>
        );
      })}

      {canCreate && !form && (
        <Button size="sm" onClick={openForm}>
          <PackagePlus className="mr-1 h-4 w-4" />{anyLive ? t("createAnother") : t("create")}
        </Button>
      )}
      {canCreate && form && (
        <div className="space-y-3">
          {couriers.length > 1 && (
            <div>
              <Label htmlFor={`shipment-${orderId}-courier`} className="mb-1 block text-xs text-muted-foreground">{t("chooseCourier")}</Label>
              <select id={`shipment-${orderId}-courier`} value={chosen?.id ?? ""} onChange={(e) => setCourierId(e.target.value)}
                className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground">
                {couriers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          )}
          {(!chosen || chosen.id === "shiprocket")
            ? <p className="text-xs text-amber-600 dark:text-amber-400">{t("walletWarning")}</p>
            : <p className="text-xs text-amber-600 dark:text-amber-400">{t("notTested", { name: chosen.name })}</p>}
          {!!state.lines && (
            <fieldset className="space-y-2">
              <legend className="mb-1 text-xs text-muted-foreground">{t("pickLines")}</legend>
              {lines.filter((l) => remaining(l) > 0).map((l) => (
                <div key={l.id} className="flex items-center justify-between gap-3">
                  <Label htmlFor={`shipment-${orderId}-line-${l.id}`} className="min-w-0 flex-1 truncate text-sm font-normal">
                    {l.name ?? t("unknownItem")} <span className="text-xs text-muted-foreground">{t("lineLeft", { count: remaining(l) })}</span>
                  </Label>
                  <Input id={`shipment-${orderId}-line-${l.id}`} type="number" inputMode="numeric" min={0} max={remaining(l)} step="1" className="h-9 w-20"
                    value={picked[l.id] ?? "0"} onChange={(e) => setPicked((p) => ({ ...p, [l.id]: e.target.value }))} />
                </div>
              ))}
            </fieldset>
          )}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {(["length_cm", "breadth_cm", "height_cm", "weight_grams"] as const).map((key) => (
              <div key={key}>
                <Label htmlFor={`shipment-${orderId}-${key}`} className="mb-1 block text-xs text-muted-foreground">{t(`dims.${key}`)}</Label>
                <Input id={`shipment-${orderId}-${key}`} type="number" inputMode="decimal" min={0} step={key === "weight_grams" ? "1" : "0.1"}
                  value={form[key]} onChange={(e) => setForm((f) => (f ? { ...f, [key]: e.target.value } : f))} />
              </div>
            ))}
          </div>
          {!!state.lines && <p className="text-xs text-muted-foreground">{t("weightFromItems")}</p>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={create} disabled={!formValid || !!busy}>
              {busy?.kind === "create" && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {t("createConfirm")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setForm(null)} disabled={!!busy}>{t("close")}</Button>
          </div>
        </div>
      )}
      {state.connected && !canManage && readyToShip && unshipped && (
        <p className="text-xs text-muted-foreground">{t("adminOnly")}</p>
      )}
    </div>
  );
}
