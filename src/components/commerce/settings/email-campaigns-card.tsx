"use client";

/**
 * Commerce → Settings → Marketing → Email campaigns (store plan Phase 8, batch 6). An admin writes a campaign, picks an audience (a
 * saved segment, or everyone), sees how many of them may be emailed, and sends it. Only customers with an email address and recorded
 * consent (and who have not unsubscribed) receive it; the admin can record that an audience agreed (an attestation, kept with their
 * name and the time). A send is queued before this screen is told so, at a fixed rate; an uncertain send is shown as "not sure" and
 * never repeated. Agents see the list; only admins write.
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { authFetch } from "@/lib/auth/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { AudiencePreview, CampaignView } from "@/lib/commerce/email-campaigns";
import { EMAIL_LIMITS } from "@/lib/commerce/email-limits";

const selectClass = "h-9 w-full rounded-lg border border-border bg-card px-2 text-sm text-foreground";
type Segment = { id: string; name: string };

export function EmailCampaignsCard({ canEdit, connected }: { canEdit: boolean; connected: boolean }) {
  const t = useTranslations("Commerce.settings.marketing.campaigns");
  const te = useTranslations("Commerce.settings.errors");
  const [campaigns, setCampaigns] = useState<CampaignView[] | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [form, setForm] = useState({ name: "", subject: "", body: "", segment_id: "" });
  const [preview, setPreview] = useState<AudiencePreview | null>(null);
  const [attest, setAttest] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await authFetch("/api/commerce/email-campaigns", { cache: "no-store" }).catch(() => null);
    if (res?.ok) setCampaigns(((await res.json()) as { campaigns: CampaignView[] }).campaigns);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load on mount, as the other settings panels do
    void load();
    authFetch("/api/segments", { cache: "no-store" }).then(async (res) => { if (res.ok) setSegments(((await res.json()) as { segments: Segment[] }).segments); }).catch(() => undefined);
  }, [load]);
  useEffect(() => {
    const query = form.segment_id ? `?segment_id=${encodeURIComponent(form.segment_id)}` : "";
    authFetch(`/api/commerce/email-campaigns/audience${query}`, { cache: "no-store" })
      .then(async (res) => setPreview(res.ok ? ((await res.json()) as { audience: AudiencePreview }).audience : null))
      .catch(() => setPreview(null));
  }, [form.segment_id, campaigns]);

  const fail = (data: { code?: string }) => toast.error(data.code && te.has(data.code as never) ? te(data.code as never) : te("invalid"));
  const call = async (key: string, url: string, body?: unknown): Promise<Record<string, unknown> | null> => {
    setBusy(key);
    const res = await authFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).catch(() => null);
    setBusy(null);
    const data = (await res?.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res?.ok) { fail(data as { code?: string }); return null; }
    return data;
  };

  const create = async () => {
    const data = await call("create", "/api/commerce/email-campaigns", { name: form.name, subject: form.subject, body: form.body, segment_id: form.segment_id || null });
    if (!data) return;
    setForm({ name: "", subject: "", body: "", segment_id: form.segment_id });
    toast.success(t("created"));
    await load();
  };
  const send = async (id: string) => {
    setConfirm(null);
    if (await call(`send:${id}`, `/api/commerce/email-campaigns/${id}/send`)) { toast.success(t("queued")); await load(); }
  };
  const cancel = async (id: string) => { if (await call(`cancel:${id}`, `/api/commerce/email-campaigns/${id}/cancel`)) await load(); };
  const recordConsent = async () => {
    const data = await call("consent", "/api/commerce/email-consent", { attest: true, segment_id: form.segment_id || null });
    if (!data) return;
    setAttest(false);
    toast.success(t("consentRecorded", { count: Number(data.recorded ?? 0) }));
    await load();
  };

  const valid = form.name.trim() && form.subject.trim() && form.body.trim();
  return (
    <Card id="email-campaigns">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("hint")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {!connected && <p role="status" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">{t("notConnected")}</p>}

        {canEdit && (
          <div className="space-y-3 rounded-xl border border-border p-4">
            <h3 className="text-sm font-medium">{t("newTitle")}</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="ec-name">{t("name")}</Label>
                <Input id="ec-name" maxLength={EMAIL_LIMITS.name} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ec-audience">{t("audience")}</Label>
                <select id="ec-audience" className={selectClass} value={form.segment_id} onChange={(e) => setForm({ ...form, segment_id: e.target.value })}>
                  <option value="">{t("everyone")}</option>
                  {segments.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="ec-subject">{t("subject")}</Label>
                <Input id="ec-subject" maxLength={EMAIL_LIMITS.subject} value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="ec-body">{t("body")}</Label>
                <Textarea id="ec-body" rows={6} maxLength={EMAIL_LIMITS.body} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
                <p className="text-xs text-muted-foreground">{t("bodyHint")}</p>
              </div>
            </div>
            {preview && (
              <p className="text-sm" aria-live="polite">{t("audienceCounts", { audience: preview.audience, withEmail: preview.withEmail, eligible: preview.eligible, unsubscribed: preview.unsubscribed })}</p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={create} disabled={!valid || busy === "create"}>
                {busy === "create" && <Loader2 className="size-4 animate-spin" />}{t("saveDraft")}
              </Button>
            </div>
            <div className="space-y-2 rounded-lg bg-muted/50 p-3">
              <div className="flex items-start gap-2">
                <Checkbox id="ec-attest" checked={attest} onCheckedChange={(v) => setAttest(v === true)} />
                <Label htmlFor="ec-attest" className="text-sm leading-snug">{t("attest")}</Label>
              </div>
              <Button variant="outline" size="sm" onClick={recordConsent} disabled={!attest || busy === "consent"}>
                {busy === "consent" && <Loader2 className="size-4 animate-spin" />}{t("recordConsent")}
              </Button>
              <p className="text-xs text-muted-foreground">{t("consentHint")}</p>
            </div>
          </div>
        )}

        {campaigns && campaigns.length === 0 && <p className="text-sm text-muted-foreground">{t("none")}</p>}
        <ul className="space-y-3">
          {(campaigns ?? []).map((c) => (
            <li key={c.id} className="space-y-2 rounded-xl border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{c.name}</span>
                <Badge variant="secondary">{t(`status.${c.status}`)}</Badge>
                <span className="text-xs text-muted-foreground">{c.segment_name ?? t("everyone")}</span>
              </div>
              <p className="text-sm text-muted-foreground">{c.subject}</p>
              {c.queued_at && (
                <p className="text-xs" data-testid="campaign-counts">
                  {t("counts", { total: c.recipient_count, sent: c.counts.sent, waiting: c.counts.queued + c.counts.sending, skipped: c.counts.skipped + c.counts.failed })}
                </p>
              )}
              {c.counts.unknown > 0 && <p role="alert" className="text-xs font-medium text-amber-700 dark:text-amber-300">{t("unknown", { count: c.counts.unknown })}</p>}
              {canEdit && (
                <div className="flex flex-wrap gap-2">
                  {c.status === "draft" && (confirm === c.id
                    ? <>
                        <Button size="sm" onClick={() => send(c.id)} disabled={busy === `send:${c.id}`}>{t("confirmSend")}</Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>{t("back")}</Button>
                      </>
                    : <Button size="sm" variant="outline" disabled={!connected} onClick={() => setConfirm(c.id)}>{t("send")}</Button>)}
                  {c.status === "sending" && (
                    <>
                      <Button size="sm" variant="outline" onClick={() => send(c.id)} disabled={busy === `send:${c.id}`}>{t("requeue")}</Button>
                      <Button size="sm" variant="ghost" onClick={() => cancel(c.id)} disabled={busy === `cancel:${c.id}`}>{t("cancel")}</Button>
                    </>
                  )}
                  {c.status === "draft" && <Button size="sm" variant="ghost" onClick={() => cancel(c.id)}>{t("discard")}</Button>}
                </div>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
