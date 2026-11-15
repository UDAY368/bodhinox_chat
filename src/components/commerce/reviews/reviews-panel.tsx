"use client";

/**
 * Commerce -> Reviews (store plan Phase 3): the ratings buyers gave on WhatsApp after
 * delivery. A new review is pending; an admin publishes it to the public product page or
 * hides it. Agents read. The list holds the buyer's first-name initial only.
 */
import { useCallback, useEffect, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { useCan } from "@/hooks/use-can";
import { authFetch } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { ReviewView } from "@/lib/commerce/review-data";
import type { ReviewStatus } from "@/lib/commerce/reviews";

const FILTERS = ["all", "pending", "published", "hidden"] as const;
type Filter = (typeof FILTERS)[number];

interface Page { reviews: ReviewView[]; next: string | null }

async function load(status: Filter, before: string | null): Promise<Page | null> {
  const params = new URLSearchParams();
  if (status !== "all") params.set("status", status);
  if (before) params.set("before", before);
  const res = await authFetch(`/api/commerce/reviews?${params}`, { cache: "no-store" });
  const json = (await res.json().catch(() => null)) as Page | null;
  return res.ok && json && Array.isArray(json.reviews) ? json : null;
}

export function ReviewsPanel() {
  const t = useTranslations("Commerce.reviews");
  const format = useFormatter();
  const canModerate = useCan("edit-settings");
  const [filter, setFilter] = useState<Filter>("pending");
  const [reviews, setReviews] = useState<ReviewView[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async (status: Filter) => {
    setLoading(true);
    setFailed(false);
    try {
      const page = await load(status, null);
      if (page) { setReviews(page.reviews); setNext(page.next); } else setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void reload(filter); }, [filter, reload]);

  async function more() {
    if (!next) return;
    setLoading(true);
    try {
      const page = await load(filter, next);
      if (page) { setReviews((r) => [...r, ...page.reviews]); setNext(page.next); } else setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }

  async function moderate(id: string, status: Exclude<ReviewStatus, "pending">) {
    setBusy(id);
    try {
      const res = await authFetch(`/api/commerce/reviews/${encodeURIComponent(id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }),
      });
      if (!res.ok) return void toast.error(t("saveError"));
      toast.success(t(status === "published" ? "published" : "hidden"));
      await reload(filter);
    } catch {
      toast.error(t("saveError"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5">
      <div>
        <h1 className="text-[22px] font-bold tracking-tight text-foreground">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label={t("filter")}>
        {FILTERS.map((f) => (
          <Button key={f} size="sm" variant={filter === f ? "default" : "outline"} aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {t(`filters.${f}`)}
          </Button>
        ))}
      </div>
      {failed && <p className="text-sm text-destructive" role="alert">{t("loadError")}</p>}
      {loading && <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label={t("loading")} />}
      {!loading && !failed && reviews.length === 0 && <p className="text-sm text-muted-foreground">{t("empty")}</p>}
      <ul className="space-y-3">
        {reviews.map((r) => (
          <li key={r.id}>
            <Card>
              <CardContent className="flex flex-col gap-2 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">{r.product_name}</p>
                  <span className="rounded-full border px-2 py-0.5 text-xs">{t(`status.${r.status}`)}</span>
                </div>
                <p className="flex items-center gap-2 text-sm">
                  <span aria-label={t("stars", { rating: r.rating })} role="img" className="text-amber-500">{"★".repeat(r.rating)}{"☆".repeat(5 - r.rating)}</span>
                  <span className="text-xs text-muted-foreground">
                    {r.reviewer ?? t("customer")} · {format.dateTime(new Date(r.created_at), { dateStyle: "medium" })}
                  </span>
                </p>
                {r.body ? <p className="whitespace-pre-line break-words text-sm">{r.body}</p> : <p className="text-sm text-muted-foreground">{t("noText")}</p>}
                {canModerate && (
                  <div className="flex gap-2">
                    {r.status !== "published" && (
                      <Button size="sm" disabled={busy === r.id} onClick={() => void moderate(r.id, "published")}>{t("publish")}</Button>
                    )}
                    {r.status !== "hidden" && (
                      <Button size="sm" variant="outline" disabled={busy === r.id} onClick={() => void moderate(r.id, "hidden")}>{t("hide")}</Button>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
      {next && !loading && <Button variant="outline" onClick={() => void more()}>{t("loadMore")}</Button>}
    </div>
  );
}
