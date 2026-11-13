"use client";

// New message: pick a contact and a channel, then open their conversation.
// When the contact has none on WhatsApp yet, an approved template starts it
// (Meta allows nothing else outside the 24-hour window): the template picker
// opens and the send goes through /api/whatsapp/send with contact_id, which
// finds or creates the conversation. Instagram chats can only be started by
// the customer, so an Instagram choice opens an existing chat or says so.
import { useEffect, useState } from "react";
import { Loader2, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { authFetch } from "@/lib/auth/client";
import { createClient } from "@/lib/data/client";
import { CONVERSATION_SELECT, normalizeConversation } from "@/lib/inbox/conversations";
import { renderTemplateBody } from "@/lib/whatsapp/template-body";
import { cn } from "@/lib/utils";
import type { Conversation, ConversationChannel, MessageTemplate } from "@/types";
import { TemplatePicker, type TemplateSendValues } from "./template-picker";

interface ContactOption {
  id: string;
  name: string | null;
  phone: string | null;
  blocked_at: string | null;
}

/** A contact search term made safe for an ilike pattern. */
export function contactSearchTerm(raw: string): string {
  return raw.trim().replace(/[%_,()\\]/g, "").slice(0, 80);
}

export function NewMessageDialog({
  open,
  onOpenChange,
  channels,
  onOpen,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The channels this inbox can start on (the workspace's enabled ones in scope). */
  channels: ConversationChannel[];
  /** Open (and list) this conversation. */
  onOpen: (conversation: Conversation) => void;
}) {
  const t = useTranslations("Inbox.newMessage");
  const tc = useTranslations("Inbox.channel");
  const [search, setSearch] = useState("");
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [contactId, setContactId] = useState("");
  const [channel, setChannel] = useState<ConversationChannel>(channels[0] ?? "whatsapp");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const activeChannel = channels.includes(channel) ? channel : (channels[0] ?? "whatsapp");

  useEffect(() => {
    if (!open) return;
    let live = true;
    const term = contactSearchTerm(search);
    const timer = setTimeout(() => {
      setSearching(true);
      let q = createClient().from("contacts").select("id,name,phone,blocked_at").order("name").limit(20);
      if (term) q = q.ilike("name", `%${term}%`);
      void q.then(({ data }) => {
        if (!live) return;
        setContacts(((data ?? []) as ContactOption[]).filter((c) => !c.blocked_at));
        setSearching(false);
      });
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [open, search]);

  const reset = () => {
    setSearch("");
    setContactId("");
    setError("");
    setBusy(false);
  };
  const close = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const picked = contacts.find((c) => c.id === contactId) ?? null;

  const findConversation = async (id: string, on: ConversationChannel): Promise<Conversation | null> => {
    const { data } = await createClient()
      .from("conversations")
      .select(CONVERSATION_SELECT)
      .eq("contact_id", id)
      .eq("channel", on)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(1);
    const row = Array.isArray(data) ? data[0] : data;
    return row ? normalizeConversation(row) : null;
  };

  const start = async () => {
    if (!picked) {
      setError(t("chooseContact"));
      return;
    }
    if (activeChannel === "whatsapp" && !picked.phone) {
      setError(t("noNumber", { name: picked.name || t("thisContact") }));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const existing = await findConversation(picked.id, activeChannel);
      if (existing) {
        toast.success(t("openedExisting"));
        close(false);
        onOpen(existing);
        return;
      }
      if (activeChannel === "instagram") {
        setError(t("instagramStartsWithCustomer"));
        return;
      }
      // A new WhatsApp chat starts with an approved template.
      setTemplateOpen(true);
    } catch {
      setError(t("failed"));
    } finally {
      setBusy(false);
    }
  };

  const sendTemplate = async (template: MessageTemplate, values: TemplateSendValues) => {
    if (!picked) return;
    setBusy(true);
    try {
      const res = await authFetch("/api/whatsapp/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contact_id: picked.id,
          message_type: "template",
          template_name: template.name,
          template_language: template.language,
          template_message_params: values,
          template_params: values.body,
          content_text: renderTemplateBody(template.body_text, values.body),
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(t("sendFailed", { reason: payload.error || `HTTP ${res.status}` }));
        return;
      }
      const created = await findConversation(picked.id, "whatsapp");
      toast.success(t("started", { name: picked.name || picked.phone || "" }));
      close(false);
      if (created) onOpen(created);
    } catch {
      toast.error(t("failed"));
    } finally {
      setBusy(false);
    }
  };

  const hint = !picked
    ? t("hintPick")
    : activeChannel === "whatsapp"
      ? picked.phone
        ? t("hintWhatsapp", { to: picked.phone })
        : ""
      : t("hintInstagram");

  return (
    <>
      <Dialog open={open} onOpenChange={close}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
            <DialogDescription>{t("description")}</DialogDescription>
          </DialogHeader>
          <form
            className="flex min-w-0 flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void start();
            }}
          >
            <label className="flex flex-col gap-1.5 text-xs font-medium">
              {t("contact")}
              <span className="relative">
                <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" aria-hidden />
                <Input
                  type="search"
                  value={search}
                  autoFocus
                  placeholder={t("searchPlaceholder")}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setError("");
                  }}
                  className="pl-9"
                />
              </span>
            </label>
            <div role="listbox" aria-label={t("contact")} className="border-border max-h-52 min-w-0 overflow-y-auto rounded-lg border p-1">
              {searching && contacts.length === 0 ? (
                <p className="text-muted-foreground flex items-center gap-2 px-2 py-2 text-xs">
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  {t("searching")}
                </p>
              ) : contacts.length === 0 ? (
                <p className="text-muted-foreground px-2 py-2 text-xs">{t("noContacts")}</p>
              ) : (
                contacts.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    role="option"
                    aria-selected={c.id === contactId}
                    onClick={() => {
                      setContactId(c.id);
                      setError("");
                      if (!c.phone && channels.includes("instagram")) setChannel("instagram");
                    }}
                    className={cn(
                      "flex w-full min-w-0 items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-sm focus-visible:outline-2",
                      c.id === contactId ? "bg-primary/10 text-primary" : "hover:bg-muted"
                    )}
                  >
                    <span className="min-w-0 truncate font-medium">{c.name || c.phone || t("unnamed")}</span>
                    {c.phone && <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{c.phone}</span>}
                  </button>
                ))
              )}
            </div>
            {channels.length > 1 && (
              <div className="flex flex-col gap-1.5 text-xs font-medium">
                <span id="new-message-channel">{t("channel")}</span>
                <div role="radiogroup" aria-labelledby="new-message-channel" className="bg-muted grid grid-cols-2 gap-0.5 rounded-lg p-0.5">
                  {channels.map((value) => (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={activeChannel === value}
                      onClick={() => {
                        setChannel(value);
                        setError("");
                      }}
                      className={cn(
                        "h-8 rounded-md text-xs font-medium focus-visible:outline-2",
                        activeChannel === value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {tc(value)}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
            {error && <p role="alert" className="text-destructive text-xs font-medium">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => close(false)}>{t("cancel")}</Button>
              <Button type="submit" disabled={busy}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                {t("start")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <TemplatePicker open={templateOpen} onOpenChange={setTemplateOpen} onSelect={(template, values) => void sendTemplate(template, values)} />
    </>
  );
}
