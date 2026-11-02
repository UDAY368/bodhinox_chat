"use client";

/**
 * Settings → WhatsApp: the up-to-4 ice breakers a customer can tap when
 * opening a new chat. Saving sends them to Meta first; a flow starts on
 * one with an exact keyword (the flow trigger panel offers them).
 */

import { useEffect, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { authFetch } from "@/lib/auth/client";

const MAX = 4;
const MAX_LENGTH = 80;

export function IceBreakersCard({ canEdit }: { canEdit: boolean }) {
  const t = useTranslations("Settings.iceBreakers");
  const [prompts, setPrompts] = useState<string[]>([]);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // After a failed load the list is unknown; saving would wipe the prompts on WhatsApp.
  const [loadFailed, setLoadFailed] = useState(false);
  const editable = canEdit && !loadFailed;

  useEffect(() => {
    let live = true;
    authFetch("/api/whatsapp/ice-breakers", { cache: "no-store" })
      .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then((json) => { if (live) { setPrompts(json.prompts ?? []); setSyncedAt(json.synced_at ?? null); } })
      .catch(() => { if (live) setLoadFailed(true); })
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const res = await authFetch("/api/whatsapp/ice-breakers", {
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
