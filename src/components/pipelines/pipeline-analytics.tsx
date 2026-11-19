"use client";

import { useMemo } from "react";
import type { PipelineStage } from "@/types";
import type { CurrencyTotal, OverviewRow } from "@/lib/pipelines/board";
import { analyzeOverview, summarizeOverview } from "@/lib/pipelines/board-summary";
import { Info } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAuth } from "@/hooks/use-auth";
import { formatCurrency } from "@/lib/currency";
import { useTranslations } from "next-intl";

/** Amounts per currency side by side ("₹12,000 · $300"); zero in the workspace currency when empty. */
export function formatTotals(totals: CurrencyTotal[], fallbackCurrency: string): string {
  if (totals.length === 0) return formatCurrency(0, fallbackCurrency);
  return totals.map((t) => formatCurrency(t.total, t.currency)).join(" · ");
}

interface PipelineAnalyticsProps {
  stages: PipelineStage[];
  /** The board's SQL aggregate (status x stage x currency) under the current filters. */
  overview: OverviewRow[];
}

export function PipelineAnalytics({ stages, overview }: PipelineAnalyticsProps) {
  const t = useTranslations("Pipelines.analytics");
  const { defaultCurrency } = useAuth();
  const stats = useMemo(() => analyzeOverview(overview, stages), [overview, stages]);

  return (
    <TooltipProvider>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 xl:grid-cols-6">
        <Metric label={t("totalDeals")} value={String(stats.totalCount)} tooltip={t("totalDealsTooltip")} t={t} />
        <Metric label={t("pipelineValue")} value={formatTotals(stats.value, defaultCurrency)} tooltip={t("pipelineValueTooltip")} t={t} />
        <Metric label={t("avgDealSize")} value={formatTotals(stats.average, defaultCurrency)} tooltip={t("avgDealSizeTooltip")} t={t} />
        <Metric label={t("weightedValue")} value={formatTotals(stats.weighted, defaultCurrency)} tooltip={t("weightedValueTooltip")} t={t} />
        <Metric label={t("wonThisMonth")} value={String(stats.wonThisMonth)} tooltip={t("wonThisMonthTooltip")} t={t} />
        <Metric label={t("lostThisMonth")} value={String(stats.lostThisMonth)} tooltip={t("lostThisMonthTooltip")} t={t} />
      </div>
    </TooltipProvider>
  );
}

/** The Sales board's three summary cards: open value, won value and win rate, from SQL totals per currency. */
export function PipelineSummary({ overview }: { overview: OverviewRow[] }) {
  const t = useTranslations("Sales.pipeline");
  const { defaultCurrency } = useAuth();
  const s = useMemo(() => summarizeOverview(overview), [overview]);
  const card = "flex min-w-0 flex-col gap-1 rounded-xl border border-border bg-card px-3 py-2.5 sm:px-4 sm:py-3.5";
  const value = "break-words text-[17px] font-bold tracking-tight tabular-nums text-foreground sm:text-[22px]";
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3">
      <div className={card}>
        <span className="text-xs font-medium text-muted-foreground">{t("openDeals")}</span>
        <p className={value}>{formatTotals(s.open, defaultCurrency)}</p>
        <span className="text-xs text-muted-foreground">{t("dealsCount", { count: s.openCount })}</span>
      </div>
      <div className={card}>
        <span className="text-xs font-medium text-muted-foreground">{t("won")}</span>
        <p className={value}>{formatTotals(s.won, defaultCurrency)}</p>
        <span className="text-xs text-muted-foreground">{t("dealsCount", { count: s.wonCount })}</span>
      </div>
      <div className={`${card} col-span-2 sm:col-span-1`}>
        <span className="text-xs font-medium text-muted-foreground">{t("winRate")}</span>
        <p className={value}>{s.winRate === null ? "–" : `${s.winRate}%`}</p>
        <span className="text-xs text-muted-foreground">{t("lostCount", { count: s.lostCount })}</span>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  tooltip,
  t,
}: {
  label: string;
  value: string;
  tooltip: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-xl border border-border bg-card px-3 py-2.5 sm:px-4 sm:py-3.5">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <span className="truncate">{label}</span>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={t("howCalculated", { label })}
                className="ml-auto text-muted-foreground hover:text-foreground focus:outline-none"
              />
            }
          >
            <Info className="h-3 w-3" />
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs text-left">
            {tooltip}
          </TooltipContent>
        </Tooltip>
      </div>
      <p className="break-words text-[17px] font-bold tracking-tight tabular-nums text-foreground sm:text-[22px]">{value}</p>
    </div>
  );
}
