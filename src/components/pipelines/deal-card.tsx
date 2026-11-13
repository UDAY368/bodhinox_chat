"use client";

import type { Deal, PipelineStage } from "@/types";
import { Calendar, Check, X } from "lucide-react";
import { formatCurrency } from "@/lib/currency";
import { useTranslations } from "next-intl";

interface DealCardProps {
  deal: Deal;
  stage: PipelineStage | null;
  onEdit: (deal: Deal) => void;
  isOverlay?: boolean;
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function initials(name?: string, fallback?: string) {
  const source = (name || fallback || "?").trim();
  if (!source) return "?";
  return source.charAt(0).toUpperCase();
}

export function DealCard({ deal, stage, onEdit, isOverlay }: DealCardProps) {
  const t = useTranslations("Pipelines.card");
  const contactLabel = deal.contact?.name || deal.contact?.phone || t("noContact");
  const assigneeLabel = deal.assignee?.full_name || null;

  return (
    <button
      type="button"
      onClick={(e) => {
        // `onClick` still fires after a non-drag tap because the PointerSensor
        // requires 5px movement before it counts as a drag.
        if (isOverlay) return;
        e.stopPropagation();
        onEdit(deal);
      }}
      className={`group relative flex w-full cursor-grab flex-col gap-2 rounded-xl border border-border bg-card py-2.5 pl-3 pr-2.5 text-left transition-[box-shadow,opacity] duration-150 focus-visible:outline-2 focus-visible:outline-primary ${
        isOverlay
          ? "shadow-[0_12px_32px_rgb(0_0_0/0.16)]"
          : "hover:shadow-[0_1px_2px_rgb(0_0_0/0.06),0_4px_14px_rgb(0_0_0/0.06)]"
      }`}
    >
      <div className="flex items-start justify-between gap-1.5">
        <span className="flex min-w-0 flex-1 items-start gap-2">
          <span
            aria-hidden
            className="mt-[5px] size-2 shrink-0 rounded-full"
            style={{ backgroundColor: stage?.color ?? "var(--muted-foreground)" }}
          />
          <h4 className="min-w-0 flex-1 text-sm font-semibold leading-snug text-foreground break-words">
            {deal.title}
          </h4>
        </span>
        {deal.status === "won" && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/12 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
            <Check className="h-3 w-3" />
            {t("won")}
          </span>
        )}
        {deal.status === "lost" && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive">
            <X className="h-3 w-3" />
            {t("lost")}
          </span>
        )}
      </div>

      {/* Contact row */}
      <div className="flex min-w-0 items-center gap-[7px] text-[13px] text-muted-foreground">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-foreground">
          {initials(deal.contact?.name, deal.contact?.phone)}
        </span>
        <span className="truncate">{contactLabel}</span>
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold tabular-nums text-foreground">
          {formatCurrency(deal.value, deal.currency)}
        </span>
        <span className="flex items-center gap-2">
          {deal.expected_close_date && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Calendar className="h-3 w-3" />
              {formatDate(deal.expected_close_date)}
            </span>
          )}
          {assigneeLabel && (
            <span
              title={assigneeLabel}
              className="flex size-5 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary"
            >
              {initials(assigneeLabel)}
            </span>
          )}
        </span>
      </div>
    </button>
  );
}
