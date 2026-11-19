"use client";

/**
 * Commerce → Settings → Marketing → Link page (store plan Phase 8, batch 6): the shop's link-in-bio page at /s/<handle>/links. A short
 * bio, up to 12 links (plain http or https addresses, in the order shown) and up to 6 featured products. Admins edit; agents read.
 * The page follows the shop's theme and its password or coming-soon lock.
 */
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { authFetch } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cleanLinkUrl, LINK_PAGE_LIMITS, type PageLink } from "@/lib/commerce/link-page-limits";
import type { LinkPageView } from "@/lib/commerce/link-page";

export function LinkPageCard({ canEdit }: { canEdit: boolean }) {
  const t = useTranslations("Commerce.settings.marketing.linkPage");
  const te = useTranslations("Commerce.settings.errors");
  const [page, setPage] = useState<LinkPageView | null>(null);
  const [products, setProducts] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    authFetch("/api/commerce/link-page", { cache: "no-store" }).then(async (res) => { if (res.ok) setPage(((await res.json()) as { page: LinkPageView }).page); }).catch(() => undefined);
    authFetch("/api/commerce/shop/products?status=published&limit=100", { cache: "no-store" })
      .then(async (res) => { if (res.ok) setProducts(((await res.json()) as { products: { id: string; name: string }[] }).products); }).catch(() => undefined);
  }, []);
  if (!page) return null;
  const set = (patch: Partial<LinkPageView>) => setPage({ ...page, ...patch });
  const setLink = (i: number, patch: Partial<PageLink>) => set({ links: page.links.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const linksOk = page.links.every((l) => l.label.trim() && cleanLinkUrl(l.url));

  const save = async () => {
    setBusy(true);
    const res = await authFetch("/api/commerce/link-page", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: page.enabled, bio: page.bio, links: page.links, featured_product_ids: page.featured_product_ids }),
    }).catch(() => null);
    setBusy(false);
    const data = (await res?.json().catch(() => ({}))) as { page?: LinkPageView; code?: string };
    if (!res?.ok || !data.page) { toast.error(data.code && te.has(data.code as never) ? te(data.code as never) : te("invalid")); return; }
    setPage(data.page);
    toast.success(t("saved"));
  };

  return (
    <Card id="link-page">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("hint")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-start gap-2">
          <Checkbox id="lp-enabled" checked={page.enabled} disabled={!canEdit} onCheckedChange={(v) => set({ enabled: v === true })} />
          <Label htmlFor="lp-enabled" className="text-sm font-medium leading-snug">{t("enabled")}</Label>
        </div>
        {page.url && <p className="text-xs text-muted-foreground">{t("address")} <a className="underline" href={page.url} target="_blank" rel="noopener noreferrer">{page.url}</a></p>}
        <div className="space-y-1">
          <Label htmlFor="lp-bio">{t("bio")}</Label>
          <Textarea id="lp-bio" rows={3} maxLength={LINK_PAGE_LIMITS.bio} disabled={!canEdit} value={page.bio ?? ""} onChange={(e) => set({ bio: e.target.value || null })} />
        </div>
        <div className="space-y-2">
          <h3 className="text-sm font-medium">{t("links")}</h3>
          {page.links.map((l, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
              <Input aria-label={t("linkLabel")} maxLength={LINK_PAGE_LIMITS.label} disabled={!canEdit} value={l.label} onChange={(e) => setLink(i, { label: e.target.value })} />
              <Input aria-label={t("linkUrl")} inputMode="url" maxLength={LINK_PAGE_LIMITS.url} disabled={!canEdit} value={l.url} placeholder="https://"
                aria-invalid={l.url !== "" && !cleanLinkUrl(l.url)} onChange={(e) => setLink(i, { url: e.target.value })} />
              {canEdit && <Button type="button" variant="ghost" size="sm" aria-label={t("removeLink")} onClick={() => set({ links: page.links.filter((_, j) => j !== i) })}><Trash2 className="size-4" /></Button>}
            </div>
          ))}
          {canEdit && (
            <Button type="button" variant="outline" size="sm" disabled={page.links.length >= LINK_PAGE_LIMITS.links}
              onClick={() => set({ links: [...page.links, { label: "", url: "" }] })}><Plus className="size-4" />{t("addLink")}</Button>
          )}
          {!linksOk && <p className="text-xs text-red-700">{t("linkInvalid")}</p>}
        </div>
        <div className="space-y-2">
          <h3 className="text-sm font-medium">{t("featured", { max: LINK_PAGE_LIMITS.featured })}</h3>
          <div className="flex flex-wrap gap-1">
            {products.map((p) => {
              const on = page.featured_product_ids.includes(p.id);
              const full = !on && page.featured_product_ids.length >= LINK_PAGE_LIMITS.featured;
              return (
                <button key={p.id} type="button" aria-pressed={on} disabled={!canEdit || full}
                  onClick={() => set({ featured_product_ids: on ? page.featured_product_ids.filter((id) => id !== p.id) : [...page.featured_product_ids, p.id] })}
                  className={`rounded-full border px-2 py-0.5 text-xs disabled:opacity-50 ${on ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground"}`}>
                  {p.name}
                </button>
              );
            })}
            {products.length === 0 && <span className="text-xs text-muted-foreground">{t("noProducts")}</span>}
          </div>
        </div>
        {canEdit && (
          <Button onClick={save} disabled={busy || !linksOk}>
            {busy && <Loader2 className="size-4 animate-spin" />}{t("save")}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
