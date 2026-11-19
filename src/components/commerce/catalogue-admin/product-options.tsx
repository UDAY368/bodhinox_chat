"use client";

/**
 * Options and variants in the product form: type option names and values once
 * (Size: S, M, L; Colour: Red, Blue) and get one row per combination with its
 * own price, stock and SKU. Existing variants keep their rows; a value removed
 * removes its rows, and when those variants hold stock or appear on orders the
 * seller confirms first (they are archived, never deleted). Each row opens for
 * the rest of its settings (old price, tax, HSN, weight, picture, pre-order).
 */
import { Fragment, useState } from "react";
import { ChevronDown, ChevronUp, Plus, X } from "lucide-react";
import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  comboCount, mapRows, MAX_OPTION_NAMES, MAX_OPTION_VALUES, MAX_VARIANTS, optionCombos, type ProductOption,
} from "@/lib/commerce/catalogue/variant-matrix";
import { freshRow, imageKey, type FormImage, type ProductFormState, type RowErrorKey, type VariantRow } from "./product-form-state";

type Patch = (fn: (f: ProductFormState) => Partial<ProductFormState>) => void;

/** Apply new options: rebuild the rows, asking first when a removed row holds stock or orders. */
function useApplyOptions(form: ProductFormState, update: Patch, pool: VariantRow[]) {
  const [pending, setPending] = useState<{ options: ProductOption[]; rows: VariantRow[]; removed: VariantRow[] } | null>(null);
  const apply = (options: ProductOption[]) => {
    const like = form.rows[0];
    const { rows, removed } = mapRows(optionCombos(options), form.rows, (values) => freshRow(values, like), pool);
    const risky = removed.filter((r) => r.id && (r.baseOnHand > 0 || r.reserved > 0 || r.ordered));
    if (risky.length) setPending({ options, rows, removed: risky });
    else update(() => ({ options, rows }));
  };
  return { apply, pending, confirm: () => { if (pending) update(() => ({ options: pending.options, rows: pending.rows })); setPending(null); }, cancel: () => setPending(null) };
}

export const rowLabel = (r: VariantRow) => Object.values(r.option_values).join(" / ");

export function OptionsBuilder({ form, update, pool, readOnly }: { form: ProductFormState; update: Patch; pool: VariantRow[]; readOnly: boolean }) {
  const t = useTranslations("Commerce.catalogue.form.options");
  const { apply, pending, confirm, cancel } = useApplyOptions(form, update, pool);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [names, setNames] = useState<Record<number, string>>({});
  const tooMany = (options: ProductOption[]) => comboCount(options) > MAX_VARIANTS;

  const addValue = (i: number) => {
    const values = (drafts[i] ?? "").split(",").map((v) => v.trim()).filter(Boolean);
    if (!values.length) return;
    const options = form.options.map((o, j) => (j === i
      ? { ...o, values: [...o.values, ...values.filter((v) => !o.values.some((x) => x.toLowerCase() === v.toLowerCase()))].slice(0, MAX_OPTION_VALUES) } : o));
    setDrafts((d) => ({ ...d, [i]: "" }));
    if (tooMany(options)) return;
    // A new option name only becomes rows once it has a value.
    apply(options);
  };
  const renameOption = (i: number) => {
    const name = (names[i] ?? form.options[i].name).trim();
    setNames((n) => { const { [i]: _, ...rest } = n; void _; return rest; });
    if (!name || name === form.options[i].name || form.options.some((o, j) => j !== i && o.name.toLowerCase() === name.toLowerCase())) return;
    const old = form.options[i].name;
    update((f) => ({
      options: f.options.map((o, j) => (j === i ? { ...o, name } : o)),
      rows: f.rows.map((r) => (old in r.option_values
        ? { ...r, option_values: Object.fromEntries(Object.entries(r.option_values).map(([k, v]) => [k === old ? name : k, v])) } : r)),
    }));
  };

  return (
    <div className="space-y-3">
      {form.options.map((o, i) => (
        <div key={i} className="space-y-2 rounded-lg bg-muted/40 p-3">
          <div className="flex items-center gap-2">
            <Input aria-label={t("name")} placeholder={t("namePlaceholder")} maxLength={40} className="max-w-48" readOnly={readOnly}
              value={names[i] ?? o.name} onChange={(e) => setNames((n) => ({ ...n, [i]: e.target.value }))} onBlur={() => renameOption(i)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); renameOption(i); } }} />
            {!readOnly && (
              <Button type="button" variant="ghost" size="sm" className="ml-auto min-h-11 sm:min-h-8" onClick={() => apply(form.options.filter((_, j) => j !== i))}>
                {t("removeOption")}
              </Button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {o.values.map((v) => (
              <span key={v} className="inline-flex items-center gap-1 rounded-full border border-border bg-card py-0.5 pl-2.5 pr-1 text-sm">
                {v}
                {!readOnly && (
                  <button type="button" aria-label={t("removeValue", { value: v })} className="inline-flex size-6 items-center justify-center rounded-full hover:bg-muted"
                    onClick={() => apply(form.options.map((x, j) => (j === i ? { ...x, values: x.values.filter((y) => y !== v) } : x)))}>
                    <X className="size-3.5" />
                  </button>
                )}
              </span>
            ))}
            {!readOnly && o.values.length < MAX_OPTION_VALUES && (
              <Input aria-label={t("addValue", { name: o.name || t("namePlaceholder") })} placeholder={t("valuePlaceholder")} maxLength={80} className="h-8 w-40"
                value={drafts[i] ?? ""} onChange={(e) => setDrafts((d) => ({ ...d, [i]: e.target.value }))}
                onBlur={() => addValue(i)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addValue(i); } }} />
            )}
          </div>
        </div>
      ))}
      {!readOnly && form.options.length < MAX_OPTION_NAMES && (
        <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8"
          onClick={() => update((f) => ({ options: [...f.options, { name: f.options.length === 0 ? t("defaultFirst") : t("defaultSecond"), values: [] }] }))}>
          <Plus className="size-4" />{form.options.length ? t("addAnother") : t("add")}
        </Button>
      )}
      <p className="text-xs text-muted-foreground">{t("hint", { max: MAX_VARIANTS })}</p>

      <Dialog open={pending !== null} onOpenChange={(open) => { if (!open) cancel(); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("confirmTitle", { count: pending?.removed.length ?? 0 })}</DialogTitle>
            <DialogDescription>{t("confirmBody")}</DialogDescription>
          </DialogHeader>
          <ul className="max-h-40 list-disc space-y-0.5 overflow-auto pl-5 text-sm">
            {pending?.removed.map((r) => (
              <li key={r.key}>{rowLabel(r) || r.sku} · {r.sku}{r.baseOnHand > 0 ? ` · ${t("onHand", { count: r.baseOnHand })}` : ""}{r.ordered ? ` · ${t("hasOrders")}` : ""}</li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="outline" onClick={cancel}>{t("keep")}</Button>
            <Button variant="destructive" onClick={confirm}>{t("remove")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** The generated table: one row per combination with price, stock and SKU; each row opens for its other settings. */
export function VariantMatrix({ form, update, currency, readOnly, errors, physical }: {
  form: ProductFormState; update: Patch; currency: string | null; readOnly: boolean; errors: Record<string, RowErrorKey[]>; physical: boolean;
}) {
  const t = useTranslations("Commerce.catalogue.form");
  const [open, setOpen] = useState<string | null>(null);
  const setRow = (key: string, patch: Partial<VariantRow>) => update((f) => ({ rows: f.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) }));
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-sm">
        <thead className="bg-muted text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-left font-semibold">{t("matrix.variant")}</th>
            <th className="px-3 py-2 text-left font-semibold">{t("price", { currency: currency ?? "—" })}</th>
            <th className="px-3 py-2 text-left font-semibold">{t("stock")}</th>
            <th className="px-3 py-2 text-left font-semibold">{t("sku")}</th>
            <th className="w-px px-1 py-2"><span className="sr-only">{t("matrix.more")}</span></th>
          </tr>
        </thead>
        <tbody>
          {form.rows.map((r) => {
            const bad = new Set(errors[r.key] ?? []);
            const expanded = open === r.key;
            return (
              <Fragment key={r.key}>
                <tr className="border-t border-border align-top">
                  <td className="px-3 py-2">
                    <span className="font-medium text-foreground">{rowLabel(r)}</span>
                    {(r.waiting > 0 || r.metaLinked) && (
                      <span className="mt-1 flex flex-wrap gap-1">
                        {r.metaLinked && <Badge variant="secondary">{t("metaLinked")}</Badge>}
                        {r.waiting > 0 && <Badge variant="outline">{t("waiting", { count: r.waiting })}</Badge>}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Input inputMode="decimal" aria-label={t("priceFor", { variant: rowLabel(r) })} aria-invalid={bad.has("price")} className="h-9 w-28"
                      value={r.price} readOnly={readOnly || !currency} onChange={(e) => setRow(r.key, { price: e.target.value })} />
                  </td>
                  <td className="px-3 py-2">
                    {r.track ? (
                      <Input inputMode="numeric" aria-label={t("stockFor", { variant: rowLabel(r) })} aria-invalid={bad.has("stock")} className="h-9 w-20"
                        value={r.stock} placeholder="0" readOnly={readOnly} onChange={(e) => setRow(r.key, { stock: e.target.value })} />
                    ) : <span className="text-xs text-muted-foreground">{t("madeToOrder")}</span>}
                  </td>
                  <td className="px-3 py-2">
                    <Input aria-label={t("skuFor", { variant: rowLabel(r) })} aria-invalid={bad.has("sku")} className="h-9 w-36 font-mono" maxLength={64}
                      value={r.sku} placeholder={t("skuAuto")} readOnly={readOnly} onChange={(e) => setRow(r.key, { sku: e.target.value })} />
                  </td>
                  <td className="px-1 py-2">
                    <Button type="button" variant="ghost" size="icon-sm" aria-expanded={expanded} aria-label={t("matrix.moreFor", { variant: rowLabel(r) })}
                      className={bad.size && !bad.has("price") && !bad.has("stock") && !bad.has("sku") ? "text-destructive" : ""}
                      onClick={() => setOpen(expanded ? null : r.key)}>
                      {expanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
                    </Button>
                  </td>
                </tr>
                {(bad.has("price") || bad.has("stock") || bad.has("sku")) && (
                  <tr><td colSpan={5} className="px-3 pb-2 text-xs text-destructive">
                    {[...bad].filter((k) => k === "price" || k === "stock" || k === "sku").map((k) => t(`invalid.${k}`)).join(" ")}
                  </td></tr>
                )}
                {expanded && (
                  <tr className="bg-muted/30"><td colSpan={5} className="px-3 py-3">
                    <VariantDetails row={r} images={form.images} currency={currency} readOnly={readOnly} physical={physical} errors={bad}
                      onChange={(patch) => setRow(r.key, patch)} />
                  </td></tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** One variant's other settings (inside the matrix, or the single variant's settings in the advanced sections). */
export function VariantDetails({ row, images, currency, readOnly, physical, errors, onChange, only }: {
  row: VariantRow; images: FormImage[]; currency: string | null; readOnly: boolean; physical: boolean; errors: Set<RowErrorKey>;
  onChange: (patch: Partial<VariantRow>) => void;
  /** Show only these groups (the single-variant sections); all when omitted. */
  only?: Array<"compareAt" | "tax" | "weight" | "track" | "image" | "preorder">;
}) {
  const t = useTranslations("Commerce.catalogue.form");
  const show = (k: NonNullable<typeof only>[number]) => !only || only.includes(k);
  const field = (key: RowErrorKey, label: string, input: React.ReactNode) => (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      {input}
      {errors.has(key) && <p className="text-xs text-destructive">{t(`invalid.${key}`)}</p>}
    </div>
  );
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        {show("compareAt") && field("compareAt", t("compareAt"), <Input inputMode="decimal" value={row.compareAt} readOnly={readOnly || !currency}
          onChange={(e) => onChange({ compareAt: e.target.value })} />)}
        {show("tax") && field("tax", t("taxRate"), <Input inputMode="decimal" value={row.tax} readOnly={readOnly} placeholder={t("taxDefault")}
          onChange={(e) => onChange({ tax: e.target.value })} />)}
        {show("tax") && field("hsn", t("hsn"), <Input inputMode="numeric" maxLength={8} value={row.hsn} readOnly={readOnly}
          onChange={(e) => onChange({ hsn: e.target.value })} />)}
        {show("weight") && field("weight", t("weight"), <Input inputMode="numeric" value={row.weight} readOnly={readOnly}
          onChange={(e) => onChange({ weight: e.target.value })} />)}
      </div>
      {show("track") && (
        <label className="flex min-h-11 items-center gap-2 text-sm sm:min-h-0">
          <input type="checkbox" className="size-4" checked={row.track} disabled={readOnly} onChange={(e) => onChange({ track: e.target.checked })} />
          {t("trackInventory")}
          {row.id && row.track && <span className="text-xs text-muted-foreground">{t("reserved", { count: row.reserved })}</span>}
        </label>
      )}
      {show("image") && images.length > 0 && (
        <fieldset className="space-y-1">
          <legend className="text-xs font-medium text-foreground">{t("variantImage")}</legend>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={readOnly} aria-pressed={row.image === null} onClick={() => onChange({ image: null })}
              className={`h-14 rounded border px-2 text-xs ${row.image === null ? "border-primary ring-2 ring-primary" : "border-border"}`}>{t("noVariantImage")}</button>
            {images.map((img, i) => (
              <button key={imageKey(img)} type="button" disabled={readOnly || !img.display} aria-pressed={row.image === imageKey(img)}
                aria-label={t("variantImageN", { n: i + 1 })} onClick={() => onChange({ image: imageKey(img) })}
                className={`h-14 w-14 overflow-hidden rounded border ${row.image === imageKey(img) ? "border-primary ring-2 ring-primary" : "border-border"}`}>
                {img.display
                  // eslint-disable-next-line @next/next/no-img-element -- seller-provided https or library images
                  ? <img src={img.display} alt="" className="size-full object-cover" referrerPolicy="no-referrer" loading="lazy" />
                  : <span className="block size-full bg-muted" />}
              </button>
            ))}
          </div>
        </fieldset>
      )}
      {show("preorder") && (physical || row.preorder) && <PreorderFields row={row} readOnly={readOnly} errors={errors} onChange={onChange} />}
    </div>
  );
}

export function PreorderFields({ row, readOnly, errors, onChange }: {
  row: Pick<VariantRow, "preorder" | "shipDate" | "cap">; readOnly: boolean; errors: Set<RowErrorKey>; onChange: (patch: Partial<VariantRow>) => void;
}) {
  const t = useTranslations("Commerce.catalogue.form");
  return (
    <div className="space-y-2">
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-0.5 size-4" checked={row.preorder} disabled={readOnly} onChange={(e) => onChange({ preorder: e.target.checked })} />
        <span>
          <span className="block font-medium">{t("preorder")}</span>
          <span className="block text-xs text-muted-foreground">{t("preorderHint")}</span>
        </span>
      </label>
      {row.preorder && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-xs">{t("preorderShipDate")}</Label>
            <Input type="date" value={row.shipDate} readOnly={readOnly} onChange={(e) => onChange({ shipDate: e.target.value })} />
            {errors.has("preorderShipDate") && <p className="text-xs text-destructive">{t("invalid.preorderShipDate")}</p>}
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t("preorderCap")}</Label>
            <Input inputMode="numeric" value={row.cap} readOnly={readOnly} placeholder={t("preorderNoCap")} onChange={(e) => onChange({ cap: e.target.value })} />
            {errors.has("preorderCap") && <p className="text-xs text-destructive">{t("invalid.preorderCap")}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
