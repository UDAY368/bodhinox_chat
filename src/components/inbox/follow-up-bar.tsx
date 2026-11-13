"use client";

import { useCallback, useEffect, useState } from "react";
import { BellRing, CalendarClock, Clock, Loader2, X } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { toast } from "sonner";
import { authFetch } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  CONVERSATION_REMINDER_LIMITS,
  type Channel,
  type ConversationReminder,
  type ConversationReminderKind,
  type ScheduledReply,
} from "@/types";

/** Fired when the member's snoozes change, so the inbox list can hide or show the conversation. */
export const SNOOZES_CHANGED_EVENT = "inbox:snoozes-changed";

/** A datetime-local value (the browser's own zone) for a date. */
export function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export type ReminderPreset = "oneHour" | "threeHours" | "tomorrow" | "nextWeek";

/** The time a preset means from `now`; "tomorrow morning" and "next week" are 09:00 local. */
export function presetTime(preset: ReminderPreset, now: Date = new Date()): Date {
  const at = new Date(now);
  if (preset === "oneHour") return new Date(now.getTime() + 60 * 60_000);
  if (preset === "threeHours") return new Date(now.getTime() + 3 * 60 * 60_000);
  at.setDate(at.getDate() + (preset === "tomorrow" ? 1 : 7));
  at.setHours(9, 0, 0, 0);
  return at;
}

/** A server error code as the key under Inbox.reminders.errors / Inbox.scheduled.errors. */
export function errorKey(code: unknown, known: readonly string[]): string {
  return typeof code === "string" && known.includes(code) ? code : "failed";
}
const REMINDER_ERRORS = ["past", "tooFar", "notFound", "forbidden"] as const;
const SCHEDULED_ERRORS = [
  "past", "tooFarWhatsapp", "tooFarInstagram", "windowClosed", "humanAgentOff", "empty",
  "tooLongInstagram", "tooLong", "notFound", "notPending", "forbidden",
] as const;

interface FollowUpBarProps {
  conversationId: string;
  channel: Channel;
  /** The composer's current text, offered as the scheduled reply. */
  draftText: string;
  /** A viewer can read what is queued but create nothing. */
  readOnly: boolean;
  /** No window to send in now (the composer is disabled): scheduling waits for a customer message. */
  scheduleDisabled: boolean;
  /** The reply was stored as scheduled: the composer clears its text. */
  onScheduled: () => void;
  /** More composer tools on the same row (pause automations, typing hints). */
  trailing?: React.ReactNode;
  /** The thread shows reminders in its own banner (ReminderBanner); the bar then lists scheduled replies only. */
  hideReminders?: boolean;
}

/**
 * Reminders, snooze and scheduled replies for one conversation. The server
 * decides everything (role, channel, window); this only collects the time and
 * shows what is queued.
 */
export function FollowUpBar({ conversationId, channel, draftText, readOnly, scheduleDisabled, onScheduled, trailing, hideReminders = false }: FollowUpBarProps) {
  const t = useTranslations("Inbox.reminders");
  const ts = useTranslations("Inbox.scheduled");
  const format = useFormatter();
  const [reminders, setReminders] = useState<ConversationReminder[]>([]);
  const [scheduled, setScheduled] = useState<ScheduledReply[]>([]);
  const [reminderOpen, setReminderOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [when, setWhen] = useState("");
  const [busy, setBusy] = useState(false);

  const when_ = useCallback(
    (iso: string) => format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" }),
    [format],
  );

  const load = useCallback(async () => {
    try {
      const [r, s] = await Promise.all([
        authFetch(`/api/inbox/reminders?conversation_id=${conversationId}`),
        authFetch(`/api/inbox/scheduled-replies?conversation_id=${conversationId}`),
      ]);
      if (r.ok) setReminders(((await r.json()) as { reminders: ConversationReminder[] }).reminders);
      if (s.ok) setScheduled(((await s.json()) as { scheduled_replies: ScheduledReply[] }).scheduled_replies);
    } catch {
      // The bar is an extra: a failed read shows nothing rather than an error over the thread.
    }
  }, [conversationId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 60_000);
    // A reminder set from the thread header shows here straight away.
    const onChange = () => void load();
    window.addEventListener(SNOOZES_CHANGED_EVENT, onChange);
    return () => {
      clearInterval(timer);
      window.removeEventListener(SNOOZES_CHANGED_EVENT, onChange);
    };
  }, [load]);

  const send = async (url: string, method: "POST" | "PATCH", body: unknown, errors: readonly string[], scope: "reminders" | "scheduled") => {
    setBusy(true);
    try {
      const res = await authFetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (res.ok) return true;
      const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
      const key = errorKey(data?.error, errors);
      toast.error(scope === "reminders" ? t(`errors.${key}` as never) : ts(`errors.${key}` as never));
      return false;
    } catch {
      toast.error(scope === "reminders" ? t("errors.failed") : ts("errors.failed"));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveSchedule = async () => {
    const at = new Date(when);
    if (!when || Number.isNaN(at.getTime())) return;
    const ok = await send("/api/inbox/scheduled-replies", "POST", {
      conversation_id: conversationId, content: draftText, send_at: at.toISOString(),
    }, SCHEDULED_ERRORS, "scheduled");
    if (!ok) return;
    setScheduleOpen(false);
    onScheduled();
    await load();
  };

  const patchReminder = async (id: string, body: unknown) => {
    if (await send(`/api/inbox/reminders/${id}`, "PATCH", body, REMINDER_ERRORS, "reminders")) {
      await load();
      window.dispatchEvent(new Event(SNOOZES_CHANGED_EVENT));
    }
  };
  const patchScheduled = async (id: string, body: unknown) => {
    if (await send(`/api/inbox/scheduled-replies/${id}`, "PATCH", body, SCHEDULED_ERRORS, "scheduled")) await load();
  };

  const openReminder = () => setReminderOpen(true);
  const openSchedule = () => { setWhen(toLocalInput(presetTime("oneHour"))); setScheduleOpen(true); };

  const visibleReminders = hideReminders ? [] : reminders.filter((r) => r.status === "pending" || r.status === "fired");
  const hasItems = visibleReminders.length > 0 || scheduled.length > 0;

  return (
    <div className="pb-1" data-follow-up-bar>
      <div className="flex min-w-0 items-center gap-1">
        {!hideReminders && (
          <Button type="button" variant="ghost" size="sm" disabled={readOnly} onClick={openReminder}
            className="text-muted-foreground hover:text-foreground h-7 gap-1 px-2 text-xs">
            <BellRing className="h-3.5 w-3.5" aria-hidden />
            {t("add")}
          </Button>
        )}
        <Button type="button" variant="ghost" size="sm" disabled={readOnly || scheduleDisabled || !draftText.trim()} onClick={openSchedule}
          title={draftText.trim() ? undefined : ts("errors.empty")}
          className="text-muted-foreground hover:text-foreground h-7 gap-1 px-2 text-xs">
          <CalendarClock className="h-3.5 w-3.5" aria-hidden />
          {ts("schedule")}
        </Button>
        {trailing}
      </div>

      {hasItems && (
        <ul className="mb-1 space-y-1">
          {visibleReminders.map((r) => (
            <li key={r.id} className="bg-muted/50 flex items-center gap-2 rounded-md px-2 py-1 text-xs">
              <Clock className="text-muted-foreground h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate">
                {r.status === "fired"
                  ? t("due")
                  : r.kind === "snooze"
                    ? t("snoozedUntil", { when: when_(r.remind_at) })
                    : t("reminderAt", { when: when_(r.remind_at) })}
                {r.note ? ` · ${r.note}` : ""}
              </span>
              <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs"
                onClick={() => void patchReminder(r.id, { status: r.status === "fired" ? "dismissed" : "cancelled" })}>
                {r.status === "fired" ? t("dismiss") : r.kind === "snooze" ? t("wake") : t("cancel")}
              </Button>
            </li>
          ))}
          {scheduled.map((s) => (
            <li key={s.id} className="bg-muted/50 rounded-md px-2 py-1 text-xs">
              <div className="flex items-center gap-2">
                <CalendarClock className="text-muted-foreground h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1 truncate">
                  {ts(`status.${s.status}` as never)} · {when_(s.send_at)} · {s.content}
                </span>
                {s.status === "pending" && (
                  <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs"
                    onClick={() => void patchScheduled(s.id, { status: "cancelled" })}>
                    <X className="mr-1 h-3 w-3" aria-hidden />
                    {ts("cancel")}
                  </Button>
                )}
              </div>
              {(s.status === "skipped" || s.status === "failed") && s.reason_code && (
                <p className="text-muted-foreground mt-0.5 pl-5">{ts(`reason.${s.reason_code}` as never)}</p>
              )}
              {s.status === "unknown" && (
                <div className="mt-1 pl-5">
                  <p className="font-medium">{ts("reconcile.title")}</p>
                  <p className="text-muted-foreground">{ts("reconcile.body")}</p>
                  <div className="mt-1 flex gap-1">
                    <Button type="button" variant="outline" size="sm" className="h-6 px-2 text-xs"
                      onClick={() => void patchScheduled(s.id, { reconcile: "sent" })}>{ts("reconcile.markSent")}</Button>
                    <Button type="button" variant="outline" size="sm" className="h-6 px-2 text-xs"
                      onClick={() => void patchScheduled(s.id, { reconcile: "failed" })}>{ts("reconcile.markFailed")}</Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <ReminderDialog conversationId={conversationId} open={reminderOpen} onOpenChange={setReminderOpen} />

      <Dialog open={scheduleOpen} onOpenChange={setScheduleOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>{ts("schedule")}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="bg-muted/50 max-h-32 overflow-y-auto rounded-md p-2 text-sm whitespace-pre-wrap">{draftText}</p>
            <label className="block text-xs font-medium">
              {ts("sendAt")}
              <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="mt-1" />
            </label>
            <p className="text-muted-foreground text-xs">{channel === "instagram" ? ts("hintInstagram") : ts("hintWhatsapp")}</p>
          </div>
          <DialogFooter>
            <Button type="button" disabled={busy || !when || !draftText.trim()} onClick={() => void saveSchedule()}>
              {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />}
              {ts("confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface ReminderDialogProps {
  conversationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Change this pending reminder (its time and note) instead of adding one. */
  reminder?: Pick<ConversationReminder, "id" | "remind_at" | "note"> | null;
}

/** Set a reminder or snooze for one conversation. Opened from the follow-up bar and the thread header's bell. */
export function ReminderDialog({ conversationId, open, onOpenChange, reminder = null }: ReminderDialogProps) {
  const t = useTranslations("Inbox.reminders");
  const [when, setWhen] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  // Each opening starts an hour from now with an empty note.
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const openKey = open ? `${conversationId}:${reminder?.id ?? ""}` : null;
  if (openKey !== openedFor) {
    setOpenedFor(openKey);
    if (openKey) {
      setWhen(toLocalInput(reminder ? new Date(reminder.remind_at) : presetTime("oneHour")));
      setNote(reminder?.note ?? "");
    }
  }

  const save = async (kind: ConversationReminderKind) => {
    const at = new Date(when);
    if (!when || Number.isNaN(at.getTime()) || busy) return;
    setBusy(true);
    try {
      const res = reminder
        ? await authFetch(`/api/inbox/reminders/${encodeURIComponent(reminder.id)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ remind_at: at.toISOString(), note: note.trim() }),
          })
        : await authFetch("/api/inbox/reminders", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ conversation_id: conversationId, kind, remind_at: at.toISOString(), note: note.trim() || undefined }),
          });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
        toast.error(t(`errors.${errorKey(data?.error, REMINDER_ERRORS)}` as never));
        return;
      }
      onOpenChange(false);
      window.dispatchEvent(new Event(SNOOZES_CHANGED_EVENT));
    } catch {
      toast.error(t("errors.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>{reminder ? t("changeTitle") : t("title")}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="flex flex-wrap gap-1">
            {(["oneHour", "threeHours", "tomorrow", "nextWeek"] as const).map((p) => (
              <Button key={p} type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={() => setWhen(toLocalInput(presetTime(p)))}>
                {t(`presets.${p}`)}
              </Button>
            ))}
          </div>
          <label className="block text-xs font-medium">
            {t("remindAt")}
            <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="mt-1" />
          </label>
          <label className="block text-xs font-medium">
            {t("note")}
            <Textarea value={note} maxLength={CONVERSATION_REMINDER_LIMITS.noteChars} placeholder={t("notePlaceholder")}
              onChange={(e) => setNote(e.target.value)} className="mt-1" />
          </label>
          {!reminder && <p className="text-muted-foreground text-xs">{t("snoozeHelp")}</p>}
        </div>
        <DialogFooter className="gap-2 sm:gap-2">
          {!reminder && (
            <Button type="button" variant="outline" disabled={busy || !when} onClick={() => void save("snooze")}>{t("snooze")}</Button>
          )}
          <Button type="button" disabled={busy || !when} onClick={() => void save("reminder")}>
            {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />}
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The thread's follow-up banner (top of the chat): the member's due or next
 * reminder on this conversation, with Done and Change; a snooze shows with
 * Wake. Reads /api/inbox/reminders and follows SNOOZES_CHANGED_EVENT.
 */
export function ReminderBanner({ conversationId, readOnly }: { conversationId: string; readOnly: boolean }) {
  const t = useTranslations("Inbox.reminders");
  const format = useFormatter();
  const [reminders, setReminders] = useState<ConversationReminder[]>([]);
  const [changing, setChanging] = useState<ConversationReminder | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await authFetch(`/api/inbox/reminders?conversation_id=${encodeURIComponent(conversationId)}`);
      if (res.ok) setReminders(((await res.json()) as { reminders: ConversationReminder[] }).reminders);
    } catch {
      // Advisory: nothing shows when the read fails.
    }
  }, [conversationId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 60_000);
    const onChange = () => void load();
    window.addEventListener(SNOOZES_CHANGED_EVENT, onChange);
    return () => {
      clearInterval(timer);
      window.removeEventListener(SNOOZES_CHANGED_EVENT, onChange);
    };
  }, [load]);

  const visible = reminders
    .filter((r) => r.conversation_id === conversationId && (r.status === "pending" || r.status === "fired"))
    .sort((a, b) => (a.status === "fired" ? -1 : b.status === "fired" ? 1 : Date.parse(a.remind_at) - Date.parse(b.remind_at)));
  const current = visible[0];
  if (!current) return null;

  const when = format.dateTime(new Date(current.remind_at), { dateStyle: "medium", timeStyle: "short" });
  const done = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await authFetch(`/api/inbox/reminders/${encodeURIComponent(current.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: current.status === "fired" ? "dismissed" : "cancelled" }),
      });
      if (!res.ok) {
        toast.error(t("errors.failed"));
        return;
      }
      toast.success(current.kind === "snooze" ? t("woken") : t("cleared"));
      window.dispatchEvent(new Event(SNOOZES_CHANGED_EVENT));
      await load();
    } catch {
      toast.error(t("errors.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div role="status" data-reminder-banner className="border-border bg-muted/50 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b px-3 py-2 text-[13px] @md:px-4">
      <BellRing className="text-primary h-4 w-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 basis-40">
        <strong className="text-foreground font-semibold">
          {current.status === "fired" ? t("due") : current.kind === "snooze" ? t("snoozedUntil", { when }) : t("followUp", { when })}
        </strong>
        {current.note ? <span className="text-muted-foreground"> · {current.note}</span> : null}
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        <Button type="button" variant="outline" size="sm" className="h-7 px-2.5 text-xs" disabled={busy || readOnly} onClick={() => void done()}>
          {current.status === "fired" ? t("dismiss") : current.kind === "snooze" ? t("wake") : t("done")}
        </Button>
        {current.kind === "reminder" && current.status === "pending" && (
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2.5 text-xs" disabled={readOnly} onClick={() => setChanging(current)}>
            {t("change")}
          </Button>
        )}
      </span>
      <ReminderDialog
        conversationId={conversationId}
        open={changing !== null}
        onOpenChange={(open) => !open && setChanging(null)}
        reminder={changing}
      />
    </div>
  );
}
