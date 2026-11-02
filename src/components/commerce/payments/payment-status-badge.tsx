"use client";

import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";
import type { PaymentLinkStatus } from "./payment-api";

const TONE: Record<PaymentLinkStatus, string> = {
  creating: "bg-muted text-muted-foreground",
  created: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  partially_paid: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  paid: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  expired: "bg-muted text-muted-foreground",
  cancelled: "bg-muted text-muted-foreground",
  failed: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  unknown: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
};

export function PaymentStatusBadge({ status }: { status: PaymentLinkStatus }) {
  const t = useTranslations("Payments.statuses");
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", TONE[status] ?? TONE.unknown)}>
      {t(status)}
    </span>
  );
}
