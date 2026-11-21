"use client";

/**
 * Settings → WhatsApp: the up-to-4 ice breakers a customer can tap when
 * opening a new chat. They belong to one WhatsApp number; with two or more
 * numbers the card shows a picker (the empty choice is the workspace default).
 * Saving sends them to Meta first; a flow starts on one with an exact keyword
 * (the flow trigger panel offers them).
 */

import { useEffect, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authFetch } from "@/lib/auth/client";
import { NumberSelect } from "./numbers/number-select";
import { useWhatsAppNumbers } from "./numbers/use-whatsapp-numbers";
import { GroupedListRow } from "@/components/ui/grouped-list";
import { cn } from "@/lib/utils";
import { SETTINGS_ROW_HAIRLINE, SettingsGroup, SettingsRow } from "./settings-row";

const MAX = 4;
const MAX_LENGTH = 80;

const endpoint = (numberId: string | null) =>
  numberId ? `/api/whatsapp/ice-breakers?number=${encodeURIComponent(numberId)}` : "/api/whatsapp/ice-breakers";

/** `numberId` preselects a number (the one the settings form is editing; remount with a key to change it); null means the default. */
export function IceBreakersCard({ canEdit, numberId: initialNumberId = null }: { canEdit: boolean; numberId?: string | null }) {
  const t = useTranslations("Settings.iceBreakers");
  const { numbers } = useWhatsAppNumbers();
  const [numberId, setNumberId] = useState<string | null>(initialNumberId);
  // The number the list was read from; saving writes there, even if the default changes meanwhile.
  const [loadedNumberId, setLoadedNumberId] = useState<string | null>(null);
  const [prompts, setPrompts] = useState<string[]>([]);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // After a failed load the list is unknown; saving would wipe the prompts on WhatsApp.
  const [loadFailed, setLoadFailed] = useState(false);
  const editable = canEdit && !loadFailed;

  useEffect(() => {
    let live = true;
    setLoading(true);
    setLoadFailed(false);
    setPrompts([]);
    setSyncedAt(null);
    setLoadedNumberId(null);
    authFetch(endpoint(numberId), { cache: "no-store" })
      .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then((json) => {
        if (!live) return;
        setPrompts(json.prompts ?? []);
        setSyncedAt(json.synced_at ?? null);
        setLoadedNumberId(typeof json.number_id === "string" ? json.number_id : null);
      })
      .catch(() => { if (live) setLoadFailed(true); })
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [numberId]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await authFetch(endpoint(loadedNumberId ?? numberId), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompts: prompts.map((p) => p.trim()).filter(Boolean) }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : t("saveFailed"));
      setPrompts(json.prompts);
      setSyncedAt(json.synced_at);
      toast.success(t("saved"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const status = (
    <span className={loadFailed ? "text-destructive" : undefined}>
      {loadFailed ? t("loadFailed") : syncedAt ? t("syncedAt", { date: new Date(syncedAt).toLocaleString() }) : t("notSynced")}
    </span>
  );

  return (
    <SettingsGroup
      title={t("title")}
      footer={<>{t("description", { max: MAX })} {!loading && status}</>}
      action={editable && !loading ? (
        <Button type="button" size="sm" onClick={save} disabled={saving} className="min-h-11 sm:min-h-8">
          {saving && <Loader2 className="size-3.5 animate-spin" />} {t("save")}
        </Button>
      ) : undefined}
    >
      {numbers.length > 1 && (
        <SettingsRow label={t("numberLabel")} htmlFor="ice-breakers-number">
          <NumberSelect
            id="ice-breakers-number"
            numbers={numbers}
            value={numberId}
            onChange={setNumberId}
            emptyLabel={t("defaultNumber")}
            disabled={saving}
            className="border-border bg-card text-foreground h-11 w-full rounded-md border px-2 text-sm sm:h-9"
          />
        </SettingsRow>
      )}
      {loading ? (
        <div className={cn(SETTINGS_ROW_HAIRLINE, "space-y-2 px-4 py-3")} aria-busy="true">
          <div className="h-9 w-full animate-pulse rounded-md bg-muted" />
          <div className="h-9 w-2/3 animate-pulse rounded-md bg-muted" />
        </div>
      ) : (
        <>
          {prompts.map((prompt, i) => (
            <div key={i} className={cn(SETTINGS_ROW_HAIRLINE, "flex min-h-11 items-center gap-2 px-4 py-2")}>
              <Input aria-label={t("promptN", { n: i + 1 })} value={prompt} maxLength={MAX_LENGTH} disabled={!editable}
                onChange={(e) => setPrompts(prompts.map((p, j) => (j === i ? e.target.value : p)))} />
              {editable && (
                <Button type="button" variant="ghost" size="icon" className="size-11 shrink-0 text-destructive sm:size-9" aria-label={t("remove")} onClick={() => setPrompts(prompts.filter((_, j) => j !== i))}>
                  <Trash2 className="size-4" />
                </Button>
              )}
            </div>
          ))}
          {editable && prompts.length < MAX && (
            <GroupedListRow
              leading={<Plus className="size-4 text-primary" aria-hidden />}
              title={<span className="text-primary">{t("add")}</span>}
              onClick={() => setPrompts([...prompts, ""])}
            />
          )}
          {prompts.length === 0 && !editable && (
            <div className={cn(SETTINGS_ROW_HAIRLINE, "flex min-h-11 items-center px-4 py-3 text-sm text-muted-foreground")}>{t("notSynced")}</div>
          )}
        </>
      )}
    </SettingsGroup>
  );
}
