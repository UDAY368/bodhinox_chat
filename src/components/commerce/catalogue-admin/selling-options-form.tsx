"use client";

/**
 * A product's selling options (store plan Phase 8): scheduled publish and hide, a digital download (a library
 * file or an https URL) and bundles (parts with quantities). Admins edit; agents read. Pre-orders are set on each
 * variant (variant form). Everything is validated again on the server.
 */
import { useEffect, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MediaPicker } from "@/components/inbox/media-library/media-picker";
import { fetchInventory, type InventoryRow, type ShopProduct } from "./catalogue-api";

/** An ISO time as the value of a datetime-local input (the browser's own time zone), and back. */
const toLocalInput = (iso: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fromLocalInput = (value: string): string | null => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

interface PartRow { variantId: string; quantity: string; label: string }

export function SellingOptionsForm({ product, canManage, busy, onSave }: {
  product: ShopProduct; canManage: boolean; busy: boolean;
  onSave: (body: Record<string, unknown>, parts: Array<{ variant_id: string; quantity: number }> | null) => Promise<boolean>;
}) {
  const t = useTranslations("Commerce.catalogue.editor");
  const [publishAt, setPublishAt] = useState(toLocalInput(product.publish_at));
  const [hideAt, setHideAt] = useState(toLocalInput(product.hide_at));
  const [digital, setDigital] = useState(product.is_digital);
  const [url, setUrl] = useState(product.digital_url ?? "");
  const [mediaId, setMediaId] = useState<string | null>(product.digital_media_id);
  const [mediaName, setMediaName] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [bundle, setBundle] = useState(product.is_bundle);
  const [parts, setParts] = useState<PartRow[]>(product.bundle_parts.map((p) => ({ variantId: p.variant_id, quantity: String(p.quantity), label: `${p.name} · ${p.sku}` })));
  const [search, setSearch] = useState("");
  const [found, setFound] = useState<InventoryRow[] | null>(null);
  const ro = !canManage;

  useEffect(() => {
    if (!bundle || search.trim().length < 2) return;
    let live = true;
    const timer = setTimeout(() => {
      fetchInventory({ q: search.trim(), limit: 8 }).then((r) => { if (live && r.ok) setFound(r.data.items); });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [search, bundle]);

  const publishIso = fromLocalInput(publishAt);
  const hideIso = fromLocalInput(hideAt);
  const orderBad = publishIso !== null && hideIso !== null && new Date(hideIso).getTime() <= new Date(publishIso).getTime();
  const urlOk = url.trim() === "" || /^https:\/\/\S+$/.test(url.trim());
  const sourceOk = !digital || (mediaId !== null ? url.trim() === "" : url.trim() !== "" && urlOk);
  const partNumbers = parts.map((p) => Number(p.quantity));
  const partsOk = !bundle || (parts.length > 0 && partNumbers.every((n) => Number.isInteger(n) && n >= 1 && n <= 99));
  const valid = !orderBad && sourceOk && partsOk && !(digital && bundle);

  const submit = () => onSave({
    publish_at: publishIso, hide_at: hideIso, is_digital: digital, is_bundle: bundle,
    digital_media_id: digital ? mediaId : null, digital_url: digital && mediaId === null ? url.trim() || null : null,
  }, bundle ? parts.map((p) => ({ variant_id: p.variantId, quantity: Number(p.quantity) })) : null);

  return (
    <form className="space-y-4 rounded-xl border border-border bg-card p-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div>
        <h2 className="text-base font-semibold tracking-tight text-foreground">{t("sellingTitle")}</h2>
        <p className="text-xs text-muted-foreground">{t("sellingHint")}</p>
      </div>

      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="mb-1 text-sm font-medium text-foreground">{t("scheduleTitle")}</legend>
        <div className="space-y-1">
          <Label htmlFor="s-publish">{t("publishAt")}</Label>
          <Input id="s-publish" type="datetime-local" value={publishAt} readOnly={ro} onChange={(e) => setPublishAt(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="s-hide">{t("hideAt")}</Label>
          <Input id="s-hide" type="datetime-local" value={hideAt} readOnly={ro} onChange={(e) => setHideAt(e.target.value)} />
        </div>
        <p className="text-xs text-muted-foreground sm:col-span-2">{t("scheduleHint")}</p>
        {orderBad && <p className="text-xs text-destructive sm:col-span-2" role="alert">{t("invalid.scheduleOrder")}</p>}
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium text-foreground">{t("digitalTitle")}</legend>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 size-4" checked={digital} disabled={ro || bundle} onChange={(e) => setDigital(e.target.checked)} />
          <span>
            <span className="block font-medium text-foreground">{t("isDigital")}</span>
            <span className="block text-xs text-muted-foreground">{t("digitalHint")}</span>
          </span>
        </label>
        {digital && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>{t("digitalFile")}</Label>
              <div className="flex flex-wrap items-center gap-2">
                {mediaId ? <Badge variant="secondary">{mediaName ?? t("digitalFileChosen")}</Badge> : <span className="text-xs text-muted-foreground">{t("digitalNoFile")}</span>}
                {canManage && <Button type="button" size="sm" variant="outline" onClick={() => setPickerOpen(true)}>{t("digitalChooseFile")}</Button>}
                {canManage && mediaId && <Button type="button" size="sm" variant="ghost" onClick={() => { setMediaId(null); setMediaName(null); }}>{t("digitalRemoveFile")}</Button>}
              </div>
              <MediaPicker open={pickerOpen} onOpenChange={setPickerOpen} initialKind="all" onPick={(media) => {
                setMediaId(media.id); setMediaName(media.filename ?? null); setUrl(""); setPickerOpen(false);
              }} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="s-url">{t("digitalUrl")}</Label>
              <Input id="s-url" type="url" inputMode="url" placeholder="https://" maxLength={2048} value={url} readOnly={ro || mediaId !== null}
                onChange={(e) => setUrl(e.target.value)} />
              {!urlOk && <p className="text-xs text-destructive" role="alert">{t("invalid.digitalUrl")}</p>}
            </div>
            {!sourceOk && urlOk && <p className="text-xs text-destructive sm:col-span-2" role="alert">{t("invalid.digitalSource")}</p>}
          </div>
        )}
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium text-foreground">{t("bundleTitle")}</legend>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 size-4" checked={bundle} disabled={ro || digital} onChange={(e) => setBundle(e.target.checked)} />
          <span>
            <span className="block font-medium text-foreground">{t("isBundle")}</span>
            <span className="block text-xs text-muted-foreground">{t("bundleHint")}</span>
          </span>
        </label>
        {bundle && (
          <div className="space-y-2">
            {product.is_bundle && (
              <p className="text-xs text-muted-foreground">
                {product.bundle_available === null ? t("bundleUnlimited") : t("bundleAvailable", { count: product.bundle_available })}
              </p>
            )}
            {parts.length === 0 && <p className="text-xs text-muted-foreground">{t("bundleNoParts")}</p>}
            <ul className="space-y-2">
              {parts.map((p, i) => (
                <li key={p.variantId} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="min-w-0 flex-1 break-words">{p.label}</span>
                  <Input aria-label={t("bundleQty")} className="w-20" inputMode="numeric" value={p.quantity} readOnly={ro}
                    onChange={(e) => setParts((list) => list.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} />
                  {canManage && (
                    <Button type="button" size="icon" variant="ghost" aria-label={t("bundleRemove")} onClick={() => setParts((list) => list.filter((_, j) => j !== i))}>
                      <Trash2 className="size-4" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            {canManage && parts.length < 20 && (
              <div className="space-y-1">
                <Label htmlFor="s-part-search">{t("bundleAdd")}</Label>
                <Input id="s-part-search" value={search} placeholder={t("bundleSearch")} onChange={(e) => { setSearch(e.target.value); if (e.target.value.trim().length < 2) setFound(null); }} />
                {found && (
                  <ul className="rounded-md border border-border">
                    {found.filter((r) => r.product_id !== product.id && !parts.some((p) => p.variantId === r.variant_id)).map((r) => (
                      <li key={r.variant_id}>
                        <button type="button" className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                          onClick={() => { setParts((list) => [...list, { variantId: r.variant_id, quantity: "1", label: `${r.product_name} · ${r.sku}` }]); setSearch(""); setFound(null); }}>
                          <span className="min-w-0 break-words">{r.product_name} · {r.sku}</span>
                          <span className="shrink-0 text-xs text-muted-foreground">{r.available}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {!partsOk && <p className="text-xs text-destructive" role="alert">{t("invalid.bundleParts")}</p>}
          </div>
        )}
      </fieldset>

      {canManage && (
        <Button type="submit" disabled={busy || !valid}>
          {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}{t("saveSelling")}
        </Button>
      )}
    </form>
  );
}
