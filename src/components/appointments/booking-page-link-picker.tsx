"use client";

/**
 * Campaign link destination (batch 3, B11): pick one of the workspace's
 * active booking pages as a tracked campaign's destination. The campaign
 * still stores only an HTTPS URL (validTrackedUrl), so the /r/<token>
 * redirect and click recording are unchanged. Renders nothing when
 * appointments are off or the list cannot load.
 */
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { authFetch } from "@/lib/auth/client";

/** Same shape as booking-pages-panel's bookingLink (not imported: that pulls the whole panel into the campaign page). */
const bookingLink = (origin: string, slug: string) => `${origin.replace(/\/+$/, "")}/book/${slug}`;

interface PageRow { id: string; slug: string; title: string; active: boolean }

export function BookingPageLinkPicker({ value, onPick }: { value: string; onPick: (url: string) => void }) {
  const t = useTranslations("Appointments.campaignLink");
  const [pages, setPages] = useState<PageRow[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch("/api/appointments/booking-pages", { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as { pages?: PageRow[] };
        if (!cancelled) setPages((body.pages ?? []).filter((p) => p.active && typeof p.slug === "string"));
      } catch {
        // Leave the picker hidden; the URL field still works.
      }
    })();
    return () => { cancelled = true; };
  }, []);
  if (!pages) return null;
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const selected = pages.find((p) => bookingLink(origin, p.slug) === value.trim());
  return (
    <div className="space-y-1.5 pt-2">
      <label htmlFor="tracked-booking-page" className="block text-sm font-medium text-foreground">{t("label")}</label>
      {pages.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("none")}</p>
      ) : (
        <Select value={selected?.id ?? ""} onValueChange={(id) => {
          const page = pages.find((p) => p.id === id);
          if (page) onPick(bookingLink(origin, page.slug));
        }}>
          <SelectTrigger id="tracked-booking-page" className="min-h-11 w-full bg-muted"><SelectValue placeholder={t("label")} /></SelectTrigger>
          <SelectContent>
            {pages.map((p) => <SelectItem key={p.id} value={p.id}>{p.title}</SelectItem>)}
          </SelectContent>
        </Select>
      )}
      <p className="text-xs text-muted-foreground">{t("help")}</p>
    </div>
  );
}
