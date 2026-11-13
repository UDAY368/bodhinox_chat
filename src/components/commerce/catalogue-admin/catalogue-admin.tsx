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
import {
  Archive, ArchiveRestore, ChevronLeft, ChevronRight, Copy, Eye, EyeOff, LayoutGrid, List, Loader2, MoreHorizontal, Package, Pencil, Plus, Search,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { StateBadge } from "@/components/commerce/orders/state-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useCan } from "@/hooks/use-can";
import { CategoriesPanel } from "./categories-panel";
import { InventoryPanel } from "./inventory-panel";
import { MetaLinkPanel } from "./meta-link-panel";
import { priceRange } from "./catalogue-format";
import {
  archiveShopProduct, createShopProduct, duplicateShopProduct, fetchCategories, fetchShopProducts, publishShopProduct, unpublishShopProduct,
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
        {tab === "products" && <ProductsTab canManage={canManage} onOpenCategories={() => setTab("categories")} />}
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

const VIEW_KEY = "bodhinox.catalogue.view";

function StockState({ p }: { p: ShopProductSummary }) {
  const t = useTranslations("Commerce.catalogue.products");
  const tone = p.tracked_count > 0 && p.available === 0 && p.untracked_count === 0 ? "bad" : p.low_count > 0 ? "warn" : "neutral";
  const text = tone === "bad" ? t("stock.out") : tone === "warn" ? `${t("stock.low")} · ${stockLabel(p, t)}` : stockLabel(p, t);
  return <StateBadge tone={tone}>{text}</StateBadge>;
}

function ProductsTab({ canManage, onOpenCategories }: { canManage: boolean; onOpenCategories: () => void }) {
  const t = useTranslations("Commerce.catalogue.products");
  const ts = useTranslations("Sales.products");
  const tStatus = useTranslations("Commerce.catalogue.statuses");
  const errorText = useCatalogueError();
  const locale = useLocale();
  const router = useRouter();
  const [filter, setFilter] = useState<ProductListFilter>({});
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<{ products: ShopProductSummary[]; total: number; currency: string | null } | null>(null);
  const [failed, setFailed] = useState(false);
  const [categories, setCategories] = useState<ShopCategory[]>([]);
  const [allTotal, setAllTotal] = useState<number | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [view, setView] = useState<"grid" | "table">("grid");

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(VIEW_KEY);
       
      if (saved === "grid" || saved === "table") setView(saved);
    } catch { /* storage blocked: keep the grid */ }
  }, []);
  const chooseView = (next: "grid" | "table") => {
    setView(next);
    try { window.localStorage.setItem(VIEW_KEY, next); } catch { /* storage blocked */ }
  };

  useEffect(() => {
    fetchCategories().then((r) => { if (r.ok) setCategories(r.data.filter((c) => !c.archived)); });
  }, [reloadKey]);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      fetchShopProducts({ ...filter, limit: PAGE, offset }).then((r) => {
        if (cancelled) return;
        setPage(r.ok ? r.data : { products: [], total: 0, currency: null });
        setFailed(!r.ok);
        if (r.ok && !filter.categoryId && !filter.q && !filter.status && !filter.stock) setAllTotal(r.data.total);
      });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [filter, offset, reloadKey]);

  const update = (patch: ProductListFilter) => { setFilter((f) => ({ ...f, ...patch })); setOffset(0); };
  const refresh = () => setReloadKey((k) => k + 1);

  const create = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    const r = await createShopProduct({ name: newName.trim() });
    setCreating(false);
    if (!r.ok) { toast.error(errorText(r)); return; }
    setNewName("");
    setNewOpen(false);
    router.push(`/commerce/catalogue/${r.data.id}`);
  };

  async function act(p: ShopProductSummary, kind: "show" | "hide" | "duplicate" | "archive" | "restore") {
    setBusy(p.id);
    try {
      const r = kind === "show" ? await publishShopProduct(p.id, p.version)
        : kind === "hide" ? await unpublishShopProduct(p.id)
          : kind === "duplicate" ? await duplicateShopProduct(p.id, ts("copyName", { name: p.name }).slice(0, 200))
            : await archiveShopProduct(p.id, kind === "archive");
      if (!r.ok) { toast.error(errorText(r)); return; }
      toast.success(kind === "show" ? ts("shown", { name: p.name }) : kind === "hide" ? ts("hiddenToast", { name: p.name })
        : kind === "duplicate" ? ts("duplicated") : kind === "archive" ? ts("archived") : ts("restored"));
      refresh();
    } finally {
      setBusy(null);
    }
  }

  const price = (p: ShopProductSummary) => priceRange(p.min_price_minor, p.max_price_minor, page?.currency ?? null, locale) ?? t("noPrice");
  const chip = (active: boolean) => `inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-primary ${
    active ? "border-primary bg-primary/10 font-medium text-primary" : "border-border bg-card text-foreground hover:bg-muted"}`;

  const menu = (p: ShopProductSummary) => (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label={ts("productActions", { name: p.name })}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary">
        <MoreHorizontal className="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onClick={() => router.push(`/commerce/catalogue/${p.id}`)}><Pencil className="h-4 w-4" /> {ts("edit")}</DropdownMenuItem>
        {canManage && <DropdownMenuItem onClick={() => void act(p, "duplicate")}><Copy className="h-4 w-4" /> {ts("duplicate")}</DropdownMenuItem>}
        {canManage && p.status === "published" && <DropdownMenuItem onClick={() => void act(p, "hide")}><EyeOff className="h-4 w-4" /> {ts("hide")}</DropdownMenuItem>}
        {canManage && p.status === "draft" && <DropdownMenuItem onClick={() => void act(p, "show")}><Eye className="h-4 w-4" /> {ts("show")}</DropdownMenuItem>}
        {canManage && <DropdownMenuSeparator />}
        {canManage && (p.status === "archived"
          ? <DropdownMenuItem onClick={() => void act(p, "restore")}><ArchiveRestore className="h-4 w-4" /> {ts("restore")}</DropdownMenuItem>
          : <DropdownMenuItem variant="destructive" onClick={() => void act(p, "archive")}><Archive className="h-4 w-4" /> {ts("archive")}</DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const activeSwitch = (p: ShopProductSummary) => (
    <Switch checked={p.status === "published"} disabled={!canManage || p.status === "archived" || busy === p.id}
      aria-label={ts("activeFor", { name: p.name })}
      onCheckedChange={(on) => void act(p, on ? "show" : "hide")} />
  );

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5" role="group" aria-label={t("categoryFilter")}>
          <button type="button" className={chip(!filter.categoryId)} aria-pressed={!filter.categoryId} onClick={() => update({ categoryId: undefined })}>
            {ts("all")}{allTotal !== null && <b className="text-xs font-semibold tabular-nums opacity-70">{allTotal}</b>}
          </button>
          {categories.map((c) => (
            <button key={c.id} type="button" className={chip(filter.categoryId === c.id)} aria-pressed={filter.categoryId === c.id}
              onClick={() => update({ categoryId: c.id })}>
              <span className="max-w-[10rem] truncate">{c.parent_id ? `— ${c.name}` : c.name}</span>
              <b className="text-xs font-semibold tabular-nums opacity-70">{c.product_count}</b>
            </button>
          ))}
          <button type="button" className={chip(false)} onClick={onOpenCategories}>
            <Pencil className="h-3.5 w-3.5" /> {ts("categories")}
          </button>
        </div>
        {canManage && (
          <Button onClick={() => setNewOpen(true)}><Plus className="h-4 w-4" /> {t("create")}</Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-48">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" value={filter.q ?? ""} onChange={(e) => update({ q: e.target.value })} placeholder={t("search")} aria-label={t("search")} className="pl-8" />
        </div>
        <select aria-label={t("statusFilter")} className={`${selectClass} max-w-full`} value={filter.status ?? ""}
          onChange={(e) => update({ status: (e.target.value || undefined) as ProductListFilter["status"] })}>
          <option value="">{t("activeStatuses")}</option>
          <option value="draft">{tStatus("draft")}</option>
          <option value="published">{tStatus("published")}</option>
          <option value="archived">{tStatus("archived")}</option>
          <option value="all">{t("allStatuses")}</option>
        </select>
        <select aria-label={t("stockFilter")} className={`${selectClass} max-w-full`} value={filter.stock ?? ""}
          onChange={(e) => update({ stock: (e.target.value || undefined) as ProductListFilter["stock"] })}>
          <option value="">{t("allStock")}</option>
          <option value="in_stock">{t("stock.in_stock")}</option>
          <option value="low">{t("stock.low")}</option>
          <option value="out">{t("stock.out")}</option>
        </select>
        <div className="inline-flex rounded-xl bg-muted p-[3px]" role="group" aria-label={ts("viewLabel")}>
          {(["grid", "table"] as const).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} aria-label={v === "grid" ? ts("gridView") : ts("tableView")}
              onClick={() => chooseView(v)}
              className={`inline-flex h-[26px] items-center rounded-[9px] px-2.5 transition-[background-color,color] duration-150 focus-visible:outline-2 focus-visible:outline-primary ${
                view === v ? "bg-card text-foreground shadow-[0_1px_3px_rgb(0_0_0/0.12)] dark:bg-input" : "text-muted-foreground hover:text-foreground"}`}>
              {v === "grid" ? <LayoutGrid className="h-4 w-4" /> : <List className="h-4 w-4" />}
            </button>
          ))}
        </div>
      </div>

      {page === null ? (
        <div className="flex justify-center p-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label={t("loading")} /></div>
      ) : page.products.length === 0 ? (
        <div className="flex flex-col items-center rounded-xl border border-dashed border-border px-6 py-10 text-center">
          <span className="flex size-[52px] items-center justify-center rounded-2xl bg-primary/10 text-primary"><Package className="size-6" /></span>
          <p className="mt-3 text-sm text-muted-foreground">
            {failed ? t("loadError") : filter.q || filter.status || filter.stock || filter.categoryId ? t("noMatches") : t("empty")}
          </p>
          {canManage && !failed && <Button className="mt-3" variant="outline" onClick={() => setNewOpen(true)}><Plus className="h-4 w-4" /> {t("create")}</Button>}
        </div>
      ) : (
        <>
          {view === "grid" ? (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,150px),1fr))] gap-3 sm:grid-cols-[repeat(auto-fill,minmax(210px,1fr))]">
              {page.products.map((p) => (
                <li key={p.id} className={`flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card transition-shadow duration-150 hover:shadow-md ${p.status === "archived" ? "opacity-70" : ""}`}>
                  <Link href={`/commerce/catalogue/${p.id}`} className="block focus-visible:outline-2 focus-visible:outline-primary" aria-label={p.name}>
                    {p.image_url ? (
                      // eslint-disable-next-line @next/next/no-img-element -- seller-provided https or library images, not optimisable here
                      <img src={p.image_url} alt="" className={`aspect-[16/10] w-full object-cover ${p.status === "published" ? "" : "grayscale-[0.6]"}`} loading="lazy" referrerPolicy="no-referrer" />
                    ) : (
                      <span className="flex aspect-[16/10] w-full items-center justify-center bg-muted text-muted-foreground" aria-hidden><Package className="size-8" /></span>
                    )}
                  </Link>
                  <div className="flex flex-1 flex-col gap-1.5 p-3">
                    <div className="flex items-start justify-between gap-1">
                      <Link href={`/commerce/catalogue/${p.id}`} className="min-w-0 font-semibold break-words text-foreground hover:underline">{p.name}</Link>
                      {menu(p)}
                    </div>
                    <span className="truncate text-xs text-muted-foreground">
                      {[p.category_name, t("variants", { count: p.variant_count })].filter(Boolean).join(" · ")}
                    </span>
                    <div className="flex flex-wrap items-center justify-between gap-1.5">
                      <span className="font-semibold tabular-nums">{price(p)}</span>
                      <StockState p={p} />
                    </div>
                    <div className="mt-auto flex items-center justify-between gap-2 border-t border-border/60 pt-2">
                      <span className="text-xs text-muted-foreground">
                        {p.status === "published" ? ts("activeInShop") : p.status === "archived" ? tStatus("archived") : ts("hidden")}
                      </span>
                      {activeSwitch(p)}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-border bg-card">
              <Table className="[&_td]:px-3.5 [&_td]:py-2.5">
                <TableHeader className="bg-muted [&_th]:h-9 [&_th]:px-3.5 [&_th]:text-xs [&_th]:font-semibold [&_th]:text-muted-foreground">
                  <TableRow>
                    <TableHead>{t("colProduct")}</TableHead>
                    <TableHead>{t("colStatus")}</TableHead>
                    <TableHead className="text-right">{t("colPrice")}</TableHead>
                    <TableHead>{t("colStock")}</TableHead>
                    <TableHead>{ts("active")}</TableHead>
                    <TableHead><span className="sr-only">{ts("actionsColumn")}</span></TableHead>
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
                      <TableCell className="whitespace-nowrap text-right tabular-nums">{price(p)}</TableCell>
                      <TableCell><StockState p={p} /></TableCell>
                      <TableCell>{activeSwitch(p)}</TableCell>
                      <TableCell className="w-px text-right">{menu(p)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
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

      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("create")}</DialogTitle>
            <DialogDescription>{ts("newHelp")}</DialogDescription>
          </DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); void create(); }} className="space-y-1.5">
            <Label htmlFor="new-product-name">{t("newName")}</Label>
            <Input id="new-product-name" value={newName} maxLength={200} onChange={(e) => setNewName(e.target.value)} autoFocus />
          </form>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewOpen(false)}>{ts("cancel")}</Button>
            <Button disabled={creating || !newName.trim()} onClick={() => void create()}>
              {creating && <Loader2 className="h-4 w-4 animate-spin" />} {ts("createAndEdit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
