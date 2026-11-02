"use client";

/**
 * Internal notes for one conversation: visible to every member, never sent
 * to the contact. Agents and above add notes and @mention teammates (each
 * mentioned member is notified); authors edit their own notes, and authors
 * or admins delete them. Notes reload when the conversation changes, after
 * every change made here, when a teammate's change arrives on the event
 * stream (the thread's channel bumps `revision`; conversation_notes events
 * carry ids only), and when the window regains focus.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Pencil, StickyNote, Trash2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { authFetch } from "@/lib/auth/client";
import { cn } from "@/lib/utils";
import { splitMentions, type MentionMember } from "./mentions";
import { NotesComposer } from "./notes-composer";

export interface ConversationNoteView {
  id: string;
  conversation_id: string;
  author_id: string;
  body: string;
  mentions: string[];
  created_at: string;
  edited_at: string | null;
}

export interface NotesPanelProps {
  conversationId: string;
  /** Agent and above; viewers only read. */
  canWrite: boolean;
  /** Current workspace members, for author names and @mentions. */
  members: { id: string; name: string }[];
  /** Changes when a conversation_notes event for this conversation arrives; the panel re-reads. */
  revision?: number;
}

async function errorMessage(response: Response, fallback: string): Promise<string> {
  const data = await response.json().catch(() => null);
  return typeof data?.error === "string" ? data.error : fallback;
}

export function NotesPanel({ conversationId, canWrite, members, revision = 0 }: NotesPanelProps) {
  const t = useTranslations("Inbox.notes");
  const format = useFormatter();
  const { user, accountRole } = useAuth();
  const [notes, setNotes] = useState<ConversationNoteView[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const base = `/api/conversations/${encodeURIComponent(conversationId)}/notes`;
  const names = useMemo(() => new Map(members.map((m) => [m.id, m.name])), [members]);
  const mentionable: MentionMember[] = useMemo(
    () => members.filter((m) => m.id !== user?.id && m.name.trim()),
    [members, user?.id],
  );
  const isAdmin = accountRole === "owner" || accountRole === "admin";

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await authFetch(base, { signal, cache: "no-store" });
      if (!response.ok) throw new Error("load");
      const data = (await response.json()) as { notes?: ConversationNoteView[] };
      if (signal?.aborted) return;
      setNotes(Array.isArray(data.notes) ? data.notes : []);
      setFailed(false);
    } catch {
      if (!signal?.aborted) setFailed(true);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setNotes([]);
    setEditing(null);
    void load(controller.signal);
    const onFocus = () => void load(controller.signal);
    window.addEventListener("focus", onFocus);
    return () => {
      controller.abort();
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  // Live notes: a teammate's insert, edit or delete on this conversation's
  // notes (events are scoped to this workspace by the server) re-reads the list.
  useEffect(() => {
    if (!revision) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [revision, load]);

  const create = async (body: string, mentions: string[]) => {
    const response = await authFetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body, mentions }),
    });
    if (!response.ok) {
      toast.error(await errorMessage(response, t("saveFailed")));
      return false;
    }
    const { note } = (await response.json()) as { note: ConversationNoteView };
    setNotes((prev) => [...prev.filter((n) => n.id !== note.id), note]);
    return true;
  };

  const update = async (id: string, body: string, mentions: string[]) => {
    const response = await authFetch(`${base}/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body, mentions }),
    });
    if (!response.ok) {
      toast.error(await errorMessage(response, t("saveFailed")));
      return false;
    }
    const { note } = (await response.json()) as { note: ConversationNoteView };
    setNotes((prev) => prev.map((n) => (n.id === note.id ? note : n)));
    setEditing(null);
    return true;
  };

  const remove = async (id: string) => {
    if (!window.confirm(t("deleteConfirm"))) return;
    setDeleting(id);
    try {
      const response = await authFetch(`${base}/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) {
        toast.error(await errorMessage(response, t("deleteFailed")));
        return;
      }
      setNotes((prev) => prev.filter((n) => n.id !== id));
    } finally {
      setDeleting(null);
    }
  };

  const allNames = useMemo(() => members.map((m) => m.name), [members]);

  return (
    <section aria-label={t("title")} className="flex flex-col gap-3">
      <header className="flex items-center gap-2 text-sm font-medium">
        <StickyNote className="size-4 text-muted-foreground" aria-hidden />
        <h3>{t("title")}</h3>
        <span className="text-xs font-normal text-muted-foreground">{t("internalOnly")}</span>
      </header>

      {loading ? (
        <div className="flex justify-center py-4" role="status" aria-label={t("loading")}>
          <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
        </div>
      ) : failed ? (
        <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
          <span>{t("loadFailed")}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => { setLoading(true); void load(); }}>
            {t("retry")}
          </Button>
        </div>
      ) : notes.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {notes.map((note) => {
            const mine = note.author_id === user?.id;
            const author = names.get(note.author_id) ?? t("formerMember");
            return (
              <li
                key={note.id}
                className="rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-sm dark:border-amber-900/60 dark:bg-amber-950/30"
              >
                <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="truncate font-medium text-foreground">{mine ? t("you") : author}</span>
                  <time dateTime={note.created_at} title={format.dateTime(new Date(note.created_at), { dateStyle: "medium", timeStyle: "short" })}>
                    {format.relativeTime(new Date(note.created_at))}
                  </time>
                  {note.edited_at && <span>{t("edited")}</span>}
                  {canWrite && editing !== note.id && (
                    <span className="ml-auto flex gap-0.5">
                      {mine && (
                        <Button type="button" variant="ghost" size="icon-xs" aria-label={t("edit")} onClick={() => setEditing(note.id)}>
                          <Pencil aria-hidden />
                        </Button>
                      )}
                      {(mine || isAdmin) && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label={t("delete")}
                          disabled={deleting === note.id}
                          onClick={() => void remove(note.id)}
                        >
                          {deleting === note.id ? <Loader2 className="animate-spin" aria-hidden /> : <Trash2 aria-hidden />}
                        </Button>
                      )}
                    </span>
                  )}
                </div>
                {editing === note.id ? (
                  <NotesComposer
                    members={mentionable}
                    initialBody={note.body}
                    initialMentions={note.mentions}
                    submitLabel={t("save")}
                    autoFocus
                    onCancel={() => setEditing(null)}
                    onSubmit={(body, mentions) => update(note.id, body, mentions)}
                  />
                ) : (
                  <p className="whitespace-pre-wrap break-words">
                    {splitMentions(note.body, allNames).map((part, index) => (
                      <span key={index} className={cn(part.mention && "font-medium text-primary")}>
                        {part.text}
                      </span>
                    ))}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {canWrite && <NotesComposer members={mentionable} onSubmit={create} />}
    </section>
  );
}
