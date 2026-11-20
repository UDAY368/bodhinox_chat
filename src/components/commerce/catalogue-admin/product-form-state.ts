// The product form's whole state in one place (batch 4): the product fields,
// photos, options, every variant row and the selling options. Pure functions:
// read a product into a form, validate it, and turn it into the one Save body.

import { cleanOptions, optionsOf, type ProductOption } from "@/lib/commerce/catalogue/variant-matrix";
import type { ProductFormBody, ShopProduct, VariantRowBody } from "./catalogue-api";
import { bpsToPercent, moneyInput, moneyText, percentToBps } from "./catalogue-format";

export type FormImage = ({ url: string } | { media_id: string }) & { display: string | null };
/** A photo's identity in the form (its library id or its link), which survives reordering. */
export const imageKey = (i: FormImage | { media_id: string | null; url: string | null }) => ("media_id" in i && i.media_id ? i.media_id : (i as { url: string }).url);

export interface VariantRow {
  /** Stable React key (the variant id, or a local one for a new row). */
  key: string;
  id: string | null;
  option_values: Record<string, string>;
  sku: string;
  price: string;
  compareAt: string;
  tax: string;
  hsn: string;
  weight: string;
  track: boolean;
  /** Units on hand as typed; `baseOnHand` is the count the form was read with. */
  stock: string;
  baseOnHand: number;
  reserved: number;
  /** The picture for this variant: imageKey() of one of the form's photos, or null. */
  image: string | null;
  preorder: boolean;
  shipDate: string;
  cap: string;
  /** Facts shown next to the row (read only). */
  ordered: boolean;
  waiting: number;
  metaLinked: boolean;
}

export interface PartRow { variantId: string; quantity: string; label: string }

export interface ProductFormState {
  name: string;
  description: string;
  category_id: string;
  disclosure: string;
  brand: string;
  product_type: string;
  tags: string;
  details: { label: string; value: string }[];
  follow_up_template: string;
  follow_up_template_language: string;
  follow_up_after_days: string;
  repurchase_after_days: string;
  cod_available: boolean;
  publishAt: string;
  hideAt: string;
  digital: boolean;
  digitalUrl: string;
  digitalMediaId: string | null;
  bundle: boolean;
  parts: PartRow[];
  images: FormImage[];
  options: ProductOption[];
  rows: VariantRow[];
}

let localKey = 0;
export const newRowKey = () => `new-${++localKey}`;

/** A fresh row for a new combination; copies the shared settings (price, tax, weight...) from `like`. */
export function freshRow(values: Record<string, string>, like?: VariantRow): VariantRow {
  return {
    key: newRowKey(), id: null, option_values: values, sku: "", price: like?.price ?? "", compareAt: like?.compareAt ?? "",
    tax: like?.tax ?? "", hsn: like?.hsn ?? "", weight: like?.weight ?? "", track: like?.track ?? true, stock: "", baseOnHand: 0, reserved: 0,
    image: null, preorder: like?.preorder ?? false, shipDate: like?.shipDate ?? "", cap: like?.cap ?? "",
    ordered: false, waiting: 0, metaLinked: false,
  };
}

/** An ISO time as the value of a datetime-local input (the browser's own time zone), and back. */
export const toLocalInput = (iso: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const fromLocalInput = (value: string): string | null => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

type Variant = ShopProduct["variants"][number];

export function rowOf(v: Variant, currency: string | null, images: ShopProduct["images"]): VariantRow {
  const picked = v.image_id ? images.find((i) => i.id === v.image_id) : undefined;
  return {
    key: v.id, id: v.id, option_values: { ...v.option_values }, sku: v.sku, price: moneyText(v.price_minor, currency),
    compareAt: moneyText(v.compare_at_minor, currency), tax: bpsToPercent(v.tax_rate_bps), hsn: v.hsn_code ?? "",
    weight: v.weight_grams?.toString() ?? "", track: v.track_inventory, stock: v.track_inventory ? String(v.on_hand) : "",
    baseOnHand: v.on_hand, reserved: v.reserved, image: picked ? (picked.media_id ?? picked.url) : null, preorder: v.preorder,
    shipDate: v.preorder_ship_date ?? "", cap: v.preorder_cap?.toString() ?? "", ordered: v.ordered, waiting: v.waiting, metaLinked: v.meta_linked,
  };
}

export function emptyForm(categoryId = ""): ProductFormState {
  return {
    name: "", description: "", category_id: categoryId, disclosure: "", brand: "", product_type: "", tags: "", details: [],
    follow_up_template: "", follow_up_template_language: "", follow_up_after_days: "", repurchase_after_days: "", cod_available: true,
    publishAt: "", hideAt: "", digital: false, digitalUrl: "", digitalMediaId: null, bundle: false, parts: [],
    images: [], options: [], rows: [freshRow({})],
  };
}

export function formOf(p: ShopProduct): ProductFormState {
  const active = p.variants.filter((v) => !v.archived);
  return {
    name: p.name, description: p.description ?? "", category_id: p.category_id ?? "", disclosure: p.disclosure ?? "",
    brand: p.brand ?? "", product_type: p.product_type ?? "", tags: p.tags.join(", "), details: p.details.map((d) => ({ ...d })),
    follow_up_template: p.follow_up_template ?? "", follow_up_template_language: p.follow_up_template_language ?? "",
    follow_up_after_days: p.follow_up_after_days?.toString() ?? "", repurchase_after_days: p.repurchase_after_days?.toString() ?? "",
    // Older responses have no cod_available: treat as allowed (the column defaults to true).
    cod_available: p.cod_available !== false,
    publishAt: toLocalInput(p.publish_at), hideAt: toLocalInput(p.hide_at),
    digital: p.is_digital, digitalUrl: p.digital_url ?? "", digitalMediaId: p.digital_media_id,
    bundle: p.is_bundle, parts: p.bundle_parts.map((x) => ({ variantId: x.variant_id, quantity: String(x.quantity), label: `${x.name} · ${x.sku}` })),
    images: p.images.map((i) => (i.media_id ? { media_id: i.media_id, display: i.display_url } : { url: i.url ?? "", display: i.url })),
    options: optionsOf(active),
    rows: active.length ? active.map((v) => rowOf(v, p.currency, p.images)) : [freshRow({})],
  };
}

/** Archived variants of the product, so a combination typed again restores its old variant (same id and SKU). */
export const archivedPool = (p: ShopProduct | null): VariantRow[] =>
  (p?.variants ?? []).filter((v) => v.archived).map((v) => ({ ...rowOf(v, p!.currency, p!.images), stock: v.track_inventory ? String(v.on_hand) : "" }));

// ------------------------------------------------------------ validation

export type RowErrorKey = "sku" | "price" | "compareAt" | "tax" | "hsn" | "weight" | "stock" | "preorderShipDate" | "preorderCap";
export interface FormErrors {
  name: boolean;
  tags: boolean;
  details: boolean;
  followUp: boolean;
  schedule: boolean;
  digital: boolean;
  bundle: boolean;
  options: boolean;
  /** Per row key: the fields with a problem. */
  rows: Record<string, RowErrorKey[]>;
}

const dayOk = (text: string) => !text.trim() || (/^\d+$/.test(text.trim()) && Number(text) >= 1 && Number(text) <= 365);
export const tagList = (tags: string) => tags.split(",").map((x) => x.trim()).filter(Boolean);

export function rowErrors(r: VariantRow, currency: string | null): RowErrorKey[] {
  const out: RowErrorKey[] = [];
  if (r.sku.trim() && !/^[A-Za-z0-9._-]{1,64}$/.test(r.sku.trim())) out.push("sku");
  if (moneyInput(r.price, currency) === undefined) out.push("price");
  if (moneyInput(r.compareAt, currency) === undefined) out.push("compareAt");
  if (percentToBps(r.tax) === undefined) out.push("tax");
  if (r.hsn.trim() && !/^[0-9]{4,8}$/.test(r.hsn.trim())) out.push("hsn");
  const w = r.weight.trim();
  if (w && !(/^\d+$/.test(w) && Number(w) <= 1_000_000)) out.push("weight");
  const s = r.stock.trim();
  if (r.track && s && !(/^\d+$/.test(s) && Number(s) <= 1_000_000 && Number(s) >= r.reserved)) out.push("stock");
  if (r.preorder && !/^\d{4}-\d{2}-\d{2}$/.test(r.shipDate)) out.push("preorderShipDate");
  const c = r.cap.trim();
  if (r.preorder && c && !(/^\d+$/.test(c) && Number(c) >= 1 && Number(c) <= 1_000_000)) out.push("preorderCap");
  return out;
}

export function validate(f: ProductFormState, currency: string | null): FormErrors {
  const tags = tagList(f.tags);
  const publish = fromLocalInput(f.publishAt), hide = fromLocalInput(f.hideAt);
  const urlOk = f.digitalUrl.trim() === "" || /^https:\/\/\S+$/.test(f.digitalUrl.trim());
  const rows: Record<string, RowErrorKey[]> = {};
  for (const r of f.rows) { const e = rowErrors(r, currency); if (e.length) rows[r.key] = e; }
  return {
    name: !f.name.trim() || f.name.trim().length > 200,
    tags: tags.length > 20 || tags.some((x) => x.length > 40),
    details: !f.details.every((d) => (!d.label.trim() && !d.value.trim()) || (d.label.trim() && d.value.trim())),
    followUp: !dayOk(f.follow_up_after_days) || !dayOk(f.repurchase_after_days)
      || (!!f.follow_up_template.trim() && f.follow_up_template_language.trim().length < 2),
    schedule: publish !== null && hide !== null && new Date(hide).getTime() <= new Date(publish).getTime(),
    digital: f.digital && (!urlOk || (f.digitalMediaId !== null ? f.digitalUrl.trim() !== "" : f.digitalUrl.trim() === "")),
    bundle: f.bundle && (f.digital || !f.parts.length || !f.parts.every((p) => /^\d+$/.test(p.quantity) && Number(p.quantity) >= 1 && Number(p.quantity) <= 99)),
    options: f.rows.length < 1 || f.rows.length > 100,
    rows,
  };
}

export const hasErrors = (e: FormErrors) =>
  e.name || e.tags || e.details || e.followUp || e.schedule || e.digital || e.bundle || e.options || Object.keys(e.rows).length > 0;

// ------------------------------------------------------------ the Save body

const indexOfImage = (images: FormImage[], key: string | null) => {
  const i = key ? images.findIndex((x) => imageKey(x) === key) : -1;
  return i >= 0 ? i : null;
};
const imageRef = (i: FormImage): { url: string } | { media_id: string } => ("media_id" in i ? { media_id: i.media_id } : { url: i.url });

/** The Save body. Photos are sent only when they changed (sending them recreates the image rows). */
export function bodyOf(f: ProductFormState, currency: string | null, base: ProductFormState | null, version: number | null): ProductFormBody {
  const intOrNull = (text: string) => (text.trim() ? Number(text.trim()) : null);
  const followUp = f.follow_up_template.trim();
  const imagesChanged = !base || JSON.stringify(f.images.map(imageRef)) !== JSON.stringify(base.images.map(imageRef));
  const physical = !f.bundle && !f.digital;
  const variants: VariantRowBody[] = f.rows.map((r) => ({
    id: r.id, option_values: r.option_values, sku: r.sku.trim(),
    price_minor: moneyInput(r.price, currency) ?? null, compare_at_minor: moneyInput(r.compareAt, currency) ?? null,
    tax_rate_bps: percentToBps(r.tax) ?? null, hsn_code: r.hsn.trim() || null, track_inventory: r.track,
    weight_grams: intOrNull(r.weight), image_index: indexOfImage(f.images, r.image),
    ...(physical || r.preorder ? { preorder: physical && r.preorder, preorder_ship_date: physical && r.preorder ? r.shipDate : null,
      preorder_cap: physical && r.preorder ? intOrNull(r.cap) : null } : {}),
    ...(r.track ? { stock: r.stock.trim() ? Number(r.stock.trim()) : r.id ? r.baseOnHand : 0, expected_on_hand: r.baseOnHand } : {}),
  }));
  return {
    ...(version !== null ? { version } : {}),
    name: f.name.trim(), description: f.description.trim() || null, disclosure: f.disclosure.trim() || null, category_id: f.category_id || null,
    brand: f.brand.trim() || null, product_type: f.product_type.trim() || null, tags: tagList(f.tags),
    details: f.details.filter((d) => d.label.trim() || d.value.trim()).map((d) => ({ label: d.label.trim(), value: d.value.trim() })),
    follow_up_template: followUp || null, follow_up_template_language: followUp ? f.follow_up_template_language.trim() || null : null,
    follow_up_after_days: followUp ? intOrNull(f.follow_up_after_days) : null, repurchase_after_days: intOrNull(f.repurchase_after_days),
    cod_available: f.cod_available,
    publish_at: fromLocalInput(f.publishAt), hide_at: fromLocalInput(f.hideAt), is_digital: f.digital, is_bundle: f.bundle,
    digital_media_id: f.digital ? f.digitalMediaId : null, digital_url: f.digital && f.digitalMediaId === null ? f.digitalUrl.trim() || null : null,
    ...(imagesChanged ? { images: f.images.map(imageRef) } : {}),
    variants,
    ...(f.bundle ? { parts: f.parts.map((p) => ({ variant_id: p.variantId, quantity: Number(p.quantity) })) } : {}),
  };
}

/** The options as they will be saved (blank names and values dropped). */
export const savedOptions = (f: ProductFormState) => cleanOptions(f.options);
