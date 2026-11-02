"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";

import { useCan } from "@/hooks/use-can";
import { Button, buttonVariants } from "@/components/ui/button";
import { authFetch } from "@/lib/auth/client";
import type { AttentionEvent, CommerceEventResolution } from "@/lib/commerce/event-attention";

/**
 * Store messages that need an admin: failed sends and sends whose outcome is
 * unknown. The admin checks the chat, then records whether the customer got
 * it. Nothing here sends or re-sends a message. Hidden when there is nothing
 * to do, and for agents and viewers.
 */
export function EventsAttention() {
  const t = useTranslations("Commerce.attention");
  const tReason = useTranslations("Commerce.events.reasons");
  const tSource = useTranslations("Commerce.orders.sources");
  const format = useFormatter();
  const isAdmin = useCan("edit-settings");
  const [events, setEvents] = useState<AttentionEvent[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    authFetch("/api/commerce/events")
      .then(async (res) => {
        const json = (await res.json().catch(() => ({}))) as { events?: AttentionEvent[] };
        if (!cancelled && res.ok && Array.isArray(json.events)) setEvents(json.events);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  if (!isAdmin || events.length === 0) return null;

  const resolve = async (event: AttentionEvent, resolution: CommerceEventResolution) => {
    setBusy(event.id);
    try {
      const res = await authFetch(`/api/commerce/events/${encodeURIComponent(event.id)}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolution }),
      });
      // 409: already resolved elsewhere; drop it from the list either way.
      if (res.ok || res.status === 409) {
        setEvents((list) => list.filter((e) => e.id !== event.id));
        if (res.ok) toast.success(t("resolved"));
      } else toast.error(t("resolveError"));
    } catch {
      toast.error(t("resolveError"));
    } finally {
      setBusy(null);
    }
  };

  const reasonText = (reason: string | null) => (reason && tReason.has(reason) ? tReason(reason) : t("failedGeneric"));

  return (
    <section className="mx-4 mt-4 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 sm:mx-6" aria-labelledby="events-attention-title">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
        <div className="min-w-0">
          <h2 id="events-attention-title" className="text-sm font-semibold">{t("title", { count: events.length })}</h2>
          <p className="text-muted-foreground text-xs">{t("description")}</p>
        </div>
      </div>
      <ul className="mt-3 divide-y">
        {events.map((event) => (
          <li key={event.id} className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 text-sm">
              <p className="font-medium">
                {t(`events.${event.event}`)} · {tSource(event.source)}
                {event.order_number ? ` · ${event.order_number}` : ""}
              </p>
              <p className="text-muted-foreground text-xs">
                {[event.contact_name ?? t("unknownContact"), event.template_name, format.dateTime(new Date(event.created_at), { dateStyle: "medium", timeStyle: "short" })]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              <p className="text-xs">{reasonText(event.reason)}</p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              {event.conversation_id ? (
                <Link href={`/inbox?c=${encodeURIComponent(event.conversation_id)}`} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                  {t("openChat")}
                </Link>
              ) : null}
              <Button size="sm" variant="outline" disabled={busy === event.id} onClick={() => resolve(event, "sent")}>
                {t("markSent")}
              </Button>
              <Button size="sm" variant="outline" disabled={busy === event.id} onClick={() => resolve(event, "not_sent")}>
                {t("markNotSent")}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
