"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { useCan } from "@/hooks/use-can";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useApprovedTemplates } from "@/components/flows/forms/use-pickers";
import { ORDER_CONFIRMATION_FIELDS } from "@/lib/commerce/order-format";
import { getOrderSettings, saveOrderSettings, type OrderSettings } from "./order-api";

const EMPTY: OrderSettings = { confirmation_mode: "off", confirmation_text: null, template_name: null, template_language: null, variable_map: {} };

/** Highest {{n}} in a template body. */
export function templateVariableCount(body: string): number {
  return Math.max(0, ...[...body.matchAll(/\{\{\s*(\d{1,2})\s*\}\}/g)].map((m) => Number(m[1])));
}

/**
 * The reply sent when a WhatsApp cart arrives. Agents see it; admins change it
 * (the API and RLS enforce the same rule).
 */
export function OrderSettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations("Commerce.orders.settings");
  const canEdit = useCan("edit-settings");
  const templates = useApprovedTemplates();
  const [settings, setSettings] = useState<OrderSettings>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getOrderSettings()
      .then((r) => !cancelled && (r.ok ? setSettings(r.value) : setError(t("loadError"))))
      .catch(() => !cancelled && setError(t("loadError")))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [t]);

  const templateKey = settings.template_name ? `${settings.template_name}|${settings.template_language ?? ""}` : "";
  const chosen = templates.find((x) => `${x.name}|${x.language ?? ""}` === templateKey);
  const variables = useMemo(() => (chosen ? templateVariableCount(chosen.body_text) : 0), [chosen]);
  const textInvalid = settings.confirmation_mode === "text" && !settings.confirmation_text?.trim();
  const templateInvalid = settings.confirmation_mode === "template" && !settings.template_name;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const variable_map = Object.fromEntries(Object.entries(settings.variable_map).filter(([k, v]) => Number(k) <= variables && v));
      const r = await saveOrderSettings({ ...settings, variable_map });
      if (!r.ok) {
        setError(r.error ?? t("saveError"));
        return;
      }
      setSettings(r.value);
      toast.success(t("saved"));
      onOpenChange(false);
    } catch {
      setError(t("saveError"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <fieldset disabled={!canEdit || saving} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="order-confirm-mode">{t("modeLabel")}</Label>
              <Select value={settings.confirmation_mode}
                onValueChange={(v) => setSettings((s) => ({ ...s, confirmation_mode: v as OrderSettings["confirmation_mode"] }))}>
                <SelectTrigger id="order-confirm-mode"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">{t("modeOff")}</SelectItem>
                  <SelectItem value="text">{t("modeText")}</SelectItem>
                  <SelectItem value="template">{t("modeTemplate")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {settings.confirmation_mode === "text" && (
              <div className="space-y-1.5">
                <Label htmlFor="order-confirm-text">{t("textLabel")}</Label>
                <Textarea id="order-confirm-text" rows={4} maxLength={1024} value={settings.confirmation_text ?? ""}
                  placeholder={t("textPlaceholder")}
                  onChange={(e) => setSettings((s) => ({ ...s, confirmation_text: e.target.value }))} />
                <p className="text-xs text-muted-foreground">{t("textHelp")}</p>
                <div className="flex flex-wrap gap-1">
                  {ORDER_CONFIRMATION_FIELDS.map((f) => (
                    <button key={f} type="button" className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px]"
                      onClick={() => setSettings((s) => ({ ...s, confirmation_text: `${s.confirmation_text ?? ""}{{${f}}}` }))}>
                      {`{{${f}}}`}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {settings.confirmation_mode === "template" && (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="order-confirm-template">{t("templateLabel")}</Label>
                  <Select value={templateKey}
                    onValueChange={(v) => {
                      if (!v) return;
                      const [name, language] = v.split("|");
                      setSettings((s) => ({ ...s, template_name: name, template_language: language || null, variable_map: {} }));
                    }}>
                    <SelectTrigger id="order-confirm-template"><SelectValue placeholder={t("templatePlaceholder")} /></SelectTrigger>
                    <SelectContent>
                      {templates.map((x) => (
                        <SelectItem key={x.id} value={`${x.name}|${x.language ?? ""}`}>{x.name} ({x.language})</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">{t("templateHelp")}</p>
                </div>
                {Array.from({ length: variables }, (_, i) => String(i + 1)).map((n) => (
                  <div key={n} className="flex items-center gap-2">
                    <span className="w-12 font-mono text-xs text-muted-foreground">{`{{${n}}}`}</span>
                    <Select value={settings.variable_map[n] ?? ""}
                      onValueChange={(field) => field && setSettings((s) => ({ ...s, variable_map: { ...s.variable_map, [n]: field } }))}>
                      <SelectTrigger aria-label={t("variableLabel", { n })}><SelectValue placeholder={t("variablePlaceholder")} /></SelectTrigger>
                      <SelectContent>
                        {ORDER_CONFIRMATION_FIELDS.map((f) => <SelectItem key={f} value={f}>{t(`fields.${f}`)}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
            )}
            {!canEdit && <p className="text-xs text-muted-foreground">{t("adminOnly")}</p>}
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          </fieldset>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
          {canEdit && (
            <Button onClick={save} disabled={loading || saving || textInvalid || templateInvalid}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("save")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
