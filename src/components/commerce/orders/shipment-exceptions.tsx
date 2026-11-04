"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { toast } from "sonner";
import { PackageX } from "lucide-react";

import { useCan } from "@/hooks/use-can";
import { Button, buttonVariants } from "@/components/ui/button";
import { resolutionsFor } from "@/lib/fulfilment/status-map";
import type { ShipmentExceptionResolution } from "@/lib/fulfilment/types";
import { listShipmentExceptions, resolveShipmentException, type ShipmentExceptionView } from "./order-api";

/**
 * Courier shipments that need an admin (Phase 9): a tracking contradiction
 * after a final state, return to origin, lost or damaged, a courier claim the
 * order disagrees with, an ambiguous create or AWB, stale tracking. Accepting a
 * correction changes the shipment only, never the order (use Returns). Hidden
 * when there is nothing to do, and for members without commerce.shipments.
 */
export function ShipmentExceptions() {
  const t = useTranslations("Commerce.shipmentExceptions");
  const format = useFormatter();
  const isAdmin = useCan("edit-settings");
  const [items, setItems] = useState<ShipmentExceptionView[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    listShipmentExceptions("open")
      .then((list) => { if (!cancelled && list) setItems(list); })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  if (!isAdmin || items.length === 0) return null;

  const statusText = (s: string | null) => (s && t.has(`statuses.${s}`) ? t(`statuses.${s}`) : null);

  const resolve = async (item: ShipmentExceptionView, resolution: ShipmentExceptionResolution) => {
    setBusy(item.id);
    try {
      const r = await resolveShipmentException(item.id, resolution);
      // 409: already resolved elsewhere; drop it from the list either way.
      if (r.ok || r.status === 409 || r.status === 404) {
        setItems((list) => list.filter((e) => e.id !== item.id));
        if (r.ok) toast.success(resolution === "accept_correction" ? t("correctionAccepted") : t("resolved"));
      } else toast.error(r.error ?? t("resolveError"));
    } catch {
      toast.error(t("resolveError"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="mx-4 mt-4 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 sm:mx-6" aria-labelledby="shipment-exceptions-title">
      <div className="flex items-start gap-2">
        <PackageX className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
        <div className="min-w-0">
          <h2 id="shipment-exceptions-title" className="text-sm font-semibold">{t("title", { count: items.length })}</h2>
          <p className="text-muted-foreground text-xs">{t("description")}</p>
        </div>
      </div>
      <ul className="mt-3 divide-y">
        {items.map((item) => {
          const observed = statusText(item.observed_status);
          return (
            <li key={item.id} className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 text-sm">
                <p className="font-medium">
                  {t(`kinds.${item.kind}`)}
                  {item.awb ? ` · ${t("awb", { awb: item.awb })}` : ""}
                </p>
                <p className="text-muted-foreground text-xs">
                  {[observed ? t("observed", { status: observed }) : null, statusText(item.tracking_status) ? t("current", { status: statusText(item.tracking_status)! }) : null,
                    format.dateTime(new Date(item.created_at), { dateStyle: "medium", timeStyle: "short" })]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                <p className="text-xs">{t(`hints.${item.kind}`)}</p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <Link href={`/commerce/orders/${encodeURIComponent(item.order_id)}`} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                  {t("openOrder")}
                </Link>
                {resolutionsFor(item.kind).map((resolution) => (
                  <Button key={resolution} size="sm" variant={resolution === "dismiss" ? "ghost" : "outline"} disabled={busy === item.id}
                    onClick={() => resolve(item, resolution)}>
                    {t(`resolutions.${resolution}`)}
                  </Button>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
