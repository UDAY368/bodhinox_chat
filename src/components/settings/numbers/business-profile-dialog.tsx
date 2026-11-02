"use client";

/**
 * A number's WhatsApp business profile (about, address, description, email,
 * websites, category, photo). Reads from Meta on open; saving sends the
 * changed fields to Meta and shows Meta's fresh copy. Members see it read
 * only; admins edit. Mount it per number from the numbers list.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { authFetch } from "@/lib/auth/client";
import {
  BUSINESS_PROFILE_LIMITS as LIMITS,
  BUSINESS_VERTICALS,
  PROFILE_PHOTO_TYPES,
  validateProfilePhoto,
  type BusinessProfile,
} from "@/lib/whatsapp/business-profile";

type Form = { about: string; address: string; description: string; email: string; website1: string; website2: string; vertical: string };

const toForm = (p: BusinessProfile): Form => ({
  about: p.about,
  address: p.address,
  description: p.description,
  email: p.email,
  website1: p.websites[0] ?? "",
  website2: p.websites[1] ?? "",
  vertical: p.vertical,
});

export function BusinessProfileDialog({
  numberId,
  numberLabel,
  open,
  onOpenChange,
  canEdit,
}: {
  numberId: string;
  numberLabel?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canEdit: boolean;
}) {
  const t = useTranslations("Settings.businessProfile");
  const [profile, setProfile] = useState<BusinessProfile | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [photo, setPhoto] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const url = `/api/whatsapp/numbers/${encodeURIComponent(numberId)}/profile`;

  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true);
    setLoadError(null);
    setPhoto(null);
    authFetch(url, { cache: "no-store" })
      .then(async (r) => {
        const json = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(typeof json.error === "string" ? json.error : t("loadFailed"));
        return json.profile as BusinessProfile;
      })
      .then((p) => { if (live) { setProfile(p); setForm(toForm(p)); } })
      .catch((err) => { if (live) setLoadError(err instanceof Error ? err.message : t("loadFailed")); })
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [open, url, t]);

  const changes = useMemo(() => {
    if (!form || !profile) return {};
    const before = toForm(profile);
    const out: Record<string, unknown> = {};
    for (const key of ["about", "address", "description", "email", "vertical"] as const) {
      if (form[key].trim() !== before[key].trim()) out[key] = form[key].trim();
    }
    const sites = [form.website1, form.website2].map((s) => s.trim()).filter(Boolean);
    if (sites.join("\n") !== profile.websites.join("\n")) out.websites = sites;
    return out;
  }, [form, profile]);

  const dirty = Object.keys(changes).length > 0 || photo !== null;
  const editable = canEdit && !!form && !loadError;

  const pickPhoto = (file: File | null) => {
    if (!file) return setPhoto(null);
    const problem = validateProfilePhoto(file);
    if (problem) {
      toast.error(t(`photo.${problem}`));
      return;
    }
    setPhoto(file);
  };

  const save = async () => {
    setSaving(true);
    try {
      let init: RequestInit;
      if (photo) {
        const body = new FormData();
        body.set("profile", JSON.stringify(changes));
        body.set("photo", photo);
        init = { method: "PUT", body };
      } else {
        init = { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(changes) };
      }
      const res = await authFetch(url, init);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : t("saveFailed"));
      if (json.profile) {
        setProfile(json.profile);
        setForm(toForm(json.profile));
      }
      setPhoto(null);
      toast.success(t("saved"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const set = (key: keyof Form) => (e: { target: { value: string } }) =>
    setForm((f) => (f ? { ...f, [key]: e.target.value } : f));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{numberLabel ? t("descriptionFor", { number: numberLabel }) : t("description")}</DialogDescription>
        </DialogHeader>
        {loading ? (
          <Loader2 className="mx-auto size-5 animate-spin text-primary" />
        ) : loadError ? (
          <p className="text-sm text-destructive">{loadError}</p>
        ) : form ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              {profile?.profile_picture_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={profile.profile_picture_url} alt={t("photoAlt")} className="size-14 rounded-full object-cover" />
              ) : (
                <div className="size-14 rounded-full bg-muted" aria-hidden />
              )}
              {editable ? (
                <div className="space-y-1">
                  <Label htmlFor="bp-photo">{t("photo.label")}</Label>
                  <Input
                    id="bp-photo"
                    type="file"
                    accept={PROFILE_PHOTO_TYPES.join(",")}
                    onChange={(e) => pickPhoto(e.target.files?.[0] ?? null)}
                  />
                  <p className="text-xs text-muted-foreground">{t("photo.hint")}</p>
                </div>
              ) : null}
            </div>
            <Field id="bp-about" label={t("about")} count={form.about.length} max={LIMITS.about}>
              <Input id="bp-about" value={form.about} maxLength={LIMITS.about} onChange={set("about")} disabled={!editable} />
            </Field>
            <Field id="bp-description" label={t("descriptionField")} count={form.description.length} max={LIMITS.description}>
              <Textarea id="bp-description" value={form.description} maxLength={LIMITS.description} onChange={set("description")} disabled={!editable} rows={3} />
            </Field>
            <Field id="bp-address" label={t("address")} count={form.address.length} max={LIMITS.address}>
              <Input id="bp-address" value={form.address} maxLength={LIMITS.address} onChange={set("address")} disabled={!editable} />
            </Field>
            <Field id="bp-email" label={t("email")}>
              <Input id="bp-email" type="email" value={form.email} maxLength={LIMITS.email} onChange={set("email")} disabled={!editable} />
            </Field>
            <Field id="bp-website1" label={t("websites")}>
              <div className="space-y-2">
                <Input id="bp-website1" type="url" placeholder="https://" value={form.website1} maxLength={LIMITS.website} onChange={set("website1")} disabled={!editable} />
                <Input aria-label={t("website2")} type="url" placeholder="https://" value={form.website2} maxLength={LIMITS.website} onChange={set("website2")} disabled={!editable} />
              </div>
            </Field>
            <Field id="bp-vertical" label={t("vertical")}>
              <select
                id="bp-vertical"
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm text-foreground disabled:opacity-50"
                value={form.vertical}
                onChange={set("vertical")}
                disabled={!editable}
              >
                {form.vertical === "" ? <option value="">{t("verticalNone")}</option> : null}
                {BUSINESS_VERTICALS.map((v) => (
                  <option key={v} value={v}>{t(`verticals.${v}`)}</option>
                ))}
              </select>
            </Field>
          </div>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t("close")}</Button>
          {canEdit ? (
            <Button type="button" onClick={save} disabled={!editable || !dirty || saving}>
              {saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              {t("save")}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ id, label, count, max, children }: { id: string; label: string; count?: number; max?: number; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <Label htmlFor={id}>{label}</Label>
        {max !== undefined && count !== undefined ? (
          <span className="text-xs text-muted-foreground">{count}/{max}</span>
        ) : null}
      </div>
      {children}
    </div>
  );
}
