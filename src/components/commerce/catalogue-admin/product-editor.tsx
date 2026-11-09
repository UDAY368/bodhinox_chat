"use client";

/**
 * One catalogue product: details and disclosure, images, variants (SKU,
 * options, price, tax, HSN, stock tracking), review/publish, archive and the
 * variant's stock with the adjust dialog. Admins edit; agents read. Each save
 * sends the version it was based on, so a concurrent edit is refused
 * (conflict) and the screen reloads.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ImagePlus, Loader2, Plus, Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MediaPicker } from "@/components/inbox/media-library/media-picker";
import { useCan } from "@/hooks/use-can";
import { formatMoney } from "@/lib/commerce/money";
import {
  archiveShopProduct, fetchCategories, fetchShopProduct, publishShopProduct, saveVariant, unpublishShopProduct, updateShopProduct,
  type ApiResult, type ShopCategory, type ShopProduct, type VariantBody,
} from "./catalogue-api";
import { selectClass, StatusBadge, useCatalogueError } from "./catalogue-admin";
import { bpsToPercent, moneyInput, moneyText, parseOptionsText, percentToBps } from "./catalogue-format";
import { AdjustStockDialog, MovementsList, type AdjustTarget } from "./inventory-panel";

type Variant = ShopProduct["variants"][number];

export function ProductEditor({ id }: { id: string }) {
  const t = useTranslations("Commerce.catalogue.editor");
  const errorText = useCatalogueError();
  const canManage = useCan("edit-settings");
  const [product, setProduct] = useState<ShopProduct | null>(null);
  const [missing, setMissing] = useState(false);
  const [categories, setCategories] = useState<ShopCategory[]>([]);
  const [busy, setBusy] = useState(false);
  const [adjusting, setAdjusting] = useState<AdjustTarget | null>(null);
  const [stockReload, setStockReload] = useState(0);

  const load = useCallback(async () => {
    const r = await fetchShopProduct(id);
    if (r.ok) setProduct(r.data);
    else if (r.status === 404) setMissing(true);
    else toast.error(errorText(r));
  }, [id, errorText]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load on mount, as the other dashboard panels do
    void load();
  }, [load]);
  useEffect(() => { fetchCategories().then((r) => { if (r.ok) setCategories(r.data); }); }, []);

  /** Run a save; on success show the returned product, on a stale version reload. */
  const apply = async (call: Promise<ApiResult<ShopProduct>>, success: string) => {
    setBusy(true);
    const r = await call;
    setBusy(false);
    if (r.ok) { setProduct(r.data); toast.success(success); return true; }
    toast.error(errorText(r));
    if (r.code === "conflict") await load();
    return false;
  };

  if (missing) return <div className="p-6 text-sm text-muted-foreground">{t("notFound")}</div>;
  if (!product) return <div className="flex justify-center p-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <Link href="/commerce/catalogue" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />{t("back")}
      </Link>
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold text-foreground">{product.name}</h1>
        <StatusBadge status={product.status} />
        <span className="text-xs text-muted-foreground">
          {product.content_reviewed_at ? t("reviewed", { date: new Date(product.content_reviewed_at) }) : t("notReviewed")}
        </span>
        {canManage && (
          <span className="ml-auto flex flex-wrap gap-2">
            {product.status === "published" ? (
              <Button variant="outline" disabled={busy} onClick={() => void apply(unpublishShopProduct(product.id), t("unpublished"))}>{t("unpublish")}</Button>
            ) : product.status === "draft" ? (
              <Button disabled={busy} title={t("publishHint")} onClick={() => void apply(publishShopProduct(product.id, product.version), t("publishedToast"))}>{t("publish")}</Button>
            ) : null}
            <Button variant="ghost" disabled={busy} onClick={() => void apply(archiveShopProduct(product.id, product.status !== "archived"),
              product.status === "archived" ? t("restored") : t("archivedToast"))}>
              {product.status === "archived" ? t("restore") : t("archive")}
            </Button>
          </span>
        )}
      </header>
      {canManage && product.status === "draft" && <p className="text-xs text-muted-foreground">{t("publishHint")}</p>}

      <DetailsForm key={`d${product.version}`} product={product} categories={categories} canManage={canManage} busy={busy}
        onSave={(body) => apply(updateShopProduct(product.id, { ...body, version: product.version }), t("saved"))} />

      <ImagesForm key={`i${product.version}`} product={product} canManage={canManage} busy={busy}
        onSave={(images) => apply(updateShopProduct(product.id, { images, version: product.version }), t("saved"))} />

      <section className="space-y-3">
        <h2 className="text-base font-medium text-foreground">{t("variants")}</h2>
        {!product.currency && <p className="rounded-md bg-muted p-2 text-xs text-muted-foreground">{t("currencyMissing")}</p>}
        <div className="space-y-3">
          {product.variants.map((v) => (
            <VariantForm key={`${v.id}:${product.version}`} variant={v} currency={product.currency} canManage={canManage} busy={busy}
              onSave={(body) => apply(saveVariant(product.id, v.id, body), t("variantSaved"))}
              onAdjust={() => setAdjusting({ variantId: v.id, label: `${product.name} · ${v.sku}`, onHand: v.on_hand, reserved: v.reserved })} />
          ))}
          {canManage && (
            <VariantForm key={`new:${product.version}`} variant={null} currency={product.currency} canManage busy={busy}
              onSave={(body) => apply(saveVariant(product.id, null, body), t("variantSaved"))} />
          )}
        </div>
      </section>

      {product.variants.some((v) => v.track_inventory) && (
        <section>
          {product.variants.filter((v) => v.track_inventory && !v.archived).map((v) => (
            <MovementsList key={`${v.id}:${stockReload}`} variantId={v.id} label={v.sku} reload={stockReload} />
          ))}
        </section>
      )}
      <AdjustStockDialog target={adjusting} onClose={() => setAdjusting(null)}
        onDone={() => { setAdjusting(null); setStockReload((n) => n + 1); void load(); }} />
    </div>
  );
}

function DetailsForm({ product, categories, canManage, busy, onSave }: {
  product: ShopProduct; categories: ShopCategory[]; canManage: boolean; busy: boolean;
  onSave: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const t = useTranslations("Commerce.catalogue.editor");
  const [form, setForm] = useState({
    name: product.name, description: product.description ?? "", disclosure: product.disclosure ?? "",
    category_id: product.category_id ?? "", follow_up_template: product.follow_up_template ?? "",
    follow_up_template_language: product.follow_up_template_language ?? "", follow_up_after_days: product.follow_up_after_days?.toString() ?? "",
    repurchase_after_days: product.repurchase_after_days?.toString() ?? "",
  });
  // Older responses have no cod_available: treat as allowed (the column defaults to true).
  const [codAvailable, setCodAvailable] = useState(product.cod_available !== false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const days = form.follow_up_after_days.trim() ? Number(form.follow_up_after_days) : null;
  const repurchase = form.repurchase_after_days.trim() ? Number(form.repurchase_after_days) : null;
  const dayOk = (n: number | null) => n === null || (Number.isInteger(n) && n >= 1 && n <= 365);
  const valid = form.name.trim().length > 0 && dayOk(days) && dayOk(repurchase)
    && (!form.follow_up_template.trim() || form.follow_up_template_language.trim().length >= 2);
  const submit = () => onSave({
    name: form.name, description: form.description || null, disclosure: form.disclosure || null, category_id: form.category_id || null,
    follow_up_template: form.follow_up_template.trim() || null, follow_up_template_language: form.follow_up_template_language.trim() || null,
    follow_up_after_days: form.follow_up_template.trim() ? days : null,
    repurchase_after_days: repurchase,
    cod_available: codAvailable,
  });
  const ro = !canManage;
  return (
    <form className="space-y-3 rounded-lg border border-border bg-card p-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h2 className="text-base font-medium text-foreground">{t("details")}</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="p-name">{t("name")}</Label>
          <Input id="p-name" value={form.name} maxLength={200} readOnly={ro} onChange={set("name")} className="bg-muted" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="p-cat">{t("category")}</Label>
          <select id="p-cat" className={`${selectClass} w-full`} value={form.category_id} disabled={ro} onChange={set("category_id")}>
            <option value="">{t("noCategory")}</option>
            {categories.filter((c) => !c.archived || c.id === product.category_id).map((c) => (
              <option key={c.id} value={c.id}>{c.parent_id ? `— ${c.name}` : c.name}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="p-desc">{t("description")}</Label>
        <Textarea id="p-desc" rows={4} maxLength={5000} value={form.description} readOnly={ro} onChange={set("description")} className="bg-muted" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="p-disc">{t("disclosure")}</Label>
        <Textarea id="p-disc" rows={3} maxLength={2000} value={form.disclosure} readOnly={ro} onChange={set("disclosure")} className="bg-muted" />
        <p className="text-xs text-muted-foreground">{t("disclosureHint")}</p>
      </div>
      <fieldset className="grid gap-3 sm:grid-cols-3">
        <legend className="mb-1 text-sm font-medium text-foreground">{t("followUp")}</legend>
        <div className="space-y-1">
          <Label htmlFor="p-fut">{t("followUpTemplate")}</Label>
          <Input id="p-fut" value={form.follow_up_template} maxLength={512} readOnly={ro} onChange={set("follow_up_template")} className="bg-muted" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="p-ful">{t("followUpLanguage")}</Label>
          <Input id="p-ful" value={form.follow_up_template_language} maxLength={15} readOnly={ro} onChange={set("follow_up_template_language")}
            placeholder="en" className="bg-muted" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="p-fud">{t("followUpDays")}</Label>
          <Input id="p-fud" inputMode="numeric" value={form.follow_up_after_days} readOnly={ro} onChange={set("follow_up_after_days")} className="bg-muted" />
        </div>
        <p className="text-xs text-muted-foreground sm:col-span-3">{t("followUpHint")}</p>
      </fieldset>
      <div className="space-y-1 sm:max-w-xs">
        <Label htmlFor="p-rpd">{t("repurchaseDays")}</Label>
        <Input id="p-rpd" inputMode="numeric" value={form.repurchase_after_days} readOnly={ro} onChange={set("repurchase_after_days")} className="bg-muted" />
        <p className="text-xs text-muted-foreground">{t("repurchaseHint")}</p>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-0.5 size-4" checked={codAvailable} disabled={ro} onChange={(e) => setCodAvailable(e.target.checked)} />
        <span>
          <span className="block font-medium text-foreground">{t("codAvailable")}</span>
          <span className="block text-xs text-muted-foreground">{t("codAvailableHint")}</span>
        </span>
      </label>
      {product.status === "published" && canManage && <p className="text-xs text-muted-foreground">{t("rereviewHint")}</p>}
      {canManage && <Button type="submit" disabled={busy || !valid}>{t("save")}</Button>}
    </form>
  );
}

type EditImage = ({ url: string } | { media_id: string }) & { display: string | null };
const withoutDisplay = (image: EditImage): { url: string } | { media_id: string } =>
  "media_id" in image ? { media_id: image.media_id } : { url: image.url };

function ImagesForm({ product, canManage, busy, onSave }: {
  product: ShopProduct; canManage: boolean; busy: boolean;
  onSave: (images: ({ url: string } | { media_id: string })[]) => Promise<boolean>;
}) {
  const t = useTranslations("Commerce.catalogue.editor");
  const [images, setImages] = useState<EditImage[]>(product.images.map((i) => (i.media_id ? { media_id: i.media_id, display: i.display_url } : { url: i.url ?? "", display: i.url })));
  const [url, setUrl] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const validUrl = /^https:\/\/\S{3,2040}$/.test(url.trim());
  const changed = JSON.stringify(images.map(withoutDisplay))
    !== JSON.stringify(product.images.map((i) => (i.media_id ? { media_id: i.media_id } : { url: i.url })));
  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-4">
      <h2 className="text-base font-medium text-foreground">{t("images")}</h2>
      {images.length === 0 && <p className="text-sm text-muted-foreground">{t("noImages")}</p>}
      <ul className="flex flex-wrap gap-3">
        {images.map((img, i) => (
          <li key={i} className="relative">
            {img.display ? (
              // eslint-disable-next-line @next/next/no-img-element -- seller-provided https or library images
              <img src={img.display} alt="" className="h-20 w-20 rounded object-cover" referrerPolicy="no-referrer" loading="lazy" />
            ) : <span className="block h-20 w-20 rounded bg-muted" />}
            {canManage && (
              <Button size="icon-sm" variant="ghost" aria-label={t("removeImage")} className="absolute right-0 top-0 bg-background/80"
                onClick={() => setImages((list) => list.filter((_, j) => j !== i))}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </li>
        ))}
      </ul>
      {canManage && (
        <>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={images.length >= 10} onClick={() => setPickerOpen(true)}>
              <ImagePlus className="h-4 w-4" />{t("uploadImage")}
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" aria-label={t("imageUrl")} className="max-w-md bg-muted" />
            <Button type="button" variant="outline" disabled={!validUrl || images.length >= 10}
              onClick={() => { setImages((list) => [...list, { url: url.trim(), display: url.trim() }]); setUrl(""); }}>
              <Plus className="h-4 w-4" />{t("addImage")}
            </Button>
            <Button type="button" disabled={busy || !changed} onClick={() => void onSave(images.map(withoutDisplay))}>
              {t("saveImages")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t("imagesHint")}</p>
          <MediaPicker open={pickerOpen} onOpenChange={setPickerOpen} initialKind="image" onPick={(media) => {
            // Only an image can be shown on a product (the server refuses anything else).
            if (media.kind !== "image") return toast.error(t("imageOnly"));
            setImages((list) => (list.length >= 10 || list.some((i) => "media_id" in i && i.media_id === media.id)
              ? list : [...list, { media_id: media.id, display: media.url }]));
          }} />
        </>
      )}
    </section>
  );
}

function VariantForm({ variant, currency, canManage, busy, onSave, onAdjust }: {
  variant: Variant | null; currency: string | null; canManage: boolean; busy: boolean;
  onSave: (body: VariantBody) => Promise<boolean>; onAdjust?: () => void;
}) {
  const t = useTranslations("Commerce.catalogue.editor");
  const tInv = useTranslations("Commerce.inventory");
  const locale = useLocale();
  const [form, setForm] = useState({
    sku: variant?.sku ?? "",
    options: variant ? Object.entries(variant.option_values).map(([k, v]) => `${k}: ${v}`).join(", ") : "",
    price: moneyText(variant?.price_minor ?? null, currency),
    compareAt: moneyText(variant?.compare_at_minor ?? null, currency),
    tax: bpsToPercent(variant?.tax_rate_bps ?? null),
    hsn: variant?.hsn_code ?? "",
    track: variant?.track_inventory ?? true,
    weight: variant?.weight_grams?.toString() ?? "",
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const options = parseOptionsText(form.options);
  const price = moneyInput(form.price, currency);
  const compareAt = moneyInput(form.compareAt, currency);
  const tax = percentToBps(form.tax);
  const weight = form.weight.trim() ? Number(form.weight) : null;
  const errors = {
    sku: !/^[A-Za-z0-9._-]{1,64}$/.test(form.sku.trim()),
    options: options === null,
    price: price === undefined,
    compareAt: compareAt === undefined,
    tax: tax === undefined,
    hsn: form.hsn.trim() !== "" && !/^[0-9]{4,8}$/.test(form.hsn.trim()),
    weight: weight !== null && !(Number.isInteger(weight) && weight >= 0 && weight <= 1_000_000),
  };
  const valid = !Object.values(errors).some(Boolean);
  const submit = async () => {
    if (!valid) return;
    const ok = await onSave({
      sku: form.sku.trim(), option_values: options ?? {}, price_minor: price ?? null, compare_at_minor: compareAt ?? null,
      tax_rate_bps: tax ?? null, hsn_code: form.hsn.trim() || null, track_inventory: form.track, weight_grams: weight,
    });
    if (ok && !variant) setForm({ sku: "", options: "", price: "", compareAt: "", tax: "", hsn: "", track: true, weight: "" });
  };
  const ro = !canManage;
  const field = (key: keyof typeof errors, label: string, input: React.ReactNode) => (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      {input}
      {errors[key] && (key !== "sku" || form.sku) && <p className="text-xs text-destructive">{t(`invalid.${key}`)}</p>}
    </div>
  );
  const id = variant?.id ?? "new";

  return (
    <form className={`space-y-3 rounded-lg border p-4 ${variant ? "border-border bg-card" : "border-dashed border-border"} ${variant?.archived ? "opacity-60" : ""}`}
      onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium text-foreground">{variant ? variant.sku : t("addVariant")}</h3>
        {variant?.archived && <Badge variant="outline">{t("archivedVariant")}</Badge>}
        {variant?.meta_linked && <Badge variant="secondary">{t("metaLinked")}</Badge>}
        {variant && variant.price_minor !== null && currency && (
          <span className="text-xs text-muted-foreground">{formatMoney(variant.price_minor, currency, locale)}</span>
        )}
        {variant && (
          <span className="ml-auto text-xs text-muted-foreground">
            {variant.track_inventory
              ? tInv("stockLine", { onHand: variant.on_hand, reserved: variant.reserved, available: variant.available })
              : t("madeToOrder")}
            {variant.track_inventory && variant.available <= variant.low_stock_threshold && (
              <Badge variant="destructive" className="ml-2">{variant.available === 0 ? tInv("out") : tInv("low")}</Badge>
            )}
          </span>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        {field("sku", t("sku"), <Input id={`${id}-sku`} value={form.sku} maxLength={64} readOnly={ro} onChange={set("sku")} className="bg-muted font-mono" />)}
        {field("options", t("options"), <Input value={form.options} readOnly={ro} onChange={set("options")} placeholder={t("optionsPlaceholder")} className="bg-muted" />)}
        {field("price", t("price", { currency: currency ?? "—" }), <Input inputMode="decimal" value={form.price} readOnly={ro || !currency} onChange={set("price")} className="bg-muted" />)}
        {field("compareAt", t("compareAt"), <Input inputMode="decimal" value={form.compareAt} readOnly={ro || !currency} onChange={set("compareAt")} className="bg-muted" />)}
        {field("tax", t("taxRate"), <Input inputMode="decimal" value={form.tax} readOnly={ro} onChange={set("tax")} placeholder={t("taxDefault")} className="bg-muted" />)}
        {field("hsn", t("hsn"), <Input inputMode="numeric" value={form.hsn} maxLength={8} readOnly={ro} onChange={set("hsn")} className="bg-muted" />)}
        {field("weight", t("weight"), <Input inputMode="numeric" value={form.weight} readOnly={ro} onChange={set("weight")} className="bg-muted" />)}
        <label className="flex items-center gap-2 self-end pb-2 text-sm text-foreground">
          <input type="checkbox" checked={form.track} disabled={ro} onChange={(e) => setForm((f) => ({ ...f, track: e.target.checked }))} />
          {t("trackInventory")}
        </label>
      </div>
      {canManage && (
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" disabled={busy || !valid}>{variant ? t("saveVariant") : t("createVariant")}</Button>
          {variant && (
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void onSave({ archived: !variant.archived })}>
              {variant.archived ? t("restore") : t("archive")}
            </Button>
          )}
          {variant?.track_inventory && !variant.archived && onAdjust && (
            <Button type="button" size="sm" variant="outline" onClick={onAdjust}>{tInv("adjust")}</Button>
          )}
        </div>
      )}
    </form>
  );
}
