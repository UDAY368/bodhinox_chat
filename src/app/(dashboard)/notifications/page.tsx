"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/data/client";
import { useAuth } from "@/hooks/use-auth";
import type { Notification } from "@/types";
import {
  AlarmClock,
  AtSign,
  Bell,
  CalendarCheck,
  CalendarClock,
  CalendarX,
  CheckCheck,
  CreditCard,
  FileX,
  Loader2,
  Megaphone,
  MessageSquare,
  Smartphone,
  UserPlus,
  Webhook,
  Zap,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { safeNotificationLink } from "@/lib/notifications/link";

// Icon per notification type.
const TYPE_ICON: Record<Notification["type"], typeof Bell> = {
  conversation_assigned: UserPlus,
  whatsapp_number_health: Smartphone,
  instagram_account_health: AtSign,
  payment_received: CreditCard,
  assigned_message: MessageSquare,
  mention: AtSign,
  sla_breach: AlarmClock,
  campaign_finished: Megaphone,
  template_rejected: FileX,
  billing: CreditCard,
  appointment_booked: CalendarCheck,
  appointment_cancelled: CalendarX,
  appointment_rescheduled: CalendarClock,
  automation_notice: Zap,
  webhook_disabled: Webhook,
};

export default function NotificationsPage() {
  const t = useTranslations("Notifications");
  const router = useRouter();
  const { accountId } = useAuth();
  const [notifications, setNotifications] = useState<Notification[] | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);

  const load = useCallback(async () => {
    if (!accountId) return;
    const db = createClient();
    const { data, error: fetchErr } = await db
      .from("notifications")
      .select("*")
      .eq("account_id", accountId)
      .order("created_at", { ascending: false })
      .limit(100);
    if (fetchErr) {
      setError(fetchErr.message);
      return;
    }
    setNotifications((data ?? []) as Notification[]);
  }, [accountId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // Realtime — new assignments appear without a refresh, and a
  // "mark all read" fired from another tab/device stays in sync here.
  useEffect(() => {
    const db = createClient();
    const channel = db
      .channel("notifications-page")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "notifications" },
        (payload) => {
          if (payload.eventType === "INSERT") {
            const row = payload.new as unknown as Notification;
            setNotifications((prev) => {
              if (!prev) return [row];
              if (prev.some((n) => n.id === row.id)) return prev;
              return [row, ...prev];
            });
          } else if (payload.eventType === "UPDATE") {
            const row = payload.new as unknown as Notification;
            setNotifications((prev) =>
              prev?.map((n) => (n.id === row.id ? { ...n, ...row } : n)) ??
              prev,
            );
          } else if (payload.eventType === "DELETE") {
            const oldRow = payload.old as Partial<Notification>;
            setNotifications(
              (prev) => prev?.filter((n) => n.id !== oldRow.id) ?? prev,
            );
          }
        },
      )
      .subscribe();

    return () => {
      db.removeChannel(channel);
    };
  }, []);

  const markRead = useCallback(
    async (id: string) => {
      // Optimistic — the row is already visually "read" by the time the
      // request lands, so the UI doesn't wait on the round-trip.
      setNotifications(
        (prev) =>
          prev?.map((n) =>
            n.id === id && !n.read_at
              ? { ...n, read_at: new Date().toISOString() }
              : n,
          ) ?? prev,
      );
      const db = createClient();
      const { error: updateErr } = await db
        .from("notifications")
        .update({ read_at: new Date().toISOString() })
        .eq("id", id)
        .is("read_at", null);
      if (updateErr) {
        toast.error(t("markReadFailed"));
        load();
      }
    },
    [load, t],
  );

  const handleClick = useCallback(
    (n: Notification) => {
      if (!n.read_at) markRead(n.id);
      // The server-chosen link wins, but only as a same-origin relative path.
      const link = safeNotificationLink(n.link);
      if (link) {
        router.push(link);
      } else if (n.conversation_id) {
        router.push(`/inbox?c=${n.conversation_id}`);
      } else if (n.type === "whatsapp_number_health") {
        // Number health alerts open the WhatsApp numbers settings.
        router.push("/settings?tab=whatsapp");
      } else if (n.type === "instagram_account_health") {
        router.push("/settings?tab=instagram");
      } else if (n.type.startsWith("appointment_")) {
        // Booking alerts carry /appointments?id=<id>; without it, open the schedule.
        router.push("/appointments");
      }
    },
    [markRead, router],
  );

  const unreadIds = notifications?.filter((n) => !n.read_at).map((n) => n.id) ?? [];

  const markAllRead = useCallback(async () => {
    if (unreadIds.length === 0) return;
    setMarkingAll(true);
    const now = new Date().toISOString();
    setNotifications(
      (prev) => prev?.map((n) => (n.read_at ? n : { ...n, read_at: now })) ?? prev,
    );
    const db = createClient();
    const { error: updateErr } = await db
      .from("notifications")
      .update({ read_at: now })
      .is("read_at", null);
    setMarkingAll(false);
    if (updateErr) {
      toast.error(t("markAllFailed"));
      load();
    }
  }, [unreadIds.length, load, t]);

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p className="text-sm text-destructive">{error}</p>
        <Button variant="outline" onClick={() => window.location.reload()}>
          {t("retry")}
        </Button>
      </div>
    );
  }

  if (notifications === null) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[22px] font-bold tracking-tight text-foreground">{t("title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("descriptionAll")}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={unreadIds.length === 0 || markingAll}
          onClick={markAllRead}
        >
          {markingAll ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <CheckCheck className="h-4 w-4" />
          )}
          {t("markAllRead")}
        </Button>
      </div>

      {notifications.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-border bg-card px-4 py-12 text-center">
          <div className="flex size-11 items-center justify-center rounded-xl bg-muted">
            <Bell className="size-5 text-muted-foreground" />
          </div>
          <p className="mt-1 text-sm font-semibold text-foreground">
            {t("emptyTitle")}
          </p>
          <p className="text-sm text-muted-foreground">
            {t("emptyDescAll")}
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {notifications.map((n) => {
            const Icon = TYPE_ICON[n.type] ?? Bell;
            const typeLabel = n.type in TYPE_ICON ? t(`types.${n.type}`) : null;
            const isUnread = !n.read_at;
            return (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => handleClick(n)}
                  className={cn(
                    "flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-muted/60",
                    isUnread && "bg-primary/[0.04]",
                  )}
                >
                  <div
                    className={cn(
                      "flex size-9 flex-shrink-0 items-center justify-center rounded-[10px]",
                      isUnread ? "bg-primary/10" : "bg-muted",
                    )}
                    aria-hidden
                  >
                    <Icon
                      className={cn(
                        "size-[18px]",
                        isUnread ? "text-primary" : "text-muted-foreground",
                      )}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <span
                      className={cn(
                        "block truncate text-sm",
                        isUnread ? "font-semibold text-foreground" : "font-medium text-foreground/80",
                      )}
                    >
                      {n.title}
                    </span>
                    {n.body && (
                      <p className="mt-0.5 truncate text-[13px] text-muted-foreground">
                        {n.body}
                      </p>
                    )}
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {typeLabel && (
                        <span data-notification-type={n.type}>
                          {typeLabel} ·{" "}
                        </span>
                      )}
                      <span className="tabular-nums">
                        {formatDistanceToNow(new Date(n.created_at), {
                          addSuffix: true,
                        })}
                      </span>
                    </p>
                  </div>
                  {isUnread && (
                    <span
                      aria-label={t("unread")}
                      className="size-2 flex-shrink-0 rounded-full bg-primary"
                    />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
