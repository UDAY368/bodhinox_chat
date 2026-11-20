"use client";

import { useTranslations } from "next-intl";

import type { OrderListItem } from "./order-api";
import type { Tone } from "@/lib/commerce/order-state";
import { StateBadge } from "./state-badge";

const RISK_TONE: Record<NonNullable<OrderListItem["risk"]>["level"], Tone> = { low: "ok", medium: "warn", high: "bad" };

/** The order's risk hint: a badge, and with `showReasons` the reasons under it. The list shows it only above low. */
export function OrderRiskBadge({ risk, showReasons = false }: { risk: OrderListItem["risk"]; showReasons?: boolean }) {
  const t = useTranslations("Commerce.orders.risk");
  if (!risk || (!showReasons && risk.level === "low")) return null;
  const reasons = risk.reasons.map((r) => t(`reasons.${r}`));
  return (
    <div className="space-y-1">
      <span title={reasons.join("\n") || undefined}>
        <StateBadge tone={RISK_TONE[risk.level]}>{t(`level.${risk.level}`)}</StateBadge>
      </span>
      {showReasons && (
        <>
          {reasons.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
              {reasons.map((r) => <li key={r}>{r}</li>)}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">{t("help")}</p>
        </>
      )}
    </div>
  );
}
