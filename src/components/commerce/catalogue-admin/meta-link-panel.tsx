"use client";

/**
 * The Meta catalogue link: Bodhinox variants are matched to the mirrored Meta
 * products by SKU = content id. Unmatched Meta products can be imported as
 * drafts (admins); nothing existing is overwritten and nothing is published.
 */

import { useCallback, useEffect, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/commerce/money";
import { fetchMetaLink, importMetaProducts, type MetaLinkReport } from "./catalogue-api";
import { useCatalogueError } from "./catalogue-admin";

const IMPORT_MAX = 100;

export function MetaLinkPanel({ canManage }: { canManage: boolean }) {
  const t = useTranslations("Commerce.catalogue.meta");
  const locale = useLocale();
  const errorText = useCatalogueError();
  const [report, setReport] = useState<MetaLinkReport | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetchMetaLink();
    if (!r.ok) toast.error(errorText(r));
    setReport(r.ok ? r.data : { currency: null, linked: [], variants_without_meta: [], meta_without_variant: [] });
    setSelected(new Set());
  }, [errorText]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load on mount, as the other dashboard panels do
    void load();
  }, [load]);

  const money = (minor: number | null, currency: string | null) => (minor !== null && currency ? formatMoney(minor, currency, locale) : "—");

  const runImport = async () => {
    setBusy(true);
    const r = await importMetaProducts([...selected].slice(0, IMPORT_MAX));
    setBusy(false);
    if (!r.ok) { toast.error(errorText(r)); return; }
    toast.success(t("imported", { count: r.data.created.length, skipped: r.data.skipped.length }));
    await load();
  };

  if (report === null) return <div className="flex justify-center p-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  const importable = report.meta_without_variant.filter((m) => m.importable);
  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else if (next.size < IMPORT_MAX) next.add(id);
    return next;
  });

  return (
    <section className="space-y-6">
      <p className="max-w-2xl text-sm text-muted-foreground">{t("description")}</p>

      <div className="space-y-2">
        <h2 className="text-base font-medium text-foreground">{t("linked", { count: report.linked.length })}</h2>
        {report.linked.length === 0 ? <p className="text-sm text-muted-foreground">{t("none")}</p> : (
          <ul className="divide-y divide-border rounded-lg border border-border bg-card text-sm">
            {report.linked.map((l) => (
              <li key={l.variant_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <span className="font-mono text-xs text-muted-foreground">{l.sku}</span>
                <span className="text-foreground">{l.product_name}</span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {t("prices", { ours: money(l.price_minor, report.currency), meta: money(l.meta_price_minor, l.meta_currency) })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2">
        <h2 className="text-base font-medium text-foreground">{t("variantsWithout", { count: report.variants_without_meta.length })}</h2>
        {report.variants_without_meta.length === 0 ? <p className="text-sm text-muted-foreground">{t("none")}</p> : (
          <ul className="flex flex-wrap gap-2 text-xs">
            {report.variants_without_meta.map((v) => (
              <li key={v.variant_id} className="rounded border border-border px-2 py-1"><span className="font-mono">{v.sku}</span> · {v.product_name}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-medium text-foreground">{t("metaWithout", { count: report.meta_without_variant.length })}</h2>
          {canManage && importable.length > 0 && (
            <>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set(importable.slice(0, IMPORT_MAX).map((m) => m.meta_product_id)))}>
                {t("selectAll")}
              </Button>
              <Button size="sm" disabled={busy || selected.size === 0} onClick={() => void runImport()}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}{t("import", { count: selected.size })}
              </Button>
            </>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{t("importHint")}</p>
        {report.meta_without_variant.length === 0 ? <p className="text-sm text-muted-foreground">{t("none")}</p> : (
          <ul className="divide-y divide-border rounded-lg border border-border bg-card text-sm">
            {report.meta_without_variant.map((m) => (
              <li key={m.meta_product_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                {canManage && (
                  <input type="checkbox" aria-label={m.name} disabled={!m.importable} checked={selected.has(m.meta_product_id)}
                    onChange={() => toggle(m.meta_product_id)} />
                )}
                <span className="font-mono text-xs text-muted-foreground">{m.retailer_id}</span>
                <span className="text-foreground">{m.name}</span>
                {!m.importable && <span className="text-xs text-destructive">{t("notImportable")}</span>}
                <span className="ml-auto text-xs text-muted-foreground">{money(m.price_minor, m.currency)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
