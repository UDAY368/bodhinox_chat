"use client";

/**
 * Add or edit a product on one page with ONE Save (batch 4): photos, name,
 * description, price, old price, stock, SKU and category up front; options
 * build the variant table; everything else sits in closed sections. The whole
 * form state lives here, so nothing typed is lost when another part changes,
 * and leaving with unsaved changes asks first. The server writes the product,
 * its photos, variants and bundle parts in one transaction (a new product gets
 * its default variant and a generated SKU there), then the stock counts.
 * Admins edit; agents read.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Archive, ArchiveRestore, Eye, EyeOff, Loader2, MoreHorizontal, RotateCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useCan } from "@/hooks/use-can";
import { cleanOptions } from "@/lib/commerce/catalogue/variant-matrix";
import {
  archiveShopProduct, fetchCategories, fetchShopProduct, publishShopProduct, saveProductForm, unpublishShopProduct,
  type ShopCategory, type ShopProduct,
} from "./catalogue-api";
import { selectClass, StatusBadge, useCatalogueError } from "./catalogue-admin";
import { ProductWriter } from "./product-writer";
import { ProductPhotos } from "./product-photos";
import { OptionsBuilder, VariantDetails, VariantMatrix } from "./product-options";
import { PRODUCT_SECTIONS, type SectionProps } from "./product-sections";
import {
  archivedPool, bodyOf, emptyForm, formOf, hasErrors, validate, type ProductFormState, type VariantRow,
} from "./product-form-state";

export function ProductForm({ id, currency: listCurrency, onSaved, onDirtyChange, onClose }: {
  /** null = a new product. */
  id: string | null;
  /** The store currency (from the list) until the product itself says it. */
  currency?: string | null;
  onSaved?: (product: ShopProduct) => void;
  onDirtyChange?: (dirty: boolean) => void;
  /** Shown as a Cancel action (the sheet); the page has its own back link. */
  onClose?: () => void;
}) {
  const t = useTranslations("Commerce.catalogue.form");
  const tEditor = useTranslations("Commerce.catalogue.editor");
  const errorText = useCatalogueError();
  const canManage = useCan("edit-settings");
  const [product, setProduct] = useState<ShopProduct | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "missing" | "failed">(id ? "loading" : "ready");
  const [categories, setCategories] = useState<ShopCategory[]>([]);
  const [form, setForm] = useState<ProductFormState>(() => emptyForm());
  const [base, setBase] = useState<ProductFormState>(() => emptyForm());
  const [busy, setBusy] = useState(false);
  const [showErrors, setShowErrors] = useState(false);

  const adopt = useCallback((p: ShopProduct) => { const f = formOf(p); setProduct(p); setForm(f); setBase(f); }, []);
  const load = useCallback(async (productId: string) => {
    setLoadState("loading");
    const r = await fetchShopProduct(productId);
    if (r.ok) { adopt(r.data); setLoadState("ready"); }
    else setLoadState(r.status === 404 ? "missing" : "failed");
  }, [adopt]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load on mount, as the other dashboard panels do
    if (id) void load(id);
  }, [id, load]);
  useEffect(() => { fetchCategories().then((r) => { if (r.ok) setCategories(r.data); }); }, []);

  const currency = product?.currency ?? listCurrency ?? null;
  const readOnly = !canManage;
  const update = useCallback((fn: (f: ProductFormState) => Partial<ProductFormState>) => setForm((f) => ({ ...f, ...fn(f) })), []);
  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(base), [form, base]);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const errors = useMemo(() => validate(form, currency), [form, currency]);
  const physical = !form.bundle && !form.digital;
  const sectionProps: SectionProps = { form, update, ctx: { product, currency, readOnly, errors, physical } };
  const pool = useMemo(() => archivedPool(product), [product]);
  const hasOptions = cleanOptions(form.options).length > 0;
  const single: VariantRow | undefined = !hasOptions ? form.rows[0] : undefined;
  const setSingle = (patch: Partial<VariantRow>) => update((f) => ({ rows: f.rows.map((r, i) => (i === 0 ? { ...r, ...patch } : r)) }));
  const singleErrors = new Set(single ? errors.rows[single.key] ?? [] : []);
  const problems = [
    ...(errors.name ? [t("name")] : []),
    ...(single && ["price", "compareAt", "stock", "sku"].some((k) => singleErrors.has(k as never)) ? [t("priceAndStock")] : []),
    ...(hasOptions && Object.keys(errors.rows).length ? [t("sections.options")] : []),
    ...PRODUCT_SECTIONS.filter((s) => (s.show?.(sectionProps) ?? true) && s.invalid?.(sectionProps)).map((s) => t(`sections.${s.key}`)),
  ];

  const save = async () => {
    if (hasErrors(errors)) { setShowErrors(true); toast.error(t("fixFirst", { list: problems.join(", ") })); return; }
    setBusy(true);
    const r = await saveProductForm(product?.id ?? null, bodyOf(form, currency, product ? base : null, product?.version ?? null));
    setBusy(false);
    if (!r.ok) {
      if (r.code === "conflict" && product) {
        toast.error(errorText(r), { action: { label: t("reload"), onClick: () => void load(product.id) }, duration: 10_000 });
      } else toast.error(errorText(r));
      return;
    }
    adopt(r.data.product);
    setShowErrors(false);
    if (r.data.stockError) toast.warning(t("savedStockNot", { reason: errorText({ ok: false, status: 409, code: r.data.stockError }) }));
    else toast.success(t("saved"));
    onSaved?.(r.data.product);
  };

  /** Status changes act at once on the saved product; typed edits stay in the form (only the version and status move). */
  const act = async (call: Promise<{ ok: true; data: ShopProduct } | { ok: false; status: number; code?: string }>, success: string) => {
    setBusy(true);
    const r = await call;
    setBusy(false);
    if (!r.ok) { toast.error(errorText(r)); return; }
    setProduct(r.data);
    toast.success(success);
    onSaved?.(r.data);
  };

  if (loadState === "missing") return <p className="p-6 text-sm text-muted-foreground">{tEditor("notFound")}</p>;
  if (loadState === "failed") {
    return (
      <div className="flex flex-col items-center gap-3 p-6 text-center text-sm text-muted-foreground">
        {t("loadFailed")}
        <Button variant="outline" onClick={() => id && void load(id)}><RotateCw className="size-4" />{t("retry")}</Button>
      </div>
    );
  }
  if (loadState === "loading") {
    return (
      <div className="space-y-4 p-4" aria-busy aria-label={t("loading")}>
        <div className="h-7 w-48 animate-pulse rounded bg-muted" />
        <div className="flex gap-3">{[0, 1, 2].map((i) => <div key={i} className="h-24 w-24 animate-pulse rounded-lg bg-muted" />)}</div>
        <div className="h-9 w-full animate-pulse rounded bg-muted" />
        <div className="h-24 w-full animate-pulse rounded bg-muted" />
      </div>
    );
  }

  const title = product ? product.name : t("addTitle");
  return (
    <form className="flex min-h-0 flex-1 flex-col" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <SheetOrPageTitle>{title}</SheetOrPageTitle>
          {product && (
            <span className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <StatusBadge status={product.status} />
              {product.content_reviewed_at ? tEditor("reviewed", { date: new Date(product.content_reviewed_at) }) : tEditor("notReviewed")}
            </span>
          )}
        </div>
        {onClose && <Button type="button" variant="ghost" onClick={onClose}>{t("cancel")}</Button>}
        {canManage && (
          <Button type="submit" disabled={busy || (!!product && !dirty)} className="min-h-11 sm:min-h-9">
            {busy && <Loader2 className="size-4 animate-spin" />}{t("save")}
          </Button>
        )}
        {canManage && product && (
          <DropdownMenu>
            <DropdownMenuTrigger aria-label={t("more")} disabled={busy}
              className="inline-flex size-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted sm:size-9">
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {product.status === "draft" && (
                <DropdownMenuItem onClick={() => void act(publishShopProduct(product.id, product.version), tEditor("publishedToast"))}>
                  <Eye className="size-4" />{t("makeLive")}
                </DropdownMenuItem>
              )}
              {product.status === "published" && (
                <DropdownMenuItem onClick={() => void act(unpublishShopProduct(product.id), tEditor("unpublished"))}>
                  <EyeOff className="size-4" />{t("makeHidden")}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              {product.status === "archived" ? (
                <DropdownMenuItem onClick={() => void act(archiveShopProduct(product.id, false), tEditor("restored"))}>
                  <ArchiveRestore className="size-4" />{tEditor("restore")}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem variant="destructive" onClick={() => void act(archiveShopProduct(product.id, true), tEditor("archivedToast"))}>
                  <Archive className="size-4" />{tEditor("archive")}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {showErrors && problems.length > 0 && <p className="w-full text-xs text-destructive" role="alert">{t("fixFirst", { list: problems.join(", ") })}</p>}
        {product?.status === "draft" && canManage && <p className="w-full text-xs text-muted-foreground">{tEditor("publishHint")}</p>}
      </header>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4">
        <section className="space-y-2" aria-label={t("photos.title")}>
          <h3 className="text-sm font-semibold text-foreground">{t("photos.title")}</h3>
          <ProductPhotos images={form.images} readOnly={readOnly} onChange={(fn) => update((f) => ({ images: fn(f.images) }))} />
        </section>

        <section className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="pf-name">{t("name")}</Label>
            <Input id="pf-name" value={form.name} maxLength={200} readOnly={readOnly} aria-invalid={showErrors && errors.name}
              onChange={(e) => update(() => ({ name: e.target.value }))} autoFocus={!product} />
            {showErrors && errors.name && <p className="text-xs text-destructive">{t("invalid.name")}</p>}
          </div>
          <div className="space-y-1">
            <Label htmlFor="pf-desc">{t("description")}</Label>
            <Textarea id="pf-desc" rows={4} maxLength={5000} value={form.description} readOnly={readOnly}
              onChange={(e) => update(() => ({ description: e.target.value }))} />
            {!readOnly && <ProductWriter name={form.name} onUse={(text) => update(() => ({ description: text }))} />}
          </div>
          {product?.status === "published" && canManage && <p className="text-xs text-muted-foreground">{tEditor("rereviewHint")}</p>}
          {!currency && <p className="rounded-md bg-muted p-2 text-xs text-muted-foreground">{tEditor("currencyMissing")}</p>}
          {single && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="pf-price">{t("price", { currency: currency ?? "—" })}</Label>
                <Input id="pf-price" inputMode="decimal" value={single.price} readOnly={readOnly || !currency} aria-invalid={singleErrors.has("price")}
                  onChange={(e) => setSingle({ price: e.target.value })} />
                {singleErrors.has("price") && <p className="text-xs text-destructive">{t("invalid.price")}</p>}
              </div>
              <div className="space-y-1">
                <Label htmlFor="pf-compare">{t("compareAt")}</Label>
                <Input id="pf-compare" inputMode="decimal" value={single.compareAt} readOnly={readOnly || !currency}
                  onChange={(e) => setSingle({ compareAt: e.target.value })} />
                {singleErrors.has("compareAt") && <p className="text-xs text-destructive">{t("invalid.compareAt")}</p>}
              </div>
              <div className="space-y-1">
                <Label htmlFor="pf-stock">{t("stock")}</Label>
                <Input id="pf-stock" inputMode="numeric" value={single.track ? single.stock : ""} placeholder={single.track ? "0" : t("madeToOrder")}
                  readOnly={readOnly || !single.track} onChange={(e) => setSingle({ stock: e.target.value })} />
                {singleErrors.has("stock") && <p className="text-xs text-destructive">{t("invalid.stock")}</p>}
                <label className="flex min-h-11 items-center gap-2 text-xs text-muted-foreground sm:min-h-0">
                  <input type="checkbox" className="size-4" checked={!single.track} disabled={readOnly} onChange={(e) => setSingle({ track: !e.target.checked })} />
                  {t("madeToOrderToggle")}
                </label>
              </div>
              <div className="space-y-1">
                <Label htmlFor="pf-sku">{t("sku")}</Label>
                <Input id="pf-sku" className="font-mono" maxLength={64} value={single.sku} placeholder={t("skuAuto")} readOnly={readOnly}
                  onChange={(e) => setSingle({ sku: e.target.value })} />
                {singleErrors.has("sku") && <p className="text-xs text-destructive">{t("invalid.sku")}</p>}
              </div>
            </div>
          )}
          <div className="space-y-1 sm:max-w-sm">
            <Label htmlFor="pf-cat">{t("category")}</Label>
            <select id="pf-cat" className={`${selectClass} min-h-11 w-full sm:min-h-9`} value={form.category_id} disabled={readOnly}
              onChange={(e) => update(() => ({ category_id: e.target.value }))}>
              <option value="">{tEditor("noCategory")}</option>
              {categories.filter((c) => !c.archived || c.id === product?.category_id).map((c) => (
                <option key={c.id} value={c.id}>{c.parent_id ? `— ${c.name}` : c.name}</option>
              ))}
            </select>
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-foreground">{t("sections.options")}</h3>
          <OptionsBuilder form={form} update={update} pool={pool} readOnly={readOnly} />
          {hasOptions && <VariantMatrix form={form} update={update} currency={currency} readOnly={readOnly} errors={errors.rows} physical={physical} />}
          {single && single.id && single.waiting > 0 && <p className="text-xs text-muted-foreground">{t("waiting", { count: single.waiting })}</p>}
          {single && form.images.length > 1 && (
            <VariantDetails row={single} images={form.images} currency={currency} readOnly={readOnly} physical={physical} errors={singleErrors}
              onChange={setSingle} only={["image"]} />
          )}
        </section>

        <Accordion multiple className="rounded-xl border border-border px-4">
          {PRODUCT_SECTIONS.filter((s) => s.show?.(sectionProps) ?? true).map(({ key, Component, invalid }) => (
            <AccordionItem key={key} value={key}>
              <AccordionTrigger className={`min-h-11 ${invalid?.(sectionProps) ? "text-destructive" : ""}`}>{t(`sections.${key}`)}</AccordionTrigger>
              <AccordionContent className="pt-1"><Component {...sectionProps} /></AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </form>
  );
}

/** The title is the sheet's accessible title inside a sheet, and the page's one large title on the page. */
function SheetOrPageTitle({ children }: { children: React.ReactNode }) {
  const inSheet = useInSheet();
  return inSheet
    ? <SheetTitle className="truncate text-lg font-semibold">{children}</SheetTitle>
    : <h1 className="truncate text-[22px] font-bold tracking-tight text-foreground">{children}</h1>;
}

const SheetContext = createContext(false);
const useInSheet = () => useContext(SheetContext);

/** The product form in a sheet over the list; closing with unsaved changes asks first. */
export function ProductSheet({ productId, open, currency, onOpenChange, onSaved }: {
  /** null = Add product. */
  productId: string | null; open: boolean; currency: string | null;
  onOpenChange: (open: boolean) => void; onSaved: (product: ShopProduct) => void;
}) {
  const t = useTranslations("Commerce.catalogue.form");
  const [dirty, setDirty] = useState(false);
  const [asking, setAsking] = useState(false);
  const close = () => { if (dirty) setAsking(true); else onOpenChange(false); };
  return (
    <>
      <Sheet open={open} onOpenChange={(next) => { if (next) onOpenChange(true); else close(); }}>
        <SheetContent side="right" showCloseButton={false} className="w-full gap-0 p-0 sm:max-w-2xl">
          <SheetContext.Provider value>
            {open && (
              <ProductForm key={productId ?? "new"} id={productId} currency={currency} onDirtyChange={setDirty} onClose={close}
                onSaved={onSaved} />
            )}
          </SheetContext.Provider>
        </SheetContent>
      </Sheet>
      <Dialog open={asking} onOpenChange={setAsking}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("discardTitle")}</DialogTitle>
            <DialogDescription>{t("discardBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAsking(false)}>{t("keepEditing")}</Button>
            <Button variant="destructive" onClick={() => { setAsking(false); setDirty(false); onOpenChange(false); }}>{t("discard")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
