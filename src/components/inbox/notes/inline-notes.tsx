"use client";

/**
 * Internal notes inside the thread (the composer's Note tab): yellow bubbles
 * among the messages, never sent to the contact. Same notes and routes as the
 * notes panel (/api/conversations/{id}/notes); the author, or an admin, can
 * delete one. Re-reads when a conversation_notes event bumps `revision`.
 */
import { useCallback, useEffect, useState } from "react";
import { StickyNote, Trash2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { toast } from "sonner";

import { authFetch } from "@/lib/auth/client";
import { splitMentions } from "./mentions";
import type { ConversationNoteView } from "./notes-panel";

async function errorMessage(response: Response, fallback: string): Promise<string> {
  const data = await response.json().catch(() => null);
  return typeof data?.error === "string" ? data.error : fallback;
}

export function useThreadNotes(conversationId: string | null | undefined, revision: number) {
  const t = useTranslations("Inbox.notes");
  const [loaded, setLoaded] = useState<{ id: string; notes: ConversationNoteView[] } | null>(null);
  const base = conversationId ? `/api/conversations/${encodeURIComponent(conversationId)}/notes` : null;

  useEffect(() => {
    if (!base || !conversationId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await authFetch(base, { signal: controller.signal, cache: "no-store" });
        if (!response.ok) return;
        const data = (await response.json()) as { notes?: ConversationNoteView[] };
        if (!controller.signal.aborted) setLoaded({ id: conversationId, notes: Array.isArray(data.notes) ? data.notes : [] });
      } catch {
        // Notes are an extra in the thread: a failed read shows none.
      }
    })();
    return () => controller.abort();
  }, [base, conversationId, revision]);

  const notes = loaded && loaded.id === conversationId ? loaded.notes : [];

  const add = useCallback(async (body: string) => {
    if (!base || !conversationId) return false;
    try {
      const response = await authFetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body, mentions: [] }),
      });
      if (!response.ok) {
        toast.error(await errorMessage(response, t("saveFailed")));
        return false;
      }
      const { note } = (await response.json()) as { note: ConversationNoteView };
      setLoaded((prev) => ({ id: conversationId, notes: [...(prev?.id === conversationId ? prev.notes : []).filter((n) => n.id !== note.id), note] }));
      toast.success(t("added"));
      return true;
    } catch {
      toast.error(t("saveFailed"));
      return false;
    }
  }, [base, conversationId, t]);

  const remove = useCallback(async (id: string) => {
    if (!base || !conversationId) return;
    if (!window.confirm(t("deleteConfirm"))) return;
    try {
      const response = await authFetch(`${base}/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) {
        toast.error(await errorMessage(response, t("deleteFailed")));
        return;
      }
      setLoaded((prev) => (prev && prev.id === conversationId ? { id: conversationId, notes: prev.notes.filter((n) => n.id !== id) } : prev));
      toast.success(t("deleted"));
    } catch {
      toast.error(t("deleteFailed"));
    }
  }, [base, conversationId, t]);

  return { notes, add, remove };
}

export function InlineNote({
  note,
  authorName,
  memberNames,
  canDelete,
  onDelete,
}: {
  note: ConversationNoteView;
  authorName: string;
  /** Member names, so @mentions show in bold. */
  memberNames: string[];
  canDelete: boolean;
  onDelete: () => void;
}) {
  const t = useTranslations("Inbox.notes");
  const format = useFormatter();
  const time = format.dateTime(new Date(note.created_at), { hour: "numeric", minute: "2-digit" });
  return (
    <div data-inline-note={note.id} className="group/note flex w-full justify-end">
      <div className="relative min-w-0 max-w-[85%] @xl:max-w-[min(65%,40rem)]">
        <div className="studio-note rounded-[18px] rounded-br-md px-3 py-2 text-sm leading-relaxed">
          <p className="mb-0.5 flex items-center gap-1 text-[11px] font-semibold opacity-80">
            <StickyNote className="size-3" aria-hidden />
            {t("internalNote")}
          </p>
          <p className="break-words whitespace-pre-wrap">
            {splitMentions(note.body, memberNames).map((part, i) =>
              part.mention ? (
                <span key={i} className="font-semibold">{part.text}</span>
              ) : (
                <span key={i}>{part.text}</span>
              )
            )}
          </p>
        </div>
        <p className="text-muted-foreground mt-0.5 flex items-center justify-end gap-1 px-1 text-[11px]">
          <span className="truncate">{authorName} · {time}</span>
          {canDelete && (
            <button
              type="button"
              onClick={onDelete}
              aria-label={t("delete")}
              title={t("delete")}
              className="hover:bg-muted hover:text-foreground inline-flex size-6 items-center justify-center rounded-full opacity-100 transition-opacity focus-visible:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/note:opacity-100"
            >
              <Trash2 className="size-3.5" aria-hidden />
            </button>
          )}
        </p>
      </div>
    </div>
  );
}
