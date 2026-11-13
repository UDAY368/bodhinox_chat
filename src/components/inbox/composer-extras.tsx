"use client";

// Composer helpers from the inbox design: an emoji grid, and "/" quick
// replies (type / and part of a saved reply's name, pick with the arrows and
// Enter). Saved replies come from /api/quick-replies, read once when first needed.
import { useEffect, useState } from "react";
import { Smile } from "lucide-react";
import { useTranslations } from "next-intl";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { authFetch } from "@/lib/auth/client";
import { interactivePayloadPreviewText } from "@/lib/whatsapp/interactive";
import { cn } from "@/lib/utils";
import type { QuickReply } from "@/types";

export const COMPOSER_EMOJI = [
  "😀", "😊", "😂", "😍", "🤔", "😅", "🙏", "👍", "👏", "🙌", "🎉", "❤️",
  "🔥", "✅", "⭐", "📦", "📅", "📍", "💬", "🤝", "👋", "😢", "😮", "💡",
] as const;

/** The draft is a slash command ("/", "/ord"): what follows the slash, lower-cased; else null. */
export function slashQuery(text: string): string | null {
  return /^\/\S*$/.test(text) ? text.slice(1).toLowerCase() : null;
}

/** Saved replies matching a slash query: name prefix first, then name or text containing it; at most 8. */
export function matchQuickReplies(items: readonly QuickReply[], query: string): QuickReply[] {
  if (!query) return items.slice(0, 8);
  const text = (qr: QuickReply) => (qr.content_text ?? (qr.interactive_payload ? interactivePayloadPreviewText(qr.interactive_payload) : "")).toLowerCase();
  const prefix = items.filter((qr) => qr.title.toLowerCase().startsWith(query));
  const rest = items.filter((qr) => !prefix.includes(qr) && (qr.title.toLowerCase().includes(query) || text(qr).includes(query)));
  return [...prefix, ...rest].slice(0, 8);
}

/** The workspace's saved replies, loaded the first time `enabled` is true. */
export function useQuickReplyList(enabled: boolean): QuickReply[] | null {
  const [items, setItems] = useState<QuickReply[] | null>(null);
  const load = enabled && items === null;
  useEffect(() => {
    if (!load) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await authFetch("/api/quick-replies", { cache: "no-store" });
        const data = (await res.json().catch(() => ({}))) as { quick_replies?: QuickReply[] };
        if (!cancelled) setItems(res.ok ? (data.quick_replies ?? []) : []);
      } catch {
        if (!cancelled) setItems([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);
  return items;
}

export function EmojiPicker({ onPick, disabled }: { onPick: (emoji: string) => void; disabled?: boolean }) {
  const t = useTranslations("Inbox.composer");
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        aria-label={t("emoji")}
        title={t("emoji")}
        data-composer-emoji
        className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex size-8 shrink-0 items-center justify-center rounded-lg p-0 transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Smile className="h-4 w-4" />
      </PopoverTrigger>
      <PopoverContent align="start" side="top" sideOffset={8} className="w-auto p-1.5">
        <div role="group" aria-label={t("emoji")} className="grid grid-cols-8 gap-0.5">
          {COMPOSER_EMOJI.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={emoji}
              onClick={() => {
                onPick(emoji);
                setOpen(false);
              }}
              className="hover:bg-muted focus-visible:bg-muted flex size-8 items-center justify-center rounded-md text-lg leading-none outline-none"
            >
              {emoji}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function SlashQuickReplies({
  id,
  items,
  query,
  activeIndex,
  onPick,
  onHover,
}: {
  id: string;
  items: QuickReply[] | null;
  query: string;
  activeIndex: number;
  onPick: (qr: QuickReply) => void;
  onHover: (index: number) => void;
}) {
  const t = useTranslations("Inbox.composer");
  const matches = items ? matchQuickReplies(items, query) : [];
  return (
    <div
      id={id}
      role="listbox"
      aria-label={t("quickReplies")}
      data-slash-quick-replies
      className="border-border bg-popover text-popover-foreground absolute right-0 bottom-full left-0 z-20 mb-2 max-h-64 overflow-y-auto rounded-xl border p-1 shadow-lg"
    >
      <p className="text-muted-foreground px-2 pt-1 pb-1.5 text-[11px] font-semibold tracking-wide uppercase">{t("quickReplies")}</p>
      {items === null ? (
        <p className="text-muted-foreground px-2 py-2 text-xs">{t("quickRepliesLoading")}</p>
      ) : matches.length === 0 ? (
        <p className="text-muted-foreground px-2 py-2 text-xs">{t("slashNoMatch", { query: `/${query}` })}</p>
      ) : (
        matches.map((qr, index) => (
          <div
            key={qr.id}
            id={`${id}-${index}`}
            role="option"
            aria-selected={index === activeIndex}
            onMouseDown={(event) => {
              // Keep focus in the text box.
              event.preventDefault();
              onPick(qr);
            }}
            onMouseEnter={() => onHover(index)}
            className={cn(
              "flex cursor-pointer flex-col gap-0.5 rounded-lg px-2 py-1.5",
              index === activeIndex ? "bg-muted" : "hover:bg-muted/60"
            )}
          >
            <span className="text-sm font-medium">/{qr.title}</span>
            <span className="text-muted-foreground truncate text-xs">
              {qr.content_text ?? (qr.interactive_payload ? interactivePayloadPreviewText(qr.interactive_payload) : "")}
            </span>
          </div>
        ))
      )}
    </div>
  );
}
