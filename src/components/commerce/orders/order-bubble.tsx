"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { ShoppingBag } from "lucide-react";

import { formatMoney } from "@/lib/commerce/money";
import { asOrderMessagePayload, orderUnitCount } from "@/lib/commerce/order-format";

/** The cart a customer sent from the catalogue, as stored on the message (interactive_payload.order). */
export function orderFromPayload(payload: unknown) {
  return payload && typeof payload === "object" ? asOrderMessagePayload((payload as { order?: unknown }).order) : null;
}

const MAX_LINES = 6;

/** Inbox bubble for an inbound order: its items, the total and a link to the order. */
export function OrderBubble({ payload }: { payload: unknown }) {
  const t = useTranslations("Commerce.orders.bubble");
  const locale = useLocale();
  const order = orderFromPayload(payload);
  if (!order) return null;
  const money = (minor: number) => {
    try {
      return formatMoney(minor, order.currency, locale);
    } catch {
      return `${order.currency} ${minor}`;
    }
  };
  const hidden = order.items.length - MAX_LINES;
  return (
    <div className="flex min-w-48 flex-col gap-1.5">
      <span className="text-muted-foreground inline-flex items-center gap-1 text-[11px] font-medium">
        <ShoppingBag className="h-3 w-3" />
        {t("label", { count: orderUnitCount(order.items) })}
      </span>
      <ul className="space-y-0.5 text-sm">
        {order.items.slice(0, MAX_LINES).map((item, i) => (
          <li key={`${item.retailer_id}-${i}`} className="flex justify-between gap-3">
            <span className="min-w-0 break-words">{item.quantity} × {item.name || item.retailer_id}</span>
            <span className="shrink-0 tabular-nums">{money(item.unit_price_minor * item.quantity)}</span>
          </li>
        ))}
        {hidden > 0 && <li className="text-muted-foreground text-xs">{t("more", { count: hidden })}</li>}
      </ul>
      <div className="flex justify-between gap-3 border-t border-current/15 pt-1 text-sm font-semibold">
        <span>{t("total")}</span>
        <span className="tabular-nums">{money(order.subtotal_minor)}</span>
      </div>
      {order.note && <p className="text-sm break-words whitespace-pre-wrap">{order.note}</p>}
      <Link href={`/commerce/orders/${order.order_id}`} className="text-xs font-medium underline-offset-2 hover:underline">
        {t("view")}
      </Link>
    </div>
  );
}
