"use client";

/**
 * Products page: linked catalogues on top, then the mirrored products with
 * search, availability and catalogue filters. Prices are formatted from
 * integer minor units with lib/commerce/money.
 */

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, Package, Search } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useCan } from "@/hooks/use-can";
import { CatalogManager } from "./catalog-manager";
import { fetchProducts, type CatalogPublic, type ProductFilter, type ProductPublic } from "./catalog-api";
import { productPrice } from "./product-picker";

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
  const select = "h-9 rounded-md border border-border bg-muted px-2 text-sm text-foreground";

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <header>
        <h1 className="text-2xl font-semibold text-foreground">{t("title")}</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t("description")}</p>
      </header>

      <CatalogManager canManage={canManage} onChanged={setCatalogs} />

      <section className="space-y-3" aria-labelledby="products-heading">
        <h2 id="products-heading" className="text-base font-medium text-foreground">{t("listTitle")}</h2>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[12rem] flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => filterChanged(setQ)(e.target.value)} placeholder={t("search")} aria-label={t("search")} className="bg-muted pl-8" />
          </div>
          <select aria-label={t("availabilityFilter")} className={select} value={availability}
            onChange={(e) => filterChanged(setAvailability)(e.target.value as Availability)}>
            <option value="">{t("allAvailability")}</option>
            <option value="in_stock">{t("availability.in_stock")}</option>
            <option value="out_of_stock">{t("availability.out_of_stock")}</option>
            <option value="other">{t("availability.other")}</option>
          </select>
          {catalogs.length > 1 && (
            <select aria-label={t("catalogFilter")} className={select} value={catalogId} onChange={(e) => filterChanged(setCatalogId)(e.target.value)}>
              <option value="">{t("allCatalogs")}</option>
              {catalogs.map((c) => <option key={c.id} value={c.id}>{c.name || c.catalog_id}</option>)}
            </select>
          )}
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input type="checkbox" checked={hidden} onChange={(e) => filterChanged(setHidden)(e.target.checked)} />
            {t("showHidden")}
          </label>
        </div>

        {page === null ? (
          <div className="flex justify-center p-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label={t("loading")} /></div>
        ) : page.products.length === 0 ? (
          <div className="flex flex-col items-center rounded-lg border border-dashed border-border bg-card/50 px-6 py-10 text-center">
            <Package className="h-6 w-6 text-muted-foreground" />
            <p className="mt-3 text-sm text-muted-foreground">
              {failed ? t("loadError") : q || availability || catalogId ? t("noMatches") : t("empty")}
            </p>
          </div>
        ) : (
          <>
            <div className="rounded-lg border border-border bg-card">
              <Table>
                <TableHeader>
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
                            <img src={p.image_url} alt="" className="h-10 w-10 shrink-0 rounded object-cover" loading="lazy" referrerPolicy="no-referrer" />
                          ) : (
                            <span className="h-10 w-10 shrink-0 rounded bg-muted" aria-hidden />
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
