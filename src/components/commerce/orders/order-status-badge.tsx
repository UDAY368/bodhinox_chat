"use client";

import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";
import type { OrderStatus } from "@/lib/commerce/order-format";

const TONE: Record<OrderStatus, string> = {
  new: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  confirmed: "border-indigo-500/40 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300",
  awaiting_payment: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  paid: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  fulfilled: "border-border bg-muted text-foreground",
  cancelled: "border-border bg-muted text-muted-foreground line-through",
};

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  const t = useTranslations("Commerce.orders.statuses");
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap", TONE[status])}>
      {t(status)}
    </span>
  );
}
