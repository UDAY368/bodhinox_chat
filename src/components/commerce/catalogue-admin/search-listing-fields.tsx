"use client";

/**
 * "Search engine listing" (store Batch 6): the product's web address (slug), search title, search description and share image.
 * Self-contained and controlled: the product form owns the values, mounts this in a closed section and adds searchListingPayload()
 * to its normal product update. No save button and no call of its own.
 */

import { useTranslations } from "next-intl";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { isShopSlug } from "@/lib/commerce/shop-paths";
import type { ShopProduct } from "./catalogue-api";

export const SEO_TITLE_MAX = 70;
export const SEO_DESCRIPTION_MAX = 160;

export interface SearchListingValues { slug: string; seoTitle: string; seoDescription: string; seoImageId: string }

export const searchListingValues = (p: ShopProduct): SearchListingValues => ({
  slug: p.slug ?? "", seoTitle: p.seo_title ?? "", seoDescription: p.seo_description ?? "", seoImageId: p.seo_image_id ?? "",
});

/**
 * Empty fields go as null (use the name, description and first image). The address goes only when the seller changed it from
 * `initial`, so an untouched address can still follow a rename; an emptied one lets the name decide it again.
 */
export const searchListingPayload = (v: SearchListingValues, initial?: SearchListingValues) => ({
  ...(initial && v.slug.trim() === initial.slug ? {} : { slug: v.slug.trim().toLowerCase() || null }),
  seo_title: v.seoTitle.replace(/\s+/g, " ").trim() || null,
  seo_description: v.seoDescription.replace(/\s+/g, " ").trim() || null,
  seo_image_id: v.seoImageId || null,
});

export function searchListingValid(v: SearchListingValues): boolean {
  const p = searchListingPayload(v);
  return (!p.slug || isShopSlug(p.slug)) && (p.seo_title ?? "").length <= SEO_TITLE_MAX && (p.seo_description ?? "").length <= SEO_DESCRIPTION_MAX;
}

export function SearchListingFields({ value, onChange, images, readOnly }: {
  value: SearchListingValues; onChange: (next: SearchListingValues) => void;
  images: ShopProduct["images"]; readOnly: boolean;
}) {
  const t = useTranslations("Commerce.catalogue.editor.searchListing");
  const set = (k: keyof SearchListingValues) => (e: { target: { value: string } }) => onChange({ ...value, [k]: e.target.value });
  const slug = value.slug.trim();
  const slugBad = !!slug && !isShopSlug(slug.toLowerCase());
  return (
    <details className="rounded-lg border border-border">
      <summary className="flex min-h-11 cursor-pointer items-center px-3 text-sm font-medium text-foreground">{t("title")}</summary>
      <div className="space-y-3 border-t border-border p-3">
        <p className="text-xs text-muted-foreground">{t("hint")}</p>
        <div className="space-y-1">
          <Label htmlFor="p-slug">{t("address")}</Label>
          <Input id="p-slug" value={value.slug} maxLength={60} readOnly={readOnly} onChange={set("slug")} placeholder={t("addressPlaceholder")}
            aria-invalid={slugBad} autoCapitalize="none" spellCheck={false} />
          <p className={`text-xs ${slugBad ? "text-destructive" : "text-muted-foreground"}`}>{slugBad ? t("addressInvalid") : t("addressHint")}</p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="p-seo-title">{t("seoTitle")}</Label>
          <Input id="p-seo-title" value={value.seoTitle} maxLength={SEO_TITLE_MAX} readOnly={readOnly} onChange={set("seoTitle")} />
          <p className="text-xs text-muted-foreground">{t("count", { count: value.seoTitle.trim().length, max: SEO_TITLE_MAX })}</p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="p-seo-desc">{t("seoDescription")}</Label>
          <Textarea id="p-seo-desc" rows={3} value={value.seoDescription} maxLength={SEO_DESCRIPTION_MAX} readOnly={readOnly} onChange={set("seoDescription")} />
          <p className="text-xs text-muted-foreground">{t("count", { count: value.seoDescription.trim().length, max: SEO_DESCRIPTION_MAX })}</p>
        </div>
        {images.length > 0 && (
          <div className="space-y-1">
            <Label htmlFor="p-seo-image">{t("shareImage")}</Label>
            <select id="p-seo-image" className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm" value={value.seoImageId}
              disabled={readOnly} onChange={set("seoImageId")}>
              <option value="">{t("firstImage")}</option>
              {images.map((image, i) => <option key={image.id} value={image.id}>{t("imageN", { n: i + 1 })}</option>)}
            </select>
          </div>
        )}
      </div>
    </details>
  );
}
