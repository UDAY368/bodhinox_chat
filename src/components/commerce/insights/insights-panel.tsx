"use client";

/**
 * Commerce -> Shop reports (store plan Phase 8, batch 7): the live view, sales by product / day / channel, the GST report with a CSV
 * download, and stock value. Admins only (the API and RLS enforce the same rule). Money is in the workspace's minor units, formatted
 * here; every table is the numbers a spreadsheet would hold, and the live view is an aggregate counter with no visitor data.
 */
import { useCallback, useEffect, useState } from "react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { Download, Loader2, Users } from "lucide-react";
import { authFetch } from "@/lib/auth/client";
import { useCan } from "@/hooks/use-can";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataTable, Panel, ReportState, reportQuery, useReport } from "@/components/analytics/shared";
import { formatMoney } from "@/lib/format/money";
import type { LiveView } from "@/lib/commerce/shop-live";
import type { SalesReport, StockValueReport, TaxReport } from "@/lib/commerce/shop-reports";
import { LIVE_WINDOW_MINUTES } from "@/lib/commerce/shop-insights-rules";
import { OptionSelect } from "@/components/ui/option-select";
import { PageHeader } from "@/components/ui/page-header";

const PRESETS = ["7d", "30d", "90d", "this_month", "last_month", "custom"] as const;
type Preset = (typeof PRESETS)[number];
const LIVE_POLL_MS = 15_000;

export function InsightsPanel() {
  const t = useTranslations("Commerce.insights");
  const canView = useCan("edit-settings");
  const [preset, setPreset] = useState<Preset>("30d");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  if (!canView) return <p className="text-sm text-muted-foreground">{t("adminOnly")}</p>;
  const custom = preset === "custom";
  const ready = !custom || (from !== "" && to !== "" && from <= to);
  const query = reportQuery({ preset, from: custom ? from : null, to: custom ? to : null });
  return (
    <div className="mx-auto w-full max-w-[1200px] min-w-0 space-y-4">
      <PageHeader className="mb-0" title={t("title")} subtitle={t("description")} />
      <LivePanel />
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card p-4">
        <div className="space-y-1.5">
          <Label htmlFor="insights-range">{t("range.label")}</Label>
          <OptionSelect fit
            id="insights-range"
            value={preset}
            onValueChange={(v) => setPreset(v as Preset)}
            options={[
              ...PRESETS.map((p) => ({ value: p, label: t(`range.${p}`) })),
            ]}
          />
        </div>
        {custom && (
          <>
            <div className="space-y-1.5"><Label htmlFor="insights-from">{t("range.from")}</Label><Input id="insights-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
            <div className="space-y-1.5"><Label htmlFor="insights-to">{t("range.to")}</Label><Input id="insights-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
          </>
        )}
        <p className="text-xs text-muted-foreground">{t("range.cap")}</p>
      </div>
      {ready ? (
        <>
          <SalesPanel query={query} />
          <TaxPanel query={query} />
          <StockPanel />
        </>
      ) : <p className="text-sm text-muted-foreground">{t("range.pick")}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------

function LivePanel() {
  const t = useTranslations("Commerce.insights.live");
  const [live, setLive] = useState<LiveView | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    try {
      const res = await authFetch("/api/commerce/insights/live", { cache: "no-store" });
      if (!res.ok) throw new Error("live");
      setLive(((await res.json()) as { live: LiveView }).live);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    const tick = () => { if (document.visibilityState === "visible") void load(); };
    tick();
    const timer = window.setInterval(tick, LIVE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);
  const pageName = (p: { page: string; name: string | null }) => {
    const [kind] = p.page.split(":");
    if (kind === "product" || kind === "category") return p.name ?? t(`unknown.${kind}`);
    const key = `pages.${kind === "page" ? p.page.slice(5) : p.page}`;
    return t.has(key as never) ? t(key as never) : p.page;
  };
  const peak = Math.max(1, ...(live?.perMinute ?? [0]));
  return (
    <Panel title={t("title")} description={t("description")}>
      {!live && !failed ? <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label={t("loading")} />
        : failed && !live ? <p role="alert" className="text-sm text-muted-foreground">{t("failed")}</p> : live && (
          <div className="grid gap-4 @container sm:grid-cols-[minmax(0,14rem)_1fr]">
            <div>
              <p className="flex items-center gap-2 text-3xl font-semibold tabular-nums"><Users className="size-6 text-muted-foreground" aria-hidden />{live.active}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t("active")}</p>
              <div className="mt-3 flex h-10 items-end gap-1" role="img" aria-label={t("chart", { minutes: LIVE_WINDOW_MINUTES })}>
                {live.perMinute.map((n, i) => <i key={i} className="block flex-1 rounded-sm bg-primary/70" style={{ height: `${Math.max(6, (n / peak) * 100)}%` }} />)}
              </div>
            </div>
            <div>
              <h3 className="text-xs font-semibold text-muted-foreground">{t("topPages", { minutes: LIVE_WINDOW_MINUTES })}</h3>
              {live.labelled.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">{t("none")}</p> : (
                <ul className="mt-2 grid gap-1 text-sm">
                  {live.labelled.map((p) => (
                    <li key={p.page} className="flex justify-between gap-3"><span className="truncate">{pageName(p)}</span><b className="tabular-nums">{p.hits}</b></li>
                  ))}
                </ul>
              )}
            </div>
            <p className="text-xs text-muted-foreground sm:col-span-2">{t("privacy")}</p>
          </div>
        )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------

function SalesPanel({ query }: { query: string }) {
  const t = useTranslations("Commerce.insights.sales");
  const tSource = useTranslations("Commerce.orders.sources");
  const locale = useLocale();
  const format = useFormatter();
  const report = useReport<{ sales: SalesReport }>("shop-sales", query);
  const s = report.data?.sales ?? null;
  const money = (minor: number, currency: string) => formatMoney(minor, currency, { locale });
  const empty = !!s && s.byDay.length === 0 && s.byProduct.length === 0;
  return (
    <Panel title={t("title")} description={t("description")}>
      <ReportState loading={report.loading} error={report.error} onRetry={report.retry} empty={empty}>
        {s && (
          <div className="space-y-5">
            <DataTable caption={t("byChannel")} captionHidden={false} columns={[t("channel"), t("orders"), t("net")]}
              rows={s.byChannel.map((r) => [(tSource.has(r.channel as never) ? tSource(r.channel as never) : r.channel), format.number(r.orders), money(r.netMinor, r.currency)])} />
            <DataTable caption={t("byProduct")} captionHidden={false} columns={[t("product"), t("units"), t("gross"), t("refunds"), t("net")]}
              rows={s.byProduct.map((r) => [r.name, format.number(r.units), money(r.grossMinor, r.currency), money(r.refundsMinor, r.currency), money(r.netMinor, r.currency)])} />
            {s.productsTruncated && <p className="text-xs text-muted-foreground">{t("truncated")}</p>}
            <DataTable caption={t("byDay")} captionHidden={false} columns={[t("day"), t("orders"), t("net")]}
              rows={s.byDay.map((r) => [r.day, format.number(r.orders), money(r.netMinor, r.currency)])} />
            <p className="text-xs text-muted-foreground">{t("note")}</p>
          </div>
        )}
      </ReportState>
    </Panel>
  );
}

function TaxPanel({ query }: { query: string }) {
  const t = useTranslations("Commerce.insights.tax");
  const locale = useLocale();
  const format = useFormatter();
  const report = useReport<{ tax: TaxReport }>("shop-tax", query);
  const tax = report.data?.tax ?? null;
  const money = (minor: number, currency: string) => formatMoney(minor, currency, { locale });
  const empty = !!tax && tax.rates.length === 0 && tax.months.length === 0;
  return (
    <Panel title={t("title")} description={t("description")}
      actions={<a href={`/api/analytics/shop-tax/export?${query}`} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-input px-3 text-xs font-medium hover:bg-muted"><Download className="size-3.5" aria-hidden />{t("download")}</a>}>
      <ReportState loading={report.loading} error={report.error} onRetry={report.retry} empty={empty}>
        {tax && (
          <div className="space-y-5">
            <DataTable caption={t("byRate")} captionHidden={false} columns={[t("month"), t("rate"), t("taxable"), t("tax"), t("cgst"), t("sgst"), t("igst")]}
              rows={tax.rates.map((r) => [r.month, r.rateBps === null ? t("noRate") : `${format.number(r.rateBps / 100)}%`,
                money(r.taxableMinor, r.currency), money(r.taxMinor, r.currency), money(r.cgstMinor, r.currency), money(r.sgstMinor, r.currency), money(r.igstMinor, r.currency)])} />
            <DataTable caption={t("totals")} captionHidden={false} columns={[t("month"), t("receipts"), t("tax"), t("cgst"), t("sgst"), t("igst"), t("creditNotes"), t("creditTax")]}
              rows={tax.months.map((m) => [m.month, format.number(m.receipts), money(m.taxMinor, m.currency), money(m.cgstMinor, m.currency), money(m.sgstMinor, m.currency),
                money(m.igstMinor, m.currency), format.number(m.creditNotes), money(-m.creditTaxMinor, m.currency)])} />
            <p className="text-xs text-muted-foreground">{t("note")}</p>
          </div>
        )}
      </ReportState>
    </Panel>
  );
}

function StockPanel() {
  const t = useTranslations("Commerce.insights.stock");
  const locale = useLocale();
  const format = useFormatter();
  // Stock is as of now: the range does not apply.
  const report = useReport<{ stock: StockValueReport }>("shop-stock", "");
  const stock = report.data?.stock ?? null;
  const empty = !!stock && stock.costed.length === 0 && stock.noCost.length === 0;
  return (
    <Panel title={t("title")} description={t("description")}>
      <ReportState loading={report.loading} error={report.error} onRetry={report.retry} empty={empty}>
        {stock && (
          <div className="space-y-5">
            {stock.totals.length > 0 && (
              <dl className="flex flex-wrap gap-x-8 gap-y-2">
                {stock.totals.map((total) => (
                  <div key={total.currency}><dt className="text-xs text-muted-foreground">{t("total", { units: format.number(total.units) })}</dt>
                    <dd className="text-xl font-semibold tabular-nums">{formatMoney(total.valueMinor, total.currency, { locale })}</dd></div>
                ))}
              </dl>
            )}
            {stock.costed.length > 0 && (
              <DataTable caption={t("costed")} captionHidden={false} columns={[t("product"), t("onHand"), t("unitCost"), t("value")]}
                rows={stock.costed.map((r) => [`${r.name} (${r.sku})`, format.number(r.onHand), formatMoney(r.unitCostMinor, r.currency, { locale }), formatMoney(r.valueMinor, r.currency, { locale })])} />
            )}
            {stock.noCost.length > 0 && (
              <div>
                <p className="text-xs text-muted-foreground">{t("noCostHint")}</p>
                <DataTable caption={t("noCost")} captionHidden={false} columns={[t("product"), t("onHand")]}
                  rows={stock.noCost.map((r) => [`${r.name} (${r.sku})`, format.number(r.onHand)])} />
              </div>
            )}
            {stock.truncated && <p className="text-xs text-muted-foreground">{t("truncated")}</p>}
            <p className="text-xs text-muted-foreground">{t("basis")}</p>
          </div>
        )}
      </ReportState>
    </Panel>
  );
}
