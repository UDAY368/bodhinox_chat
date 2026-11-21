"use client";

/**
 * The product form's advanced sections, closed until opened. Each section is a
 * small component taking the shared form state (SectionProps) and is listed
 * once in PRODUCT_SECTIONS, so adding a section is one line there. A field
 * that belongs to every variant (tax, HSN, weight, pre-order) is edited here
 * for all rows at once; a row's own value is in its row of the options table.
 */
import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { MediaPicker } from "@/components/inbox/media-library/media-picker";
import { createClient } from "@/lib/data/client";
import { fetchInventory, type InventoryRow, type ShopProduct } from "./catalogue-api";
import { MovementsList } from "./inventory-panel";
import { PreorderFields } from "./product-options";
import { SearchListingFields } from "./search-listing-fields";
import { tagList, type FormErrors, type ProductFormState, type RowErrorKey, type VariantRow } from "./product-form-state";
import { OptionSelect } from "@/components/ui/option-select";

/** What every section gets: the shared form state, a patch function and read-only context. */
export interface SectionProps {
  form: ProductFormState;
  /** Merge a patch computed from the latest state. */
  update: (fn: (f: ProductFormState) => Partial<ProductFormState>) => void;
  ctx: { product: ShopProduct | null; currency: string | null; readOnly: boolean; errors: FormErrors; physical: boolean };
}

export interface SectionDef {
  key: string;
  /** Commerce.catalogue.form.sections.<key> */
  Component: (props: SectionProps) => React.ReactNode;
  /** Hidden when it does not apply. */
  show?: (p: SectionProps) => boolean;
  /** A problem inside (the section title turns red and the form names it next to Save). */
  invalid?: (p: SectionProps) => boolean;
}

/** One value shared by every row, or "" when the rows differ. */
const common = <K extends keyof VariantRow>(rows: VariantRow[], k: K): VariantRow[K] | "" =>
  rows.every((r) => r[k] === rows[0][k]) ? rows[0][k] : "";
const setAll = (update: SectionProps["update"], patch: Partial<VariantRow>) => update((f) => ({ rows: f.rows.map((r) => ({ ...r, ...patch })) }));
const rowsHave = (form: ProductFormState, errors: FormErrors, keys: RowErrorKey[]) =>
  form.rows.some((r) => (errors.rows[r.key] ?? []).some((k) => keys.includes(k)));

function AllRowsInput({ form, update, ctx, k, label, error, ...input }: SectionProps & { k: "tax" | "hsn" | "weight"; label: string; error: RowErrorKey }
  & Omit<React.ComponentProps<typeof Input>, "value" | "onChange" | "form">) {
  const t = useTranslations("Commerce.catalogue.form");
  const value = common(form.rows, k) as string;
  const varies = form.rows.length > 1 && value === "" && form.rows.some((r) => r[k] !== "");
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Input {...input} value={value} readOnly={ctx.readOnly} placeholder={varies ? t("varies") : input.placeholder}
        onChange={(e) => setAll(update, { [k]: e.target.value })} />
      {rowsHave(form, ctx.errors, [error]) && <p className="text-xs text-destructive">{t(`invalid.${error}`)}</p>}
      {form.rows.length > 1 && <p className="text-xs text-muted-foreground">{t("appliesToAll")}</p>}
    </div>
  );
}

function TaxSection(p: SectionProps) {
  const t = useTranslations("Commerce.catalogue.form");
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <AllRowsInput {...p} k="tax" label={t("taxRate")} error="tax" inputMode="decimal" placeholder={t("taxDefault")} />
      <AllRowsInput {...p} k="hsn" label={t("hsn")} error="hsn" inputMode="numeric" maxLength={8} />
    </div>
  );
}

function ShippingSection(p: SectionProps) {
  const t = useTranslations("Commerce.catalogue.form");
  return (
    <div className="space-y-3">
      <div className="sm:max-w-xs"><AllRowsInput {...p} k="weight" label={t("weight")} error="weight" inputMode="numeric" /></div>
      <label className="flex items-start justify-between gap-3 text-sm">
        <span>
          <span className="block font-medium text-foreground">{t("codAvailable")}</span>
          <span className="block text-xs text-muted-foreground">{t("codAvailableHint")}</span>
        </span>
        <Switch checked={p.form.cod_available} disabled={p.ctx.readOnly} onCheckedChange={(on) => p.update(() => ({ cod_available: !!on }))}
          aria-label={t("codAvailable")} />
      </label>
    </div>
  );
}

function TagsSection({ form, update, ctx }: SectionProps) {
  const t = useTranslations("Commerce.catalogue.form");
  const tags = tagList(form.tags);
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label htmlFor="pf-tags">{t("tags")}</Label>
        <Input id="pf-tags" value={form.tags} readOnly={ctx.readOnly} placeholder={t("tagsPlaceholder")} onChange={(e) => update(() => ({ tags: e.target.value }))} />
        <p className="text-xs text-muted-foreground">{t("tagsHint")}</p>
        {tags.length > 20 && <p className="text-xs text-destructive">{t("tagsTooMany")}</p>}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="pf-brand">{t("brand")}</Label>
          <Input id="pf-brand" value={form.brand} maxLength={80} readOnly={ctx.readOnly} onChange={(e) => update(() => ({ brand: e.target.value }))} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="pf-type">{t("productType")}</Label>
          <Input id="pf-type" value={form.product_type} maxLength={80} readOnly={ctx.readOnly} onChange={(e) => update(() => ({ product_type: e.target.value }))} />
        </div>
      </div>
    </div>
  );
}

/** Saved images only: a share image must already be one of the product's own image rows. */
function SearchListingSection({ form, update, ctx }: SectionProps) {
  return <SearchListingFields value={form.listing} onChange={(listing) => update(() => ({ listing }))} images={ctx.product?.images ?? []} readOnly={ctx.readOnly} />;
}

function DetailsSection({ form, update, ctx }: SectionProps) {
  const t = useTranslations("Commerce.catalogue.form");
  const ro = ctx.readOnly;
  const setDetail = (i: number, patch: Partial<{ label: string; value: string }>) =>
    update((f) => ({ details: f.details.map((x, j) => (j === i ? { ...x, ...patch } : x)) }));
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{t("detailsHint")}</p>
      {form.details.map((d, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <Input aria-label={t("detailLabel")} placeholder={t("detailLabel")} className="w-40" maxLength={40} value={d.label} readOnly={ro}
            onChange={(e) => setDetail(i, { label: e.target.value })} />
          <Input aria-label={t("detailValue")} placeholder={t("detailValue")} className="min-w-0 flex-1" maxLength={200} value={d.value} readOnly={ro}
            onChange={(e) => setDetail(i, { value: e.target.value })} />
          {!ro && <Button type="button" size="icon-sm" variant="ghost" aria-label={t("removeDetail")}
            onClick={() => update((f) => ({ details: f.details.filter((_, j) => j !== i) }))}><Trash2 className="size-4" /></Button>}
        </div>
      ))}
      {ctx.errors.details && <p className="text-xs text-destructive">{t("invalid.details")}</p>}
      {!ro && form.details.length < 12 && (
        <Button type="button" variant="outline" size="sm" onClick={() => update((f) => ({ details: [...f.details, { label: "", value: "" }] }))}>
          <Plus className="size-4" />{t("addDetail")}
        </Button>
      )}
    </div>
  );
}

function DisclosureSection({ form, update, ctx }: SectionProps) {
  const t = useTranslations("Commerce.catalogue.form");
  return (
    <div className="space-y-1">
      <Textarea aria-label={t("sections.disclosure")} rows={3} maxLength={2000} value={form.disclosure} readOnly={ctx.readOnly}
        onChange={(e) => update(() => ({ disclosure: e.target.value }))} />
      <p className="text-xs text-muted-foreground">{t("disclosureHint")}</p>
    </div>
  );
}

interface TemplateOption { id: string; name: string; language: string | null; category: string | null }

function FollowUpSection({ form, update, ctx }: SectionProps) {
  const t = useTranslations("Commerce.catalogue.form");
  const [templates, setTemplates] = useState<TemplateOption[] | null>(null);
  useEffect(() => {
    // The account's approved WhatsApp templates (the data client applies the account and role rules).
    createClient().from("message_templates").select("id,name,language,category").eq("status", "APPROVED").order("name", { ascending: true })
      .then(({ data }: { data: TemplateOption[] | null }) => setTemplates((data ?? []).filter((x) => x.category?.toUpperCase() !== "AUTHENTICATION")),
        () => setTemplates([]));
  }, []);
  const value = form.follow_up_template ? `${form.follow_up_template}\u0000${form.follow_up_template_language}` : "";
  const known = (templates ?? []).some((x) => `${x.name}\u0000${x.language ?? ""}` === value);
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="pf-fut">{t("followUpTemplate")}</Label>
          <OptionSelect fit
            id="pf-fut"
            className="w-full"
            disabled={ctx.readOnly || templates === null}
            value={value}
            onValueChange={(v) => {
              const [name, language] = v.split("\u0000");
              update(() => ({ follow_up_template: name ?? "", follow_up_template_language: language ?? "" }));
            }}
            options={[
              { value: "", label: templates === null ? t("loadingTemplates") : t("noFollowUp") },
              ...(value && !known ? [{ value, label: t("templateNotApproved", { name: form.follow_up_template }) }] : []),
              ...(templates ?? []).map((x) => ({ value: `${x.name}\u0000${x.language ?? ""}`, label: x.language ? `${x.name} · ${x.language}` : x.name })),
            ]}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="pf-fud">{t("followUpDays")}</Label>
          <Input id="pf-fud" inputMode="numeric" value={form.follow_up_after_days} readOnly={ctx.readOnly || !form.follow_up_template}
            onChange={(e) => update(() => ({ follow_up_after_days: e.target.value }))} />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t("followUpHint")}</p>
      <div className="space-y-1 sm:max-w-xs">
        <Label htmlFor="pf-rpd">{t("repurchaseDays")}</Label>
        <Input id="pf-rpd" inputMode="numeric" value={form.repurchase_after_days} readOnly={ctx.readOnly}
          onChange={(e) => update(() => ({ repurchase_after_days: e.target.value }))} />
        <p className="text-xs text-muted-foreground">{t("repurchaseHint")}</p>
      </div>
      {ctx.errors.followUp && <p className="text-xs text-destructive">{t("invalid.followUp")}</p>}
    </div>
  );
}

function ScheduleSection({ form, update, ctx }: SectionProps) {
  const t = useTranslations("Commerce.catalogue.form");
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1">
        <Label htmlFor="pf-publish">{t("publishAt")}</Label>
        <Input id="pf-publish" type="datetime-local" value={form.publishAt} readOnly={ctx.readOnly} onChange={(e) => update(() => ({ publishAt: e.target.value }))} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="pf-hide">{t("hideAt")}</Label>
        <Input id="pf-hide" type="datetime-local" value={form.hideAt} readOnly={ctx.readOnly} onChange={(e) => update(() => ({ hideAt: e.target.value }))} />
      </div>
      <p className="text-xs text-muted-foreground sm:col-span-2">{t("scheduleHint")}</p>
      {ctx.errors.schedule && <p className="text-xs text-destructive sm:col-span-2" role="alert">{t("invalid.scheduleOrder")}</p>}
    </div>
  );
}

function DigitalSection({ form, update, ctx }: SectionProps) {
  const t = useTranslations("Commerce.catalogue.form");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [mediaName, setMediaName] = useState<string | null>(null);
  const urlOk = form.digitalUrl.trim() === "" || /^https:\/\/\S+$/.test(form.digitalUrl.trim());
  return (
    <div className="space-y-3">
      <label className="flex items-start justify-between gap-3 text-sm">
        <span>
          <span className="block font-medium text-foreground">{t("isDigital")}</span>
          <span className="block text-xs text-muted-foreground">{t("digitalHint")}</span>
        </span>
        <Switch checked={form.digital} disabled={ctx.readOnly || form.bundle} aria-label={t("isDigital")}
          onCheckedChange={(on) => update(() => ({ digital: !!on }))} />
      </label>
      {form.digital && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label>{t("digitalFile")}</Label>
            <div className="flex flex-wrap items-center gap-2">
              {form.digitalMediaId ? <Badge variant="secondary">{mediaName ?? t("digitalFileChosen")}</Badge> : <span className="text-xs text-muted-foreground">{t("digitalNoFile")}</span>}
              {!ctx.readOnly && <Button type="button" size="sm" variant="outline" onClick={() => setPickerOpen(true)}>{t("digitalChooseFile")}</Button>}
              {!ctx.readOnly && form.digitalMediaId && (
                <Button type="button" size="sm" variant="ghost" onClick={() => { update(() => ({ digitalMediaId: null })); setMediaName(null); }}>{t("digitalRemoveFile")}</Button>
              )}
            </div>
            <MediaPicker open={pickerOpen} onOpenChange={setPickerOpen} initialKind="all" onPick={(media) => {
              update(() => ({ digitalMediaId: media.id, digitalUrl: "" })); setMediaName(media.filename ?? null); setPickerOpen(false);
            }} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="pf-durl">{t("digitalUrl")}</Label>
            <Input id="pf-durl" type="url" inputMode="url" placeholder="https://" maxLength={2048} value={form.digitalUrl}
              readOnly={ctx.readOnly || form.digitalMediaId !== null} onChange={(e) => update(() => ({ digitalUrl: e.target.value }))} />
            {!urlOk && <p className="text-xs text-destructive" role="alert">{t("invalid.digitalUrl")}</p>}
          </div>
          {ctx.errors.digital && urlOk && <p className="text-xs text-destructive sm:col-span-2" role="alert">{t("invalid.digitalSource")}</p>}
        </div>
      )}
    </div>
  );
}

function BundleSection({ form, update, ctx }: SectionProps) {
  const t = useTranslations("Commerce.catalogue.form");
  const [search, setSearch] = useState("");
  const [found, setFound] = useState<InventoryRow[] | null>(null);
  const ro = ctx.readOnly;
  useEffect(() => {
    if (!form.bundle || search.trim().length < 2) return;
    let live = true;
    const timer = setTimeout(() => {
      fetchInventory({ q: search.trim(), limit: 8 }).then((r) => { if (live && r.ok) setFound(r.data.items); });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [search, form.bundle]);
  return (
    <div className="space-y-3">
      <label className="flex items-start justify-between gap-3 text-sm">
        <span>
          <span className="block font-medium text-foreground">{t("isBundle")}</span>
          <span className="block text-xs text-muted-foreground">{t("bundleHint")}</span>
        </span>
        <Switch checked={form.bundle} disabled={ro || form.digital} aria-label={t("isBundle")} onCheckedChange={(on) => update(() => ({ bundle: !!on }))} />
      </label>
      {form.bundle && (
        <div className="space-y-2">
          {ctx.product?.is_bundle && (
            <p className="text-xs text-muted-foreground">
              {ctx.product.bundle_available === null ? t("bundleUnlimited") : t("bundleAvailable", { count: ctx.product.bundle_available })}
            </p>
          )}
          {form.parts.length === 0 && <p className="text-xs text-muted-foreground">{t("bundleNoParts")}</p>}
          <ul className="space-y-2">
            {form.parts.map((p, i) => (
              <li key={p.variantId} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 break-words">{p.label}</span>
                <Input aria-label={t("bundleQty")} className="w-20" inputMode="numeric" value={p.quantity} readOnly={ro}
                  onChange={(e) => update((f) => ({ parts: f.parts.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)) }))} />
                {!ro && (
                  <Button type="button" size="icon" variant="ghost" aria-label={t("bundleRemove")} onClick={() => update((f) => ({ parts: f.parts.filter((_, j) => j !== i) }))}>
                    <Trash2 className="size-4" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {!ro && form.parts.length < 20 && (
            <div className="space-y-1">
              <Label htmlFor="pf-part-search">{t("bundleAdd")}</Label>
              <Input id="pf-part-search" value={search} placeholder={t("bundleSearch")}
                onChange={(e) => { setSearch(e.target.value); if (e.target.value.trim().length < 2) setFound(null); }} />
              {found && (
                <ul className="rounded-md border border-border">
                  {found.filter((r) => r.product_id !== ctx.product?.id && !form.parts.some((p) => p.variantId === r.variant_id)).map((r) => (
                    <li key={r.variant_id}>
                      <button type="button" className="flex min-h-11 w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                        onClick={() => {
                          update((f) => ({ parts: [...f.parts, { variantId: r.variant_id, quantity: "1", label: `${r.product_name} · ${r.sku}` }] }));
                          setSearch(""); setFound(null);
                        }}>
                        <span className="min-w-0 break-words">{r.product_name} · {r.sku}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">{r.available}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {ctx.errors.bundle && <p className="text-xs text-destructive" role="alert">{t("invalid.bundleParts")}</p>}
        </div>
      )}
    </div>
  );
}

function PreorderSection({ form, update, ctx }: SectionProps) {
  const t = useTranslations("Commerce.catalogue.form");
  const merged = { preorder: form.rows.every((r) => r.preorder), shipDate: common(form.rows, "shipDate") as string, cap: common(form.rows, "cap") as string };
  const errs = new Set<RowErrorKey>(form.rows.flatMap((r) => ctx.errors.rows[r.key] ?? []));
  return (
    <div className="space-y-2">
      <PreorderFields row={merged} readOnly={ctx.readOnly} errors={errs} onChange={(patch) => setAll(update, patch)} />
      {form.rows.length > 1 && <p className="text-xs text-muted-foreground">{t("appliesToAll")}</p>}
    </div>
  );
}

function StockHistorySection({ ctx }: SectionProps) {
  const tracked = (ctx.product?.variants ?? []).filter((v) => v.track_inventory && !v.archived);
  return (
    <div className="space-y-3">
      {tracked.map((v) => <MovementsList key={v.id} variantId={v.id} label={v.sku} reload={0} />)}
    </div>
  );
}

/** The advanced sections, in order. Add a section with one line here. */
export const PRODUCT_SECTIONS: SectionDef[] = [
  { key: "tax", Component: TaxSection, invalid: (p) => rowsHave(p.form, p.ctx.errors, ["tax", "hsn"]) },
  { key: "shipping", Component: ShippingSection, invalid: (p) => rowsHave(p.form, p.ctx.errors, ["weight"]) },
  { key: "tags", Component: TagsSection, invalid: (p) => p.ctx.errors.tags },
  { key: "searchListing", Component: SearchListingSection, invalid: (p) => p.ctx.errors.listing },
  { key: "details", Component: DetailsSection, invalid: (p) => p.ctx.errors.details },
  { key: "disclosure", Component: DisclosureSection },
  { key: "followUp", Component: FollowUpSection, invalid: (p) => p.ctx.errors.followUp },
  { key: "schedule", Component: ScheduleSection, invalid: (p) => p.ctx.errors.schedule },
  { key: "digital", Component: DigitalSection, invalid: (p) => p.ctx.errors.digital },
  { key: "bundle", Component: BundleSection, invalid: (p) => p.ctx.errors.bundle },
  { key: "preorder", Component: PreorderSection, show: (p) => p.ctx.physical, invalid: (p) => rowsHave(p.form, p.ctx.errors, ["preorderShipDate", "preorderCap"]) },
  { key: "stockHistory", Component: StockHistorySection, show: (p) => !!p.ctx.product?.variants.some((v) => v.track_inventory && !v.archived) },
];
