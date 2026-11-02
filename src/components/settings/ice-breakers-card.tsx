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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { authFetch } from "@/lib/auth/client";
import { NumberSelect } from "./numbers/number-select";
import { useWhatsAppNumbers } from "./numbers/use-whatsapp-numbers";

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

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">{t("title")}</CardTitle>
        <CardDescription className="text-muted-foreground">{t("description", { max: MAX })}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {numbers.length > 1 && (
          <>
          <label htmlFor="ice-breakers-number" className="sr-only">{t("numberLabel")}</label>
          <NumberSelect
            id="ice-breakers-number"
            numbers={numbers}
            value={numberId}
            onChange={setNumberId}
            emptyLabel={t("defaultNumber")}
            disabled={saving}
            className="border-border bg-card text-foreground mb-2 h-9 w-full rounded-md border px-2 text-sm"
          />
          </>
        )}
        {loading ? (
          <Loader2 className="size-4 animate-spin text-primary" />
        ) : (
          <>
            {prompts.map((prompt, i) => (
              <div key={i} className="flex gap-2">
                <Input aria-label={t("promptN", { n: i + 1 })} value={prompt} maxLength={MAX_LENGTH} disabled={!editable}
                  onChange={(e) => setPrompts(prompts.map((p, j) => (j === i ? e.target.value : p)))} className="bg-muted" />
                {editable && (
                  <Button type="button" variant="ghost" size="sm" aria-label={t("remove")} onClick={() => setPrompts(prompts.filter((_, j) => j !== i))}>
                    <Trash2 className="size-3.5" />
                  </Button>
                )}
              </div>
            ))}
            {editable && (
              <div className="flex flex-wrap items-center gap-2">
                {prompts.length < MAX && (
                  <Button type="button" variant="outline" size="sm" onClick={() => setPrompts([...prompts, ""])}>
                    <Plus className="size-3.5" /> {t("add")}
                  </Button>
                )}
                <Button type="button" size="sm" onClick={save} disabled={saving}>
                  {saving && <Loader2 className="size-3.5 animate-spin" />} {t("save")}
                </Button>
              </div>
            )}
            <p className={loadFailed ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
              {loadFailed ? t("loadFailed") : syncedAt ? t("syncedAt", { date: new Date(syncedAt).toLocaleString() }) : t("notSynced")}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
