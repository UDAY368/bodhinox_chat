"use client";

/**
 * Commerce → Catalogue (design section 6): the products Bodhinox sells, with
 * categories, inventory and the Meta catalogue link. Agents and above read;
 * admins edit (the API and RLS enforce it, the screen only hides controls).
 * Prices are integer minor units in the store currency.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, Loader2, Package, Plus, Search } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useCan } from "@/hooks/use-can";
import { CategoriesPanel } from "./categories-panel";
import { InventoryPanel } from "./inventory-panel";
import { MetaLinkPanel } from "./meta-link-panel";
import { priceRange } from "./catalogue-format";
import {
  createShopProduct, fetchCategories, fetchShopProducts,
  type ApiResult, type ProductListFilter, type ShopCategory, type ShopProductSummary,
} from "./catalogue-api";

const PAGE = 50;
const TABS = ["products", "categories", "inventory", "meta"] as const;
type Tab = (typeof TABS)[number];
export const selectClass = "h-9 rounded-lg border border-border bg-card px-2.5 text-sm text-foreground";

/** The translated message for a failed call (Commerce.catalogue.errors.<code>, else by HTTP status). */
export function useCatalogueError() {
  const t = useTranslations("Commerce.catalogue.errors");
  return useCallback((r: ApiResult<unknown>) => {
    if (r.ok) return "";
    if (r.code && t.has(r.code)) return t(r.code);
    if (r.status === 403) return t("forbidden");
    if (r.status === 429) return t("rate_limited");
    return t("generic");
  }, [t]);
}

export function StatusBadge({ status }: { status: ShopProductSummary["status"] }) {
  const t = useTranslations("Commerce.catalogue.statuses");
  return <Badge variant={status === "published" ? "default" : status === "archived" ? "outline" : "secondary"}>{t(status)}</Badge>;
}

export function CatalogueAdmin() {
  const t = useTranslations("Commerce.catalogue");
  const [tab, setTab] = useState<Tab>("products");
  const canManage = useCan("edit-settings");
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-[22px] font-bold tracking-tight text-foreground">{t("title")}</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t("description")}</p>
      </header>
      <div role="tablist" aria-label={t("title")} className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map((key) => (
          <button key={key} role="tab" type="button" aria-selected={tab === key} onClick={() => setTab(key)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === key ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
            {t(`tabs.${key}`)}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === "products" && <ProductsTab canManage={canManage} />}
        {tab === "categories" && <CategoriesPanel canManage={canManage} />}
        {tab === "inventory" && <InventoryPanel canManage={canManage} />}
        {tab === "meta" && <MetaLinkPanel canManage={canManage} />}
      </div>
    </div>
  );
}

function stockLabel(p: ShopProductSummary, t: ReturnType<typeof useTranslations>): string {
  if (p.tracked_count === 0) return p.untracked_count > 0 ? t("madeToOrder") : "—";
  return t("available", { count: p.available });
}

function ProductsTab({ canManage }: { canManage: boolean }) {
  const t = useTranslations("Commerce.catalogue.products");
  const tStatus = useTranslations("Commerce.catalogue.statuses");
  const errorText = useCatalogueError();
  const locale = useLocale();
  const router = useRouter();
  const [filter, setFilter] = useState<ProductListFilter>({});
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<{ products: ShopProductSummary[]; total: number; currency: string | null } | null>(null);
  const [failed, setFailed] = useState(false);
  const [categories, setCategories] = useState<ShopCategory[]>([]);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    fetchCategories().then((r) => { if (r.ok) setCategories(r.data.filter((c) => !c.archived)); });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      fetchShopProducts({ ...filter, limit: PAGE, offset }).then((r) => {
        if (cancelled) return;
        setPage(r.ok ? r.data : { products: [], total: 0, currency: null });
        setFailed(!r.ok);
      });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [filter, offset]);

  const update = (patch: ProductListFilter) => { setFilter((f) => ({ ...f, ...patch })); setOffset(0); };

  const create = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    const r = await createShopProduct({ name: newName.trim() });
    setCreating(false);
    if (!r.ok) { toast.error(errorText(r)); return; }
    setNewName("");
    router.push(`/commerce/catalogue/${r.data.id}`);
  };

  return (
    <section className="space-y-3">
      {canManage && (
        <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <Input value={newName} maxLength={200} onChange={(e) => setNewName(e.target.value)} placeholder={t("newName")}
            aria-label={t("newName")} className="max-w-xs bg-muted" />
          <Button type="submit" disabled={creating || !newName.trim()}>
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}{t("create")}
          </Button>
        </form>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={filter.q ?? ""} onChange={(e) => update({ q: e.target.value })} placeholder={t("search")} aria-label={t("search")} className="pl-8" />
        </div>
        <select aria-label={t("statusFilter")} className={selectClass} value={filter.status ?? ""}
          onChange={(e) => update({ status: (e.target.value || undefined) as ProductListFilter["status"] })}>
          <option value="">{t("activeStatuses")}</option>
          <option value="draft">{tStatus("draft")}</option>
          <option value="published">{tStatus("published")}</option>
          <option value="archived">{tStatus("archived")}</option>
          <option value="all">{t("allStatuses")}</option>
        </select>
        <select aria-label={t("stockFilter")} className={selectClass} value={filter.stock ?? ""}
          onChange={(e) => update({ stock: (e.target.value || undefined) as ProductListFilter["stock"] })}>
          <option value="">{t("allStock")}</option>
          <option value="in_stock">{t("stock.in_stock")}</option>
          <option value="low">{t("stock.low")}</option>
          <option value="out">{t("stock.out")}</option>
        </select>
        {categories.length > 0 && (
          <select aria-label={t("categoryFilter")} className={selectClass} value={filter.categoryId ?? ""}
            onChange={(e) => update({ categoryId: e.target.value || undefined })}>
            <option value="">{t("allCategories")}</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.parent_id ? `— ${c.name}` : c.name}</option>)}
          </select>
        )}
      </div>

      {page === null ? (
        <div className="flex justify-center p-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label={t("loading")} /></div>
      ) : page.products.length === 0 ? (
        <div className="flex flex-col items-center rounded-xl border border-dashed border-border px-6 py-10 text-center">
          <span className="flex size-[52px] items-center justify-center rounded-2xl bg-primary/10 text-primary"><Package className="size-6" /></span>
          <p className="mt-3 text-sm text-muted-foreground">
            {failed ? t("loadError") : filter.q || filter.status || filter.stock || filter.categoryId ? t("noMatches") : t("empty")}
          </p>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <Table className="[&_td]:px-3.5 [&_td]:py-2.5">
              <TableHeader className="bg-muted [&_th]:h-9 [&_th]:px-3.5 [&_th]:text-xs [&_th]:font-semibold [&_th]:text-muted-foreground">
                <TableRow>
                  <TableHead>{t("colProduct")}</TableHead>
                  <TableHead>{t("colStatus")}</TableHead>
                  <TableHead className="text-right">{t("colPrice")}</TableHead>
                  <TableHead>{t("colStock")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {page.products.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="max-w-[20rem]">
                      <Link href={`/commerce/catalogue/${p.id}`} className="flex items-center gap-3 hover:underline">
                        {p.image_url ? (
                          // eslint-disable-next-line @next/next/no-img-element -- seller-provided https or library images, not optimisable here
                          <img src={p.image_url} alt="" className="h-10 w-10 shrink-0 rounded-lg object-cover" loading="lazy" referrerPolicy="no-referrer" />
                        ) : (
                          <span className="h-10 w-10 shrink-0 rounded-lg bg-muted" aria-hidden />
                        )}
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-foreground">{p.name}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {[p.category_name, t("variants", { count: p.variant_count })].filter(Boolean).join(" · ")}
                          </span>
                        </span>
                      </Link>
                    </TableCell>
                    <TableCell><StatusBadge status={p.status} /></TableCell>
                    <TableCell className="text-right tabular-nums">
                      {priceRange(p.min_price_minor, p.max_price_minor, page.currency, locale) ?? t("noPrice")}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      <span className="mr-2">{stockLabel(p, t)}</span>
                      {p.low_count > 0 && <Badge variant="destructive">{p.available === 0 ? t("stock.out") : t("stock.low")}</Badge>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{t("range", { from: offset + 1, to: offset + page.products.length, total: page.total })}</span>
            <div className="flex gap-1">
              <Button variant="ghost" size="icon-sm" aria-label={t("previous")} disabled={offset === 0} onClick={() => setOffset(Math.max(offset - PAGE, 0))}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label={t("next")} disabled={offset + page.products.length >= page.total} onClick={() => setOffset(offset + PAGE)}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
