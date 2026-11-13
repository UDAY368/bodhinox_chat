"use client";

/**
 * Searchable list of mirrored catalogue products, used by the inbox "Send
 * product" dialog and the flow catalogue steps. Selection is by the caller's
 * key (products.id in the inbox, retailer_id in flows).
 */

import { useEffect, useState } from "react";
import { Check, Loader2, Search } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { Input } from "@/components/ui/input";
import { formatMoney } from "@/lib/commerce/money";
import { cn } from "@/lib/utils";
import { fetchProducts, type ProductPublic } from "./catalog-api";

/** The price as the customer sees it, or null when the catalogue has none. */
export function productPrice(product: Pick<ProductPublic, "price_minor" | "currency">, locale: string): string | null {
  if (product.price_minor === null || !product.currency) return null;
  try {
    return formatMoney(product.price_minor, product.currency, locale);
  } catch {
    return null;
  }
}

export function ProductPicker({
  selected,
  keyOf,
  onToggle,
  whatsappConfigId,
  conversationId,
  disabled,
  className,
}: {
  /** Keys (see keyOf) of the products currently chosen. */
  selected: string[];
  keyOf: (product: ProductPublic) => string;
  onToggle: (product: ProductPublic) => void;
  /** Only the catalogue linked to this number. */
  whatsappConfigId?: string;
  /** Only the catalogue of the number this conversation sends from. */
  conversationId?: string;
  disabled?: boolean;
  className?: string;
}) {
  const t = useTranslations("Commerce.catalog.picker");
  const locale = useLocale();
  const [q, setQ] = useState("");
  const [products, setProducts] = useState<ProductPublic[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      fetchProducts({ q, whatsappConfigId, conversationId, limit: 50 })
        .then((page) => {
          if (cancelled) return;
          setProducts(page.products);
          setFailed(false);
        })
        .catch(() => {
          if (cancelled) return;
          setProducts([]);
          setFailed(true);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q, whatsappConfigId, conversationId]);

  return (
    <div className={cn("space-y-2", className)}>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("search")}
          aria-label={t("search")}
          className="pl-8"
        />
      </div>
      <div className="max-h-64 overflow-y-auto rounded-md border border-border" role="listbox" aria-multiselectable="true" aria-label={t("label")}>
        {products === null ? (
          <div className="flex items-center justify-center p-4">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label={t("loading")} />
          </div>
        ) : products.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">{failed ? t("loadError") : q ? t("noMatches") : t("empty")}</p>
        ) : (
          products.map((product) => {
            const key = keyOf(product);
            const isSelected = selected.includes(key);
            const price = productPrice(product, locale);
            return (
              <button
                key={product.id}
                type="button"
                role="option"
                aria-selected={isSelected}
                disabled={disabled && !isSelected}
                onClick={() => onToggle(product)}
                className={cn(
                  "flex w-full items-center gap-3 border-b border-border px-3 py-2 text-left last:border-b-0 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50",
                  isSelected && "bg-primary/10",
                )}
              >
                {product.image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element -- catalogue images are on Meta's CDN, not optimisable here
                  <img src={product.image_url} alt="" className="h-9 w-9 shrink-0 rounded object-cover" loading="lazy" referrerPolicy="no-referrer" />
                ) : (
                  <span className="h-9 w-9 shrink-0 rounded bg-muted" aria-hidden />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-foreground">{product.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {[price, product.retailer_id].filter(Boolean).join(" · ")}
                  </span>
                </span>
                {isSelected && <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden />}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
