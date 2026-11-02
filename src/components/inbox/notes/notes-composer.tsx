"use client";

/**
 * Text box for an internal note with @mention autocomplete. Typing "@" opens
 * a list of workspace members; arrow keys, Enter or Tab pick one, Escape
 * closes it. Only members picked from the list (and still named in the text)
 * are sent as mentions. Ctrl/Cmd+Enter saves.
 */

import { useId, useRef, useState, type KeyboardEvent } from "react";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  activeMentionQuery,
  insertMention,
  matchMembers,
  mentionedIds,
  type MentionMember,
} from "./mentions";

export const NOTE_BODY_MAX = 4000;

export interface NotesComposerProps {
  members: MentionMember[];
  /** Resolves true when saved; the box then clears (or closes, when editing). */
  onSubmit: (body: string, mentions: string[]) => Promise<boolean>;
  onCancel?: () => void;
  initialBody?: string;
  initialMentions?: string[];
  submitLabel?: string;
  disabled?: boolean;
  autoFocus?: boolean;
}

export function NotesComposer({
  members,
  onSubmit,
  onCancel,
  initialBody = "",
  initialMentions = [],
  submitLabel,
  disabled = false,
  autoFocus = false,
}: NotesComposerProps) {
  const t = useTranslations("Inbox.notes");
  const listId = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [body, setBody] = useState(initialBody);
  const [caret, setCaret] = useState(initialBody.length);
  const [picked, setPicked] = useState<Map<string, string>>(() => {
    const byId = new Map(members.map((m) => [m.id, m.name]));
    return new Map(initialMentions.flatMap((id) => (byId.has(id) ? [[id, byId.get(id)!] as const] : [])));
  });
  const [highlight, setHighlight] = useState(0);
  // An edit that ends in "@Name" should not open the list until the user types.
  const [dismissedAt, setDismissedAt] = useState<number | null>(
    () => activeMentionQuery(initialBody, initialBody.length)?.start ?? null,
  );
  const [saving, setSaving] = useState(false);

  const mention = activeMentionQuery(body, caret);
  const suggestions = mention ? matchMembers(members, mention.query) : [];
  const open = !!mention && dismissedAt !== mention.start && suggestions.length > 0 && !disabled;
  const active = open ? Math.min(highlight, suggestions.length - 1) : -1;

  const trimmed = body.trim();
  const tooLong = body.length > NOTE_BODY_MAX;
  const canSave = !disabled && !saving && !!trimmed && !tooLong;

  const syncCaret = () => setCaret(ref.current?.selectionStart ?? body.length);

  const pick = (member: MentionMember) => {
    if (!mention) return;
    const next = insertMention(body, mention.start, caret, member.name);
    setBody(next.text);
    setCaret(next.caret);
    setPicked((prev) => new Map(prev).set(member.id, member.name));
    setHighlight(0);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const ok = await onSubmit(trimmed, mentionedIds(body, picked));
      if (ok && !onCancel) {
        setBody("");
        setCaret(0);
        setPicked(new Map());
      }
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setHighlight((active + step + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        pick(suggestions[active]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedAt(mention!.start);
        return;
      }
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void save();
    } else if (event.key === "Escape" && onCancel) {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="relative flex flex-col gap-2">
      <Textarea
        ref={ref}
        value={body}
        rows={3}
        autoFocus={autoFocus}
        disabled={disabled || saving}
        placeholder={t("placeholder")}
        aria-label={t("composerLabel")}
        aria-invalid={tooLong || undefined}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        className="max-h-48 resize-none"
        onChange={(event) => {
          setBody(event.target.value);
          setCaret(event.target.selectionStart ?? event.target.value.length);
          setHighlight(0);
        }}
        onKeyDown={onKeyDown}
        onKeyUp={syncCaret}
        onClick={syncCaret}
        onSelect={syncCaret}
      />
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label={t("mentionList")}
          className="absolute bottom-full left-0 z-20 mb-1 max-h-56 w-full max-w-xs overflow-y-auto rounded-lg border bg-popover p-1 text-sm text-popover-foreground shadow-md"
        >
          {suggestions.map((member, index) => (
            <li
              key={member.id}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              className={cn(
                "cursor-pointer truncate rounded-md px-2 py-1.5",
                index === active && "bg-accent text-accent-foreground",
              )}
              onMouseDown={(event) => {
                event.preventDefault();
                pick(member);
              }}
              onMouseEnter={() => setHighlight(index)}
            >
              {member.name}
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className={cn("text-xs text-muted-foreground", tooLong && "text-destructive")}>
          {tooLong ? t("tooLong", { max: NOTE_BODY_MAX }) : t("hint")}
        </span>
        <div className="flex gap-2">
          {onCancel && (
            <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
              {t("cancel")}
            </Button>
          )}
          <Button type="button" size="sm" onClick={() => void save()} disabled={!canSave}>
            {saving && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
            {submitLabel ?? t("add")}
          </Button>
        </div>
      </div>
    </div>
  );
}
