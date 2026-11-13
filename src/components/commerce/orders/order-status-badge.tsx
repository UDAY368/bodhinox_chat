"use client";

import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";
import type { OrderStatus } from "@/lib/commerce/order-format";

const TONE: Record<OrderStatus, string> = {
  new: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  confirmed: "border-indigo-500/40 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300",
  awaiting_payment: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  payment_review: "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  paid: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  dispatched: "border-teal-500/40 bg-teal-500/10 text-teal-700 dark:text-teal-300",
  fulfilled: "border-border bg-muted text-foreground",
  expired: "border-border bg-muted text-muted-foreground",
  cancelled: "border-border bg-muted text-muted-foreground line-through",
};

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  const t = useTranslations("Commerce.orders.statuses");
  return (
    <span className={cn("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap", TONE[status])}>
      {t(status)}
    </span>
  );
}
