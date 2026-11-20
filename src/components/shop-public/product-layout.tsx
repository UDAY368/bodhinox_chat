import type { ReactNode } from 'react';
import type { ShopLayout } from '@/lib/commerce/shop-templates';

/**
 * The product page's arrangement per template (layout.product), as container
 * classes so the theme editor's phone and desktop previews match the shop:
 *
 * - split: gallery left, details right, equal halves.
 * - stacked: a full-width gallery, the details below in a readable column.
 * - sticky: a wide gallery that scrolls while the details column stays in view.
 * - compact: a small gallery beside the details, for quick everyday buying.
 *
 * Phones always stack (gallery first). `PRODUCT_LAYOUT_CLASSES` is exported
 * for a component that draws gallery and details itself (ProductBuy): put
 * `grid` on its outer element and `gallery` / `details` on the two columns.
 */
export const PRODUCT_LAYOUT_CLASSES: Record<ShopLayout['product'], { grid: string; gallery: string; details: string }> = {
  split: { grid: 'grid gap-6 @3xl:grid-cols-2 @3xl:gap-10', gallery: 'min-w-0', details: 'min-w-0' },
  stacked: { grid: 'grid gap-6 @3xl:gap-8', gallery: 'min-w-0 @3xl:mx-auto @3xl:w-full @3xl:max-w-4xl', details: 'min-w-0 @3xl:mx-auto @3xl:w-full @3xl:max-w-2xl' },
  sticky: {
    grid: 'grid gap-6 @3xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] @3xl:items-start @3xl:gap-10',
    gallery: 'min-w-0',
    details: 'min-w-0 @3xl:sticky @3xl:top-24 @3xl:self-start',
  },
  compact: { grid: 'grid gap-4 @2xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] @2xl:gap-6', gallery: 'min-w-0 @3xl:max-w-sm', details: 'min-w-0' },
};

/** Gallery and details arranged the template's way. */
export function ProductLayout({ layout, gallery, details }: { layout: ShopLayout; gallery: ReactNode; details: ReactNode }) {
  const c = PRODUCT_LAYOUT_CLASSES[layout.product];
  return (
    <div className={c.grid} data-product-layout={layout.product}>
      <div className={c.gallery}>{gallery}</div>
      <div className={c.details}>{details}</div>
    </div>
  );
}
