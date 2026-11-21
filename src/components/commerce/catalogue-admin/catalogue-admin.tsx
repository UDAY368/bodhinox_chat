"use client";

/**
 * Commerce → Catalogue (design section 6): the products Bodhinox sells, with
 * categories, inventory and the Meta catalogue link. Agents and above read;
 * admins edit (the API and RLS enforce it, the screen only hides controls).
 * Prices are integer minor units in the store currency.
 *
 * Products (batch 4): adding or editing opens the one-page product form in a
 * sheet; a single-variant product's price and stock edit in place (saved on
 * Enter or leaving the field, shown at once and put back if refused); chosen
 * rows go Live, Hidden, archived or into a category with one server call.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Archive, ArchiveRestore, ChevronLeft, ChevronRight, Copy, ExternalLink, Eye, EyeOff, LayoutGrid, Link2, List, MessageCircle, MoreHorizontal,
  Package, Pencil, Plus, Search, Tag,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { StateBadge } from "@/components/commerce/orders/state-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useCan } from "@/hooks/use-can";
import { CategoriesPanel } from "./categories-panel";
import { CollectionsPanel } from "./collections-panel";
import { InventoryPanel } from "./inventory-panel";
import { LocationsPanel } from "./locations-panel";
import { PurchaseOrdersPanel } from "./purchase-orders-panel";
import { MetaLinkPanel } from "./meta-link-panel";
import { NewArrivalsDialog } from "./new-arrivals-dialog";
import { CsvImportDialog } from "./csv-dialog";
import { PlatformImportDialog } from "./platform-import-dialog";
import { ProductSheet } from "./product-form";
import { moneyInput, moneyText, priceRange } from "./catalogue-format";
import {
  adjustInventory, archiveShopProduct, bulkProducts, downloadProductCsv, duplicateShopProduct, fetchCategories, fetchShopProducts,
  publishShopProduct, saveVariant, unpublishShopProduct,
  type ApiResult, type BulkAction, type ProductListFilter, type ProductPage, type ShopCategory, type ShopProductSummary,
} from "./catalogue-api";
import { OptionSelect } from "@/components/commerce/option-select";
import { PageHeader } from "@/components/ui/page-header";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { EmptyState } from "@/components/ui/empty-state";
import { InlineError } from "@/components/ui/inline-error";

const PAGE = 50;
const TABS = ["products", "categories", "collections", "inventory", "locations", "purchaseOrders", "meta"] as const;
type Tab = (typeof TABS)[number];

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

/**
 * The one visibility control for a shop product: Live (published) or Hidden (draft). An archived
 * product shows its badge instead; Restore lives in its menu.
 */
export function VisibilityControl({ status, disabled, onChange }: {
  status: ShopProductSummary["status"];
  disabled?: boolean;
  onChange: (next: "published" | "draft") => void;
}) {
  const t = useTranslations("Commerce.catalogue.statuses");
  if (status === "archived") return <StatusBadge status={status} />;
  return (
    <div className="inline-flex rounded-xl bg-muted p-[3px]" role="radiogroup" aria-label={t("visibility")}>
      {(["published", "draft"] as const).map((v) => (
        <button key={v} type="button" role="radio" aria-checked={status === v} disabled={disabled}
          onClick={() => { if (status !== v) onChange(v); }}
          className={`inline-flex min-h-11 items-center rounded-[9px] px-3 text-sm transition-[background-color,color] duration-150 focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-60 sm:min-h-[26px] ${
            status === v ? "bg-card font-medium text-foreground shadow-[0_1px_3px_rgb(0_0_0/0.12)] dark:bg-input" : "text-muted-foreground hover:text-foreground"}`}>
          {t(v)}
        </button>
      ))}
    </div>
  );
}

export function CatalogueAdmin() {
  const t = useTranslations("Commerce.catalogue");
  const [tab, setTab] = useState<Tab>("products");
  const canManage = useCan("edit-settings");
  return (
    <div className="space-y-5">
      <PageHeader className="mb-0" title={t("title")} subtitle={t("description")} />
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
        {tab === "collections" && <CollectionsPanel canManage={canManage} />}
        {tab === "inventory" && <InventoryPanel canManage={canManage} />}
        {tab === "locations" && <LocationsPanel canManage={canManage} />}
        {tab === "purchaseOrders" && <PurchaseOrdersPanel canManage={canManage} />}
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

/** A value that turns into a field on click and saves on Enter or when the field is left; Escape cancels. */
function InlineEdit({ text, initial, label, inputMode, error, onCommit }: {
  text: string; initial: string; label: string; inputMode: "decimal" | "numeric"; error?: string; onCommit: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(initial);
  const done = (commit: boolean) => {
    setEditing(false);
    if (commit && value.trim() !== initial.trim()) onCommit(value.trim());
  };
  return (
    <span className="inline-flex flex-col items-start">
      {editing ? (
        <Input autoFocus aria-label={label} inputMode={inputMode} value={value} className="h-8 w-24 tabular-nums"
          onChange={(e) => setValue(e.target.value)} onBlur={() => done(true)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); done(true); } if (e.key === "Escape") { e.preventDefault(); setValue(initial); setEditing(false); } }} />
      ) : (
        <button type="button" aria-label={label} onClick={() => { setValue(initial); setEditing(true); }}
          className="min-h-8 rounded-md px-1 -mx-1 text-left font-semibold tabular-nums hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary">
          {text}
        </button>
      )}
      {error && <span className="text-xs text-destructive" role="alert">{error}</span>}
    </span>
  );
}

function ProductsTab({ canManage, onOpenCategories }: { canManage: boolean; onOpenCategories: () => void }) {
  const t = useTranslations("Commerce.catalogue.products");
  const ts = useTranslations("Sales.products");
  const tl = useTranslations("Commerce.catalogue.list");
  const tStatus = useTranslations("Commerce.catalogue.statuses");
  const errorText = useCatalogueError();
  const locale = useLocale();
  const [filter, setFilter] = useState<ProductListFilter>({});
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<ProductPage | null>(null);
  const [failed, setFailed] = useState(false);
  const [categories, setCategories] = useState<ShopCategory[]>([]);
  const [allTotal, setAllTotal] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [view, setView] = useState<"grid" | "table">("grid");
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [inlineError, setInlineError] = useState<Record<string, string>>({});
  // The product form sheet: undefined = closed, null = Add product, id = edit.
  const [editing, setEditing] = useState<string | null | undefined>(undefined);
  const [arrivalsOpen, setArrivalsOpen] = useState(false);
  const [csvOpen, setCsvOpen] = useState(false);
  const [platformOpen, setPlatformOpen] = useState(false);
  const tPlatform = useTranslations("Commerce.catalogue.platform");
  const tCsv = useTranslations("Commerce.catalogue.csv");
  const tNa = useTranslations("Commerce.catalogue.newArrivals");
  const exportCsv = async () => {
    const r = await downloadProductCsv();
    if (!r.ok) toast.error(errorText(r));
  };

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
        setPage(r.ok ? r.data : { products: [], total: 0, currency: null, shop_url: null });
        setFailed(!r.ok);
        if (r.ok && !filter.categoryId && !filter.q && !filter.status && !filter.stock) setAllTotal(r.data.total);
      });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [filter, offset, reloadKey]);

  const update = (patch: ProductListFilter) => { setFilter((f) => ({ ...f, ...patch })); setOffset(0); setSelected([]); };
  const refresh = () => setReloadKey((k) => k + 1);
  const patchRow = (id: string, patch: Partial<ShopProductSummary>) =>
    setPage((pg) => (pg ? { ...pg, products: pg.products.map((x) => (x.id === id ? { ...x, ...patch } : x)) } : pg));

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

  /** Price of a single-variant product: shown at once, put back with the reason when refused. */
  const commitPrice = async (p: ShopProductSummary, text: string) => {
    const currency = page?.currency ?? null;
    const minor = text === "" ? null : moneyInput(text, currency);
    if (minor === undefined || !p.single_variant_id) { setInlineError((e) => ({ ...e, [p.id]: tl("invalidPrice") })); return; }
    const before = { min_price_minor: p.min_price_minor, max_price_minor: p.max_price_minor };
    patchRow(p.id, { min_price_minor: minor, max_price_minor: minor });
    setInlineError(({ [p.id]: _, ...rest }) => { void _; return rest; });
    const r = await saveVariant(p.id, p.single_variant_id, { price_minor: minor });
    if (r.ok) patchRow(p.id, { version: r.data.version });
    else { patchRow(p.id, before); setInlineError((e) => ({ ...e, [p.id]: errorText(r) })); }
  };

  /** Units on hand of a single tracked variant, from the count shown (a sale meanwhile refuses it: stock_changed). */
  const commitStock = async (p: ShopProductSummary, text: string) => {
    const next = Number(text);
    if (!/^\d+$/.test(text) || next > 1_000_000 || p.single_on_hand === null || !p.single_variant_id) {
      setInlineError((e) => ({ ...e, [`${p.id}:stock`]: tl("invalidStock") }));
      return;
    }
    const delta = next - p.single_on_hand;
    if (delta === 0) return;
    const before = { single_on_hand: p.single_on_hand, available: p.available };
    patchRow(p.id, { single_on_hand: next, available: Math.max(p.available + delta, 0) });
    setInlineError(({ [`${p.id}:stock`]: _, ...rest }) => { void _; return rest; });
    const r = await adjustInventory(p.single_variant_id, { kind: "adjustment", delta, expected_on_hand: p.single_on_hand });
    if (r.ok) patchRow(p.id, { single_on_hand: r.data.onHand, available: Math.max(r.data.onHand - r.data.reserved, 0) });
    else { patchRow(p.id, before); setInlineError((e) => ({ ...e, [`${p.id}:stock`]: errorText(r) })); }
  };

  const runBulk = async (action: BulkAction, categoryId?: string | null) => {
    if (!selected.length) return;
    setBulkBusy(true);
    const r = await bulkProducts(action, selected, categoryId);
    setBulkBusy(false);
    if (!r.ok) { toast.error(errorText(r)); return; }
    if (r.data.skipped) toast.warning(tl("bulkPartly", { changed: r.data.changed, skipped: r.data.skipped }));
    else toast.success(tl("bulkDone", { count: r.data.changed }));
    setSelected([]);
    refresh();
  };

  const linkOf = (p: ShopProductSummary) => (page?.shop_url && p.status === "published" ? `${page.shop_url}/p/${p.id}` : null);
  const copyLink = async (url: string) => {
    try { await navigator.clipboard.writeText(url); toast.success(tl("linkCopied")); } catch { toast.error(tl("copyFailed")); }
  };

  const price = (p: ShopProductSummary) => priceRange(p.min_price_minor, p.max_price_minor, page?.currency ?? null, locale) ?? t("noPrice");
  const priceCell = (p: ShopProductSummary) => (canManage && p.single_variant_id && page?.currency ? (
    <InlineEdit text={price(p)} initial={moneyText(p.min_price_minor, page.currency)} label={tl("editPrice", { name: p.name })} inputMode="decimal"
      error={inlineError[p.id]} onCommit={(v) => void commitPrice(p, v)} />
  ) : <span className="font-semibold tabular-nums">{price(p)}</span>);
  const stockCell = (p: ShopProductSummary) => (canManage && p.single_on_hand !== null && p.status !== "archived" ? (
    <span className="inline-flex items-center gap-1.5">
      <InlineEdit text={tl("onHand", { count: p.single_on_hand })} initial={String(p.single_on_hand)} label={tl("editStock", { name: p.name })}
        inputMode="numeric" error={inlineError[`${p.id}:stock`]} onCommit={(v) => void commitStock(p, v)} />
      {p.low_count > 0 && <StateBadge tone={p.available === 0 ? "bad" : "warn"}>{p.available === 0 ? t("stock.out") : t("stock.low")}</StateBadge>}
    </span>
  ) : <StockState p={p} />);

  const chip = (active: boolean) => `inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-primary ${
    active ? "border-primary bg-primary/10 font-medium text-primary" : "border-border bg-card text-foreground hover:bg-muted"}`;
  const open = (e: React.MouseEvent, p: ShopProductSummary) => {
    // A plain click opens the sheet; Ctrl/Cmd-click still opens the product page in a new tab.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    setEditing(p.id);
  };

  const menu = (p: ShopProductSummary) => {
    const link = linkOf(p);
    return (
      <DropdownMenu>
        <DropdownMenuTrigger aria-label={ts("productActions", { name: p.name })}
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary sm:size-8">
          <MoreHorizontal className="h-4 w-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem onClick={() => setEditing(p.id)}><Pencil className="h-4 w-4" /> {ts("edit")}</DropdownMenuItem>
          {canManage && <DropdownMenuItem onClick={() => void act(p, "duplicate")}><Copy className="h-4 w-4" /> {ts("duplicate")}</DropdownMenuItem>}
          {link && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => window.open(link, "_blank", "noopener,noreferrer")}><ExternalLink className="h-4 w-4" /> {tl("openOnShop")}</DropdownMenuItem>
              <DropdownMenuItem onClick={() => void copyLink(link)}><Link2 className="h-4 w-4" /> {tl("copyLink")}</DropdownMenuItem>
              <DropdownMenuItem onClick={() => window.open(`https://wa.me/?text=${encodeURIComponent(`${p.name} ${link}`)}`, "_blank", "noopener,noreferrer")}>
                <MessageCircle className="h-4 w-4" /> {tl("sendOnWhatsApp")}
              </DropdownMenuItem>
            </>
          )}
          {canManage && <DropdownMenuSeparator />}
          {canManage && (p.status === "archived"
            ? <DropdownMenuItem onClick={() => void act(p, "restore")}><ArchiveRestore className="h-4 w-4" /> {ts("restore")}</DropdownMenuItem>
            : <DropdownMenuItem variant="destructive" onClick={() => void act(p, "archive")}><Archive className="h-4 w-4" /> {ts("archive")}</DropdownMenuItem>)}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  const activeSwitch = (p: ShopProductSummary) => (
    <Switch checked={p.status === "published"} disabled={!canManage || p.status === "archived" || busy === p.id}
      aria-label={ts("activeFor", { name: p.name })}
      onCheckedChange={(on) => void act(p, on ? "show" : "hide")} />
  );
  const pickBox = (p: ShopProductSummary) => (canManage ? (
    <Checkbox checked={selected.includes(p.id)} aria-label={tl("select", { name: p.name })}
      onCheckedChange={(on) => setSelected((ids) => (on ? [...ids.filter((x) => x !== p.id), p.id].slice(0, 100) : ids.filter((x) => x !== p.id)))} />
  ) : null);
  const pageIds = page?.products.map((p) => p.id) ?? [];
  const allPicked = pageIds.length > 0 && pageIds.every((id) => selected.includes(id));
  const pickedProducts = page?.products.filter((p) => selected.includes(p.id)) ?? [];
  const arrivalsReady = pickedProducts.length > 0 && pickedProducts.length <= 10 && pickedProducts.every((p) => p.status === "published");

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
          <>
            <DropdownMenu>
              <DropdownMenuTrigger aria-label={tl("moreActions")}
                className="inline-flex size-11 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-muted sm:size-9">
                <MoreHorizontal className="h-4 w-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem onClick={() => void exportCsv()}>{tCsv("export")}</DropdownMenuItem>
                <DropdownMenuItem onClick={() => setCsvOpen(true)}>{tCsv("import")}</DropdownMenuItem>
                <DropdownMenuItem onClick={() => setPlatformOpen(true)}>{tPlatform("open")}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button className="min-h-11 sm:min-h-9" onClick={() => setEditing(null)}><Plus className="h-4 w-4" /> {t("create")}</Button>
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-48">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" value={filter.q ?? ""} onChange={(e) => update({ q: e.target.value })} placeholder={t("search")} aria-label={t("search")} className="pl-8" />
        </div>
        <OptionSelect
          aria-label={t("statusFilter")}
          value={filter.status ?? ""}
          onValueChange={(v) => update({ status: (v || undefined) as ProductListFilter["status"] })}
          className="max-w-full"
          options={[
            { value: "", label: t("activeStatuses") },
            { value: "draft", label: tStatus("draft") },
            { value: "published", label: tStatus("published") },
            { value: "archived", label: tStatus("archived") },
            { value: "all", label: t("allStatuses") },
          ]}
        />
        <SegmentedControl
          aria-label={t("stockFilter")}
          value={filter.stock ?? ""}
          onValueChange={(v) => update({ stock: (v || undefined) as ProductListFilter["stock"] })}
          options={[
            { value: "", label: t("allStock") },
            { value: "in_stock", label: t("stock.in_stock") },
            { value: "low", label: t("stock.low") },
            { value: "out", label: t("stock.out") },
          ]}
        />
        <SegmentedControl
          aria-label={ts("viewLabel")}
          value={view}
          onValueChange={chooseView}
          options={(["grid", "table"] as const).map((v) => ({
            value: v,
            label: <>{v === "grid" ? <LayoutGrid className="h-4 w-4" aria-hidden /> : <List className="h-4 w-4" aria-hidden />}<span className="sr-only">{v === "grid" ? ts("gridView") : ts("tableView")}</span></>,
          }))}
        />
      </div>

      {canManage && selected.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
          <span className="mr-auto">{tl("selected", { count: selected.length })}</span>
          <Button size="sm" variant="outline" disabled={bulkBusy} onClick={() => void runBulk("live")}><Eye className="h-4 w-4" /> {tl("bulkLive")}</Button>
          <Button size="sm" variant="outline" disabled={bulkBusy} onClick={() => void runBulk("hidden")}><EyeOff className="h-4 w-4" /> {tl("bulkHidden")}</Button>
          <DropdownMenu>
            <DropdownMenuTrigger disabled={bulkBusy} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-sm hover:bg-muted">
              <Tag className="h-4 w-4" /> {tl("bulkCategory")}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-72 w-56 overflow-y-auto">
              <DropdownMenuItem onClick={() => void runBulk("category", null)}>{tl("noCategory")}</DropdownMenuItem>
              {categories.map((c) => (
                <DropdownMenuItem key={c.id} onClick={() => void runBulk("category", c.id)}>{c.parent_id ? `— ${c.name}` : c.name}</DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger aria-label={tl("moreBulk")} disabled={bulkBusy}
              className="inline-flex size-8 items-center justify-center rounded-lg border border-border bg-card hover:bg-muted">
              <MoreHorizontal className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {arrivalsReady && <DropdownMenuItem onClick={() => setArrivalsOpen(true)}>{tNa("action")}</DropdownMenuItem>}
              <DropdownMenuItem variant="destructive" onClick={() => void runBulk("archive")}><Archive className="h-4 w-4" /> {tl("bulkArchive")}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button size="sm" variant="ghost" onClick={() => setSelected([])}>{tNa("clear")}</Button>
        </div>
      )}

      {page === null ? (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,150px),1fr))] gap-3 sm:grid-cols-[repeat(auto-fill,minmax(210px,1fr))]" aria-busy aria-label={t("loading")}>
          {Array.from({ length: 8 }, (_, i) => (
            <li key={i} className="overflow-hidden rounded-xl border border-border bg-card">
              <div className="aspect-[16/10] animate-pulse bg-muted" />
              <div className="space-y-2 p-3"><div className="h-4 w-3/4 animate-pulse rounded bg-muted" /><div className="h-3 w-1/2 animate-pulse rounded bg-muted" /></div>
            </li>
          ))}
        </ul>
      ) : page.products.length === 0 ? (
        failed ? <InlineError message={t("loadError")} onRetry={refresh} /> : (
          <EmptyState
            icon={Package}
            title={filter.q || filter.status || filter.stock || filter.categoryId ? t("noMatches") : t("empty")}
            action={canManage ? <Button className="min-h-11 sm:min-h-9" variant="outline" onClick={() => setEditing(null)}><Plus className="h-4 w-4" /> {t("create")}</Button> : undefined}
          />
        )
      ) : (
        <>
          {canManage && (
            <label className="flex min-h-11 items-center gap-2 text-xs text-muted-foreground sm:min-h-0">
              <Checkbox checked={allPicked} aria-label={tl("selectPage")}
                onCheckedChange={(on) => setSelected((ids) => (on ? [...new Set([...ids, ...pageIds])].slice(0, 100) : ids.filter((x) => !pageIds.includes(x))))} />
              {tl("selectPage")}
            </label>
          )}
          {view === "grid" ? (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,150px),1fr))] gap-3 sm:grid-cols-[repeat(auto-fill,minmax(210px,1fr))]">
              {page.products.map((p) => (
                <li key={p.id} className={`flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card transition-shadow duration-150 hover:shadow-md ${
                  selected.includes(p.id) ? "border-primary" : "border-border"} ${p.status === "archived" ? "opacity-70" : ""}`}>
                  <Link href={`/commerce/catalogue/${p.id}`} onClick={(e) => open(e, p)} className="block focus-visible:outline-2 focus-visible:outline-primary" aria-label={p.name}>
                    {p.image_url ? (
                      // eslint-disable-next-line @next/next/no-img-element -- seller-provided https or library images, not optimisable here
                      <img src={p.image_url} alt="" className={`aspect-[16/10] w-full object-cover ${p.status === "published" ? "" : "grayscale-[0.6]"}`} loading="lazy" referrerPolicy="no-referrer" />
                    ) : (
                      <span className="flex aspect-[16/10] w-full items-center justify-center bg-muted text-muted-foreground" aria-hidden><Package className="size-8" /></span>
                    )}
                  </Link>
                  <div className="flex flex-1 flex-col gap-1.5 p-3">
                    <div className="flex items-start justify-between gap-1">
                      <Link href={`/commerce/catalogue/${p.id}`} onClick={(e) => open(e, p)} className="min-w-0 font-semibold break-words text-foreground hover:underline">{p.name}</Link>
                      <span className="flex shrink-0 items-center gap-1.5">{pickBox(p)}{menu(p)}</span>
                    </div>
                    <span className="truncate text-xs text-muted-foreground">
                      {[p.category_name, t("variants", { count: p.variant_count })].filter(Boolean).join(" · ")}
                    </span>
                    <div className="flex flex-wrap items-center justify-between gap-1.5">
                      {priceCell(p)}
                      {stockCell(p)}
                    </div>
                    <div className="mt-auto flex items-center justify-between gap-2 border-t border-border/60 pt-2">
                      <span className="text-xs text-muted-foreground">
                        {p.status === "published" ? tl("live") : p.status === "archived" ? tStatus("archived") : tl("hidden")}
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
                    <TableHead className="w-px"><span className="sr-only">{tNa("selectColumn")}</span></TableHead>
                    <TableHead>{t("colProduct")}</TableHead>
                    <TableHead>{t("colStatus")}</TableHead>
                    <TableHead>{t("colPrice")}</TableHead>
                    <TableHead>{t("colStock")}</TableHead>
                    <TableHead><span className="sr-only">{ts("actionsColumn")}</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {page.products.map((p) => (
                    <TableRow key={p.id} data-state={selected.includes(p.id) ? "selected" : undefined}>
                      <TableCell className="w-px">{pickBox(p)}</TableCell>
                      <TableCell className="max-w-[20rem]">
                        <Link href={`/commerce/catalogue/${p.id}`} onClick={(e) => open(e, p)} className="flex items-center gap-3 hover:underline">
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
                      <TableCell>
                        {p.status === "archived" ? <StatusBadge status={p.status} /> : (
                          <span className="flex items-center gap-2">{activeSwitch(p)}<span className="text-xs text-muted-foreground">{p.status === "published" ? tl("live") : tl("hidden")}</span></span>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{priceCell(p)}</TableCell>
                      <TableCell>{stockCell(p)}</TableCell>
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
              <Button variant="ghost" size="icon-sm" aria-label={t("previous")} disabled={offset === 0} onClick={() => { setOffset(Math.max(offset - PAGE, 0)); setSelected([]); }}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label={t("next")} disabled={offset + page.products.length >= page.total} onClick={() => { setOffset(offset + PAGE); setSelected([]); }}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </>
      )}

      <CsvImportDialog open={csvOpen} onOpenChange={setCsvOpen} onDone={refresh} />
      <PlatformImportDialog open={platformOpen} onOpenChange={setPlatformOpen} onDone={refresh} />
      <NewArrivalsDialog open={arrivalsOpen} onOpenChange={setArrivalsOpen} productIds={pickedProducts.map((p) => p.id)} onDone={() => setSelected([])} />
      <ProductSheet productId={editing ?? null} open={editing !== undefined} currency={page?.currency ?? null}
        onOpenChange={(o) => { if (!o) setEditing(undefined); }} onSaved={refresh} />
    </section>
  );
}
