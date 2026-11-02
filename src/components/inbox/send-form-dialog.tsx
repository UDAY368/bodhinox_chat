"use client";

/**
 * "Send form" from the inbox: pick a published WhatsApp form, write the
 * message and button text, send. The server refuses an unpublished form,
 * a blocked contact or a closed 24-hour window; its message is shown as is.
 */

import { useEffect, useState } from "react";
import { Loader2, Send } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { authFetch } from "@/lib/auth/client";

const CTA_MAX = 30;
const BODY_MAX = 1024;
const LINE_MAX = 60;

/**
 * Whether a failed send should get a new client_request_id before the next
 * try. A definite refusal (a 4xx, which the server answers before sending,
 * or 502, Meta's own rejection) sent nothing, so the next try is a new send;
 * reusing the id would hit the failed intent and look "uncertain". The
 * uncertain 409 (the only 409 without a refusal code), any other 5xx and a
 * network failure keep the id, so an unknown outcome is never re-sent.
 */
export function sendFormRejectedDefinitely(status: number, code: unknown): boolean {
  if (status === 502) return true;
  if (status < 400 || status >= 500) return false;
  return status !== 409 || typeof code === "string";
}

interface PublishedForm {
  id: string;
  name: string;
  status: string;
}

export function SendFormDialog({ open, onOpenChange, conversationId }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
}) {
  const t = useTranslations("Inbox.sendForm");
  const [forms, setForms] = useState<PublishedForm[] | null>(null);
  const [formId, setFormId] = useState("");
  const [body, setBody] = useState("");
  const [cta, setCta] = useState("");
  const [header, setHeader] = useState("");
  const [footer, setFooter] = useState("");
  const [sending, setSending] = useState(false);
  // One id per send: a double click or a retry after an unknown outcome
  // never sends twice; a definite refusal gets a new one (see above).
  const [requestId, setRequestId] = useState("");

  useEffect(() => {
    if (!open) return;
    setRequestId(crypto.randomUUID());
    let cancelled = false;
    authFetch("/api/whatsapp/forms", { cache: "no-store" })
      .then(async (res) => (res.ok ? ((await res.json()) as { forms?: PublishedForm[] }).forms ?? [] : []))
      .catch(() => [] as PublishedForm[])
      .then((list) => !cancelled && setForms(list.filter((f) => f.status === "published")));
    return () => {
      cancelled = true;
    };
  }, [open]);

  const ready = Boolean(formId && body.trim() && cta.trim() && requestId) && !sending;

  const send = async () => {
    if (!ready) return;
    setSending(true);
    try {
      const res = await authFetch("/api/whatsapp/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversation_id: conversationId,
          message_type: "form",
          form_id: formId,
          content_text: body,
          form_cta: cta,
          form_header: header || undefined,
          form_footer: footer || undefined,
          client_request_id: requestId,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
      if (!res.ok) {
        if (sendFormRejectedDefinitely(res.status, json.code)) setRequestId(crypto.randomUUID());
        toast.error(json.error || t("failed"));
        return;
      }
      toast.success(t("sent"));
      setBody("");
      setCta("");
      setHeader("");
      setFooter("");
      onOpenChange(false);
    } catch {
      toast.error(t("failed"));
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="send-form-form" className="mb-1 block text-xs text-muted-foreground">{t("form")}</Label>
            <Select value={formId} onValueChange={(v) => setFormId(v ?? "")}>
              <SelectTrigger id="send-form-form" className="w-full"><SelectValue placeholder={t("pickForm")} /></SelectTrigger>
              <SelectContent>
                {(forms ?? []).map((f) => <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>)}
              </SelectContent>
            </Select>
            {forms !== null && forms.length === 0 && <p className="mt-1 text-xs text-muted-foreground">{t("noForms")}</p>}
          </div>
          <div>
            <Label htmlFor="send-form-header" className="mb-1 block text-xs text-muted-foreground">{t("header", { max: LINE_MAX })}</Label>
            <Input id="send-form-header" value={header} maxLength={LINE_MAX} onChange={(e) => setHeader(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="send-form-body" className="mb-1 block text-xs text-muted-foreground">{t("body", { max: BODY_MAX })}</Label>
            <Textarea id="send-form-body" value={body} maxLength={BODY_MAX} rows={3} onChange={(e) => setBody(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="send-form-footer" className="mb-1 block text-xs text-muted-foreground">{t("footer", { max: LINE_MAX })}</Label>
            <Input id="send-form-footer" value={footer} maxLength={LINE_MAX} onChange={(e) => setFooter(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="send-form-cta" className="mb-1 block text-xs text-muted-foreground">{t("cta", { max: CTA_MAX })}</Label>
            <Input id="send-form-cta" value={cta} maxLength={CTA_MAX} onChange={(e) => setCta(e.target.value)} placeholder={t("ctaPlaceholder")} />
          </div>
          <p className="text-xs text-muted-foreground">{t("windowHelp")}</p>
        </div>
        <DialogFooter>
          <Button onClick={() => void send()} disabled={!ready}>
            {sending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Send className="mr-1 h-4 w-4" />}
            {t("send")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
