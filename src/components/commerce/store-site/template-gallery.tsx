"use client";

/**
 * The theme editor's template gallery: every template drawn live (the real
 * shop frame, banner and product cards, scaled down, not interactive) with
 * the shop's own products, or sample products (local placeholder pictures in
 * /public/shop-samples) when it has fewer than two. Tapping a template opens
 * a sheet with a full-size preview and one main action, "Use template",
 * which sets the draft's template (saving and publishing stay as they are).
 */
import { useMemo, useState, type MouseEvent } from "react";
import { useTranslations } from "next-intl";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ShopFrameView, type FrameShop } from "@/components/shop-public/shop-frame";
import type { ShopT } from "@/components/shop-public/shop-link";
import { ShopSectionsView, type SectionContext } from "@/components/shop-public/shop-sections";
import type { PublicProduct } from "@/lib/commerce/public-shop";
import { newSection, type ShopSection } from "@/lib/commerce/shop-sections";
import { resolveTheme, SHOP_TEMPLATE_IDS, type ShopTemplateId, type ShopThemeSettings } from "@/lib/commerce/shop-templates";

const SAMPLE_PRICES = [49900, 129900, 34900, 89900, 24900, 59900];
const PREVIEW_WIDTH = 390;
const TILE_SCALE = 0.42;

/** Six sample products with local placeholder pictures, for a shop with too few of its own. */
export function sampleProducts(names: string[]): PublicProduct[] {
  return names.map((name, i) => ({
    id: `00000000-0000-4000-8000-00000000000${i + 1}`, slug: null, categorySlug: null, name, description: null, disclosure: null, categoryId: null, categoryName: null,
    images: [`/shop-samples/sample-${i + 1}.svg`], details: [], digital: false, rating: i % 2 === 0 ? { average: 4.5, count: 12 + i } : null,
    variants: [{
      id: `00000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`, options: {}, priceMinor: SAMPLE_PRICES[i],
      compareAtMinor: i === 1 ? 159900 : null, inStock: true, available: null, imageIndex: null, shipsBy: null,
    }],
  }));
}

/** The home page every preview shows: the banner and four products. */
const PREVIEW_SECTIONS: ShopSection[] = [
  newSection("banner", "gbanner"),
  { ...newSection("product_grid", "ggrid"), settings: { ...newSection("product_grid", "ggrid").settings, limit: 4 } },
];

export function TemplateGallery({ current, onUse, canEdit, shop, settings, products, ctx, t: tShop }: {
  current: ShopTemplateId;
  onUse: (id: ShopTemplateId) => void;
  canEdit: boolean;
  /** The shop's frame as the editor draws it (name, logo, menu, footer); the theme is replaced per template. */
  shop: Omit<FrameShop, "theme">;
  /** The draft's brand settings: logo and texts are kept, colors and fonts show each template's own. */
  settings: ShopThemeSettings;
  products: PublicProduct[];
  ctx: Omit<SectionContext, "theme" | "products" | "preview">;
  t: ShopT;
}) {
  const t = useTranslations("Commerce.storeEditor");
  const ts = useTranslations("Commerce.storeSite");
  const [picked, setPicked] = useState<ShopTemplateId | null>(null);
  const shown = useMemo(
    () => (products.length >= 2 ? products.slice(0, 4) : sampleProducts([1, 2, 3, 4, 5, 6].map((n) => t(`samples.p${n}` as never)))),
    [products, t],
  );
  const themed = (id: ShopTemplateId) => resolveTheme(id, { ...settings, colors: {}, font: {} });
  const preview = (id: ShopTemplateId) => {
    const theme = themed(id);
    return (
      <ShopFrameView shop={{ ...shop, theme }} t={tShop} preview>
        <ShopSectionsView sections={PREVIEW_SECTIONS} ctx={{ ...ctx, theme, products: shown, preview: true }} />
      </ShopFrameView>
    );
  };
  // The full-size preview is scrollable but its links and buttons do nothing.
  const swallow = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); };

  return (
    <>
      <ul className="grid grid-cols-2 gap-3">
        {SHOP_TEMPLATE_IDS.map((id) => (
          <li key={id}>
            <button type="button" onClick={() => setPicked(id)} aria-current={current === id ? "true" : undefined}
              className={`group w-full rounded-lg border p-1.5 text-left transition hover:border-foreground/40 ${current === id ? "border-primary ring-2 ring-primary" : ""}`}>
              <span className="relative block h-[280px] overflow-hidden rounded-md bg-muted" aria-hidden>
                <span inert className="pointer-events-none absolute left-0 top-0 block origin-top-left"
                  style={{ width: PREVIEW_WIDTH, transform: `scale(${TILE_SCALE})` }}>
                  {preview(id)}
                </span>
              </span>
              <span className="flex items-center justify-between gap-1 px-1 pt-2">
                <span className="text-sm font-semibold">{ts(`templates.${id}.name`)}</span>
                {current === id && <Check className="size-4 text-primary" aria-label={t("templateInUse")} />}
              </span>
            </button>
          </li>
        ))}
      </ul>

      <Sheet open={picked !== null} onOpenChange={(open) => { if (!open) setPicked(null); }}>
        <SheetContent side="right" size="md" className="w-full gap-0 p-0">
          {picked && (
            <>
              <SheetHeader className="border-b p-4">
                <SheetTitle>{ts(`templates.${picked}.name`)}</SheetTitle>
                <SheetDescription>{ts(`templates.${picked}.description`)}</SheetDescription>
              </SheetHeader>
              <div className="min-h-0 flex-1 overflow-y-auto bg-muted/40 p-3">
                <div className="relative mx-auto max-w-full overflow-hidden rounded-md border bg-white" style={{ width: PREVIEW_WIDTH }} onClickCapture={swallow}>
                  {preview(picked)}
                </div>
              </div>
              <SheetFooter className="border-t p-4">
                <p className="text-xs text-muted-foreground">{t("switchKeeps")}</p>
                <Button type="button" className="h-11 w-full" disabled={!canEdit || picked === current}
                  onClick={() => { onUse(picked); setPicked(null); }}>
                  {picked === current ? t("templateInUse") : t("useTemplate")}
                </Button>
              </SheetFooter>
            </>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
