"use client";

/**
 * Products page: linked catalogues on top, then the mirrored products with
 * search, availability and catalogue filters. Prices are formatted from
 * integer minor units with lib/commerce/money.
 */

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Package, Search } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useCan } from "@/hooks/use-can";
import { CatalogManager } from "./catalog-manager";
import { fetchProducts, type CatalogPublic, type ProductFilter, type ProductPublic } from "./catalog-api";
import { productPrice } from "./product-picker";
import { OptionSelect } from "@/components/commerce/option-select";
import { Checkbox } from "@/components/ui/checkbox";
import { PageHeader } from "@/components/ui/page-header";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { PageLoading } from "@/components/ui/page-loading";
import { EmptyState } from "@/components/ui/empty-state";
import { InlineError } from "@/components/ui/inline-error";

const PAGE = 50;
type Availability = NonNullable<ProductFilter["availability"]> | "";

/** Which availability label a product gets (Commerce.catalog.products.availability.*). */
export function availabilityKey(value: string | null): "in_stock" | "out_of_stock" | "other" {
  const v = (value ?? "").toLowerCase();
  return v === "in stock" ? "in_stock" : v === "out of stock" ? "out_of_stock" : "other";
}

export function ProductsView() {
  const t = useTranslations("Commerce.catalog.products");
  const locale = useLocale();
  const canManage = useCan("edit-settings");
  const [catalogs, setCatalogs] = useState<CatalogPublic[]>([]);
  const [q, setQ] = useState("");
  const [availability, setAvailability] = useState<Availability>("");
  const [catalogId, setCatalogId] = useState("");
  const [hidden, setHidden] = useState(false);
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<{ products: ProductPublic[]; total: number } | null>(null);
  const [failed, setFailed] = useState(false);
  // A connect, unlink, refresh or finished sync changes a catalogue card: reload the products then too.
  const syncKey = catalogs.map((c) => `${c.id}:${c.last_synced_at ?? ""}:${c.product_count}`).join("|");

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      fetchProducts({ q, availability: availability || undefined, catalogId: catalogId || undefined, hidden, limit: PAGE, offset })
        .then((result) => {
          if (cancelled) return;
          setPage(result);
          setFailed(false);
        })
        .catch(() => {
          if (cancelled) return;
          setPage({ products: [], total: 0 });
          setFailed(true);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q, availability, catalogId, hidden, offset, syncKey]);

  const filterChanged = <V,>(set: (v: V) => void) => (v: V) => {
    set(v);
    setOffset(0);
  };

  return (
    <div className="space-y-5">
      <PageHeader className="mb-0" title={t("title")} subtitle={t("description")} />

      <CatalogManager canManage={canManage} onChanged={setCatalogs} />

      <section className="space-y-3" aria-labelledby="products-heading">
        <h2 id="products-heading" className="text-base font-semibold tracking-tight text-foreground">{t("listTitle")}</h2>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[12rem] flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => filterChanged(setQ)(e.target.value)} placeholder={t("search")} aria-label={t("search")} className="pl-8" />
          </div>
          <SegmentedControl
            aria-label={t("availabilityFilter")}
            value={availability}
            onValueChange={(v) => filterChanged(setAvailability)(v as Availability)}
            options={[
              { value: "", label: t("allAvailability") },
              { value: "in_stock", label: t("availability.in_stock") },
              { value: "out_of_stock", label: t("availability.out_of_stock") },
              { value: "other", label: t("availability.other") },
            ]}
          />
          {catalogs.length > 1 && (
            <OptionSelect
              aria-label={t("catalogFilter")}
              value={catalogId}
              onValueChange={(v) => filterChanged(setCatalogId)(v)}
              options={[
                { value: "", label: t("allCatalogs") },
                ...catalogs.map((c) => ({ value: c.id, label: c.name || c.catalog_id })),
              ]}
            />
          )}
          <label className="flex min-h-11 items-center gap-2 text-xs text-muted-foreground sm:min-h-0">
            <Checkbox checked={hidden} onCheckedChange={(checked) => filterChanged(setHidden)(checked)} />
            {t("showHidden")}
          </label>
        </div>

        {page === null ? (
          <PageLoading rows={3} />
        ) : page.products.length === 0 ? (
          failed ? <InlineError message={t("loadError")} /> : (
            <EmptyState icon={Package} title={q || availability || catalogId ? t("noMatches") : t("empty")} />
          )
        ) : (
          <>
            <div className="overflow-x-auto rounded-xl border border-border bg-card">
              <Table className="[&_td]:px-3.5 [&_td]:py-2.5">
                <TableHeader className="bg-muted [&_th]:h-9 [&_th]:px-3.5 [&_th]:text-xs [&_th]:font-semibold [&_th]:text-muted-foreground">
                  <TableRow>
                    <TableHead>{t("colProduct")}</TableHead>
                    <TableHead>{t("colContentId")}</TableHead>
                    <TableHead className="text-right">{t("colPrice")}</TableHead>
                    <TableHead>{t("colAvailability")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {page.products.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="max-w-[18rem]">
                        <div className="flex items-center gap-3">
                          {p.image_url ? (
                            // eslint-disable-next-line @next/next/no-img-element -- catalogue images are on Meta's CDN, not optimisable here
                            <img src={p.image_url} alt="" className="h-10 w-10 shrink-0 rounded-lg object-cover" loading="lazy" referrerPolicy="no-referrer" />
                          ) : (
                            <span className="h-10 w-10 shrink-0 rounded-lg bg-muted" aria-hidden />
                          )}
                          <div className="min-w-0">
                            <p className="truncate font-medium text-foreground">{p.name}</p>
                            {p.is_hidden && <Badge variant="secondary">{t("hidden")}</Badge>}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">{p.retailer_id}</TableCell>
                      <TableCell className="text-right tabular-nums">{productPrice(p, locale) ?? t("noPrice")}</TableCell>
                      <TableCell className="text-muted-foreground">{t(`availability.${availabilityKey(p.availability)}`)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{t("range", { from: offset + 1, to: offset + page.products.length, total: page.total })}</span>
              <div className="flex gap-1">
                <Button variant="ghost" size="icon-sm" aria-label={t("previous")} disabled={offset === 0}
                  onClick={() => setOffset(Math.max(offset - PAGE, 0))}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="icon-sm" aria-label={t("next")} disabled={offset + page.products.length >= page.total}
                  onClick={() => setOffset(offset + PAGE)}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
