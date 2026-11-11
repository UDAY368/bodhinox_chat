"use client";

// The contact sidebar's "Chat history" section: who this conversation was
// assigned to, by whom, who resolved it and when it reopened, newest first
// (GET /api/conversations/{id}/handling). Shown to every member who can see
// the chat; it reloads when the conversation or the sidebar's refresh token
// changes, so an assignment made in the thread appears here.

import { useEffect, useState } from "react";
import { format } from "date-fns";
import { CheckCircle2, RotateCcw, UserMinus, UserPlus } from "lucide-react";
import { useTranslations } from "next-intl";

import { authFetch } from "@/lib/auth/client";
import type { HandlingEvent } from "@/lib/inbox/handling-history";
import { cn } from "@/lib/utils";

const ICON = { assigned: UserPlus, unassigned: UserMinus, resolved: CheckCircle2, reopened: RotateCcw } as const;
/** How many events show before "Show all". */
const COLLAPSED = 5;

/** The sentence for one event, from its kind and who was involved (pure, unit-tested). */
export function handlingSentence(
  event: HandlingEvent,
  t: (key: string, values?: Record<string, string>) => string,
): string {
  const name = (p: HandlingEvent["to"]) => (p ? (p.name ?? t("formerMember")) : "");
  const by = event.actor ? name(event.actor) : null;
  switch (event.kind) {
    case "assigned":
      if (event.actor && event.to && event.actor.id === event.to.id) return t("tookIt", { to: name(event.to) });
      return by ? t("assignedBy", { to: name(event.to), by }) : t("assignedAuto", { to: name(event.to) });
    case "unassigned":
      return by ? t("unassignedBy", { from: name(event.from), by }) : t("unassignedAuto", { from: name(event.from) });
    case "resolved":
      return by ? t("resolvedBy", { by }) : t("resolvedAuto");
    case "reopened":
      return by ? t("reopenedBy", { by }) : t("reopenedAuto");
  }
}

export function HandlingHistory({ conversationId, refreshToken, className }: {
  conversationId: string;
  refreshToken?: string | number;
  className?: string;
}) {
  const t = useTranslations("Inbox.history");
  // Keyed by the conversation it was read for, so switching chats never shows the previous chat's history.
  const [loaded, setLoaded] = useState<{ conversationId: string; events: HandlingEvent[] | null } | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    authFetch(`/api/conversations/${encodeURIComponent(conversationId)}/handling`, { cache: "no-store" })
      .then(async (res) => {
        const json = (await res.json().catch(() => null)) as { events?: HandlingEvent[] } | null;
        if (cancelled) return;
        setLoaded({ conversationId, events: res.ok && Array.isArray(json?.events) ? json.events : null });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ conversationId, events: null });
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, refreshToken]);

  const current = loaded?.conversationId === conversationId ? loaded : null;
  const events = current?.events ?? null;
  const failed = current !== null && current.events === null;

  const shown = events ? (showAll ? events : events.slice(0, COLLAPSED)) : [];
  return (
    <section className={className} aria-labelledby={`handling-${conversationId}`}>
      <h3 id={`handling-${conversationId}`} className="text-xs font-semibold uppercase">{t("title")}</h3>
      {failed ? (
        <p className="text-muted-foreground mt-2 text-xs">{t("loadFailed")}</p>
      ) : events === null ? (
        <p className="text-muted-foreground mt-2 text-xs" role="status">{t("loading")}</p>
      ) : events.length === 0 ? (
        <p className="text-muted-foreground mt-2 text-xs">{t("empty")}</p>
      ) : (
        <>
          <ol className="mt-2 space-y-2">
            {shown.map((event) => {
              const Icon = ICON[event.kind];
              return (
                <li key={event.id} className="flex gap-2 text-xs" data-handling={event.kind}>
                  <Icon className={cn("mt-0.5 size-3.5 shrink-0", event.kind === "resolved" ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")} aria-hidden />
                  <div className="min-w-0">
                    <p className="text-foreground break-words">{handlingSentence(event, t)}</p>
                    <time dateTime={event.at} className="text-muted-foreground text-[11px]">{format(new Date(event.at), "d MMM, HH:mm")}</time>
                  </div>
                </li>
              );
            })}
          </ol>
          {events.length > COLLAPSED && (
            <button type="button" onClick={() => setShowAll((v) => !v)} className="text-primary mt-2 text-xs font-medium hover:underline">
              {showAll ? t("showLess") : t("showAll", { count: String(events.length) })}
            </button>
          )}
        </>
      )}
    </section>
  );
}
