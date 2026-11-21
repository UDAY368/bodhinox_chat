"use client";
import { authFetch } from "@/lib/auth/client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, MessageSquare, Pencil, Plus, Search, Trash2, Zap } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageLoading } from "@/components/ui/page-loading";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { SettingsPanelHead } from "./settings-panel-head";
import {
  InteractiveBuilder,
  blankButtonsPayload,
} from "@/components/interactive/interactive-builder";
import {
  interactivePayloadPreviewText,
  validateInteractivePayload,
  type InteractiveMessagePayload,
} from "@/lib/whatsapp/interactive";
import type { QuickReply, QuickReplyKind } from "@/types";

interface DraftState {
  id?: string;
  title: string;
  kind: QuickReplyKind;
  content_text: string;
  interactive_payload: InteractiveMessagePayload;
}

function emptyDraft(): DraftState {
  return {
    title: "",
    kind: "text",
    content_text: "",
    interactive_payload: blankButtonsPayload(),
  };
}

export function QuickRepliesManager() {
  const t = useTranslations("Settings.quickReplies");
  const confirm = useConfirm();
  const [items, setItems] = useState<QuickReply[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");
  const tSearch = useTranslations("SettingsRedesign.quickReplies");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch("/api/quick-replies", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setItems((data.quick_replies as QuickReply[]) ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => setDraft(emptyDraft());
  const openEdit = (qr: QuickReply) =>
    setDraft({
      id: qr.id,
      title: qr.title,
      kind: qr.kind,
      content_text: qr.content_text ?? "",
      interactive_payload:
        qr.interactive_payload ?? blankButtonsPayload(),
    });

  const save = useCallback(async () => {
    if (!draft) return;
    if (!draft.title.trim()) {
      toast.error(t("nameRequired"));
      return;
    }
    if (draft.kind === 'interactive') {
      const valid = validateInteractivePayload(draft.interactive_payload);
      if (!valid.ok) { toast.error(valid.error); return; }
    }
    const payload =
      draft.kind === "interactive"
        ? { title: draft.title, kind: "interactive", interactive_payload: draft.interactive_payload }
        : { title: draft.title, kind: "text", content_text: draft.content_text };

    setSaving(true);
    try {
      const res = await authFetch(
        draft.id ? `/api/quick-replies/${draft.id}` : "/api/quick-replies",
        {
          method: draft.id ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t("saveError"));
        return;
      }
      toast.success(draft.id ? t("updated") : t("created"));
      setDraft(null);
      await load();
    } catch {
      toast.error(t("saveError"));
    } finally {
      setSaving(false);
    }
  }, [draft, load, t]);

  const remove = useCallback(
    async (id: string) => {
      if (!(await confirm({ title: t("deleteConfirm"), confirmLabel: t("delete"), destructive: true }))) return;
      const res = await authFetch(`/api/quick-replies/${id}`, { method: "DELETE" });
      if (!res.ok) {
        toast.error(t("deleteError"));
        return;
      }
      await load();
    },
    [confirm, load, t],
  );

  // Search by name, text or the interactive message's preview.
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? items.filter((qr) => [qr.title, qr.content_text ?? "", qr.interactive_payload ? interactivePayloadPreviewText(qr.interactive_payload) : ""]
      .some((text) => text.toLowerCase().includes(needle)))
    : items;

  return (
    <div>
      <SettingsPanelHead
        title={t("title")}
        description={t("description")}
        action={
          <Button onClick={openCreate}>
            <Plus className="mr-1 h-4 w-4" />
            {t("new")}
          </Button>
        }
      />

      {items.length > 0 && (
        <label className="relative mb-3 block sm:max-w-sm">
          <span className="sr-only">{tSearch("search")}</span>
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tSearch("search")} className="bg-card pl-8" />
        </label>
      )}

      {loading ? (
        <PageLoading rows={4} />
      ) : items.length === 0 ? (
        <EmptyState icon={Zap} title={t("empty")} />
      ) : visible.length === 0 ? (
        <EmptyState icon={Search} title={tSearch("noMatch")} body={tSearch("noMatchHint")}
          action={<Button type="button" variant="outline" className="min-h-11 sm:min-h-9" onClick={() => setQuery("")}>{tSearch("clear")}</Button>} />
      ) : (
        <ul className="flex flex-col gap-2">
          {visible.map((qr) => (
            <li
              key={qr.id}
              className="flex items-start gap-3 rounded-lg border border-border bg-card p-3"
            >
              {qr.kind === "interactive" ? (
                <Zap className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              ) : (
                <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{qr.title}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {qr.kind === "interactive" && qr.interactive_payload
                    ? interactivePayloadPreviewText(qr.interactive_payload)
                    : qr.content_text}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button variant="ghost" size="icon-sm" onClick={() => openEdit(qr)} aria-label={t("edit")}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => remove(qr.id)}
                  aria-label={t("delete")}
                  className="text-red-600 dark:text-red-400 hover:bg-red-500/10 hover:text-red-700 dark:hover:text-red-300"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Sheet open={!!draft} onOpenChange={(o) => !o && setDraft(null)}>
        <SheetContent size="lg" className="w-full gap-4 overflow-y-auto p-4">
          <SheetHeader className="p-0 pr-8">
            <SheetTitle>{draft?.id ? t("edit") : t("new")}</SheetTitle>
          </SheetHeader>
          {draft && (
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">{t("nameLabel")}</label>
                <Input
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  placeholder={t("namePlaceholder")}
                  className="bg-muted text-foreground"
                />
              </div>
              <div className="flex gap-2">
                <KindTab
                  active={draft.kind === "text"}
                  label={t("kindText")}
                  onClick={() => setDraft({ ...draft, kind: "text" })}
                />
                <KindTab
                  active={draft.kind === "interactive"}
                  label={t("kindInteractive")}
                  onClick={() => setDraft({ ...draft, kind: "interactive" })}
                />
              </div>
              {draft.kind === "text" ? (
                <Textarea
                  value={draft.content_text}
                  onChange={(e) => setDraft({ ...draft, content_text: e.target.value })}
                  placeholder={t("textPlaceholder")}
                  className="min-h-28 bg-muted text-foreground"
                />
              ) : (
                <InteractiveBuilder
                  value={draft.interactive_payload}
                  onChange={(p) => setDraft({ ...draft, interactive_payload: p })}
                />
              )}
            </div>
          )}
          <SheetFooter className="flex-row flex-wrap justify-end p-0">
            <Button variant="outline" onClick={() => setDraft(null)} disabled={saving}>
              {t("cancel")}
            </Button>
            <Button onClick={save} disabled={saving || !draft?.title.trim() || (draft.kind === 'interactive' ? !validateInteractivePayload(draft.interactive_payload).ok : !draft.content_text.trim())}>
              {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {t("save")}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function KindTab({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? "flex-1 rounded-md border border-primary bg-primary/10 px-3 py-1.5 text-sm font-medium text-primary"
          : "flex-1 rounded-md border border-border bg-muted px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
      }
    >
      {label}
    </button>
  );
}
