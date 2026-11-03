"use client";

import { useFormatter, useLocale, useTranslations } from "next-intl";
import { FileText } from "lucide-react";

import { formatMoney } from "@/lib/commerce/money";
import { isOrderStatus } from "@/lib/commerce/order-format";
import { documentUrl, type OrderTimeline } from "./order-api";

const KNOWN_EVENTS = new Set([
  "status_changed", "feedback", "document_issued", "return_requested", "return_received", "return_inspected", "return_closed",
  "return_rejected", "return_refund_requested",
]);

/** The order's history, its documents and how each customer notice went. */
export function OrderTimelinePanel({ timeline }: { timeline: OrderTimeline | null }) {
  const t = useTranslations("Commerce.orders.timeline");
  const tStatus = useTranslations("Commerce.orders.statuses");
  const format = useFormatter();
  const locale = useLocale();
  if (!timeline) return null;
  const status = (s: string | null) => (s && isOrderStatus(s) ? tStatus(s) : s ?? "");
  const money = (minor: number, currency: string) => {
    try {
      return formatMoney(minor, currency, locale);
    } catch {
      return `${currency} ${minor}`;
    }
  };

  return (
    <div className="space-y-4">
      {timeline.documents.length > 0 && (
        <div className="space-y-2 rounded-lg border border-border bg-card p-4">
          <h2 className="text-sm font-medium text-foreground">{t("documents")}</h2>
          <ul className="space-y-1">
            {timeline.documents.map((d) => (
              <li key={d.id}>
                <a href={documentUrl(d.id)} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
                  <FileText className="h-4 w-4" />
                  {t(`documentKinds.${d.kind}`)} {d.number} · {money(d.total_minor, d.currency)}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-2 rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-medium text-foreground">{t("title")}</h2>
        {timeline.events.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("empty")}</p>
        ) : (
          <ol className="space-y-2 border-l border-border pl-3">
            {timeline.events.map((e) => (
              <li key={e.id} className="text-sm">
                <div className="text-foreground">
                  {e.kind === "status_changed"
                    ? t("statusChanged", { from: status(e.from_status), to: status(e.to_status) })
                    : KNOWN_EVENTS.has(e.kind) ? t(`events.${e.kind}`) : t("events.other", { kind: e.kind })}
                </div>
                <div className="text-xs text-muted-foreground">
                  {format.dateTime(new Date(e.created_at), { dateStyle: "medium", timeStyle: "short" })}
                  {" · "}
                  {e.actor === "staff" ? t("byStaff", { name: e.actor_name ?? t("teamMember") }) : t(`actors.${e.actor === "customer" ? "customer" : "system"}`)}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>

      {timeline.messages.length > 0 && (
        <div className="space-y-2 rounded-lg border border-border bg-card p-4">
          <h2 className="text-sm font-medium text-foreground">{t("messages")}</h2>
          <ul className="space-y-1 text-sm">
            {timeline.messages.map((m) => (
              <li key={m.kind} className="flex flex-wrap justify-between gap-2">
                <span>{t.has(`messageKinds.${m.kind}`) ? t(`messageKinds.${m.kind}`) : m.kind}</span>
                <span className="text-xs text-muted-foreground">
                  {t.has(`messageStatuses.${m.status}`) ? t(`messageStatuses.${m.status}`) : m.status}
                  {m.reason ? ` · ${m.reason}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
