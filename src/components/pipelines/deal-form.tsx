"use client";

/**
 * The deal panel (Sales → Pipeline). A new deal is a form with Create. An
 * existing deal saves each field as it changes (text fields when they lose
 * focus), keeps author-stamped team notes (add, delete your own; admins any),
 * shows the contact with Contact and Chat shortcuts, and makes a payment link
 * from the deal (sent into the contact's chat through the payment links API,
 * so the 24-hour window rule and the durable send apply). Won, lost and
 * reopen stay one click; delete asks first.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useFormatter } from "next-intl";
import { createClient } from "@/lib/data/client";
import { authFetch } from "@/lib/auth/client";
import { useAuth } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import { CURRENCIES } from "@/lib/currency";
import { searchContacts, type ContactOption } from "@/lib/contacts/contact-search";
import type {
  Conversation,
  Deal,
  DealStatus,
  Pipeline,
  PipelineStage,
  Profile,
} from "@/types";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CreatePaymentLinkDialog } from "@/components/commerce/payments/create-payment-link-dialog";
import {
  Check,
  X,
  Trash2,
  MessageSquare,
  DollarSign,
  Link2,
  Loader2,
  Plus,
  User,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

export interface DealContactChoice {
  id: string;
  name?: string | null;
  phone?: string | null;
}

interface DealFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deal?: Deal | null;
  pipelineId: string;
  stages: PipelineStage[];
  defaultStageId?: string;
  /** A new deal starts with this contact chosen (the chat composer, a contact profile). */
  defaultContact?: DealContactChoice;
  /** A new deal may pick its pipeline here (NewDealSheet); the board page fixes it instead. */
  pipelineChoice?: { pipelines: Pick<Pipeline, "id" | "name">[]; onChange: (pipelineId: string) => void };
  /** Called after a save; a new deal passes its id. */
  onSaved: (dealId?: string) => void;
  /** Asks the page to confirm and delete the deal. */
  onDelete?: (deal: Deal) => void;
}

interface DealNote {
  id: string;
  body: string;
  created_by: string | null;
  author_name: string | null;
  created_at: string;
}

/** Matches the database check on deals.lost_reason. */
const LOST_REASON_MAX = 200;

const selectClass =
  "h-9 w-full rounded-lg border border-border bg-card px-2.5 text-sm text-foreground outline-none transition-[border-color,box-shadow] duration-150 focus:border-primary focus:ring-3 focus:ring-ring/30";

type Field = "title" | "value" | "currency" | "contact_id" | "stage_id" | "assigned_to" | "expected_close_date" | "notes";

export function DealForm({
  open,
  onOpenChange,
  deal,
  pipelineId,
  stages,
  defaultStageId,
  defaultContact,
  pipelineChoice,
  onSaved,
  onDelete,
}: DealFormProps) {
  const t = useTranslations("Pipelines.form");
  const ts = useTranslations("Sales.deal");
  const format = useFormatter();
  const db = createClient();
  const { accountId, defaultCurrency, user } = useAuth();
  const canWrite = useCan("send-messages");
  const isAdmin = useCan("edit-settings");

  const [title, setTitle] = useState("");
  const [value, setValue] = useState("");
  const [currency, setCurrency] = useState(defaultCurrency);
  const [contactId, setContactId] = useState("");
  const [stageId, setStageId] = useState("");
  const [assignedTo, setAssignedTo] = useState("");
  const [expectedCloseDate, setExpectedCloseDate] = useState("");
  const [notes, setNotes] = useState("");

  // The picker shows up to 20 contacts matching the search (name or phone), never the whole list.
  const [contactSearch, setContactSearch] = useState("");
  const [contactOptions, setContactOptions] = useState<ContactOption[]>([]);
  const [contact, setContact] = useState<ContactOption | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [linkedConversation, setLinkedConversation] =
    useState<Conversation | null>(null);

  const [saving, setSaving] = useState(false);
  const [savedField, setSavedField] = useState<"saving" | "saved" | null>(null);
  const [statusAction, setStatusAction] = useState<DealStatus | null>(null);
  const [status, setStatus] = useState<DealStatus>("open");
  const [lostReason, setLostReason] = useState("");
  const [lostOpen, setLostOpen] = useState(false);
  const [lostDraft, setLostDraft] = useState("");

  const [teamNotes, setTeamNotes] = useState<DealNote[]>([]);
  const [noteDraft, setNoteDraft] = useState("");
  const [noteError, setNoteError] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);

  // Reset the form fields every time the sheet opens or its input
  // props change. This is a legitimate prop-driven sync; the rule is
  // over-cautious here, hence the block-level disable.
   
  useEffect(() => {
    if (!open) return;
    setSavedField(null);
    setNoteDraft("");
    setNoteError("");
    setContactSearch("");
    if (deal) {
      setTitle(deal.title);
      setValue(String(deal.value ?? ""));
      setCurrency(deal.currency || defaultCurrency);
      // contact_id is nullable when the contact has been deleted
      // (migration 004: ON DELETE SET NULL). "" means "no selection".
      setContactId(deal.contact_id ?? "");
      setStageId(deal.stage_id);
      setAssignedTo(deal.assigned_to ?? "");
      setExpectedCloseDate(deal.expected_close_date ?? "");
      setNotes(deal.notes ?? "");
      setStatus(deal.status ?? "open");
      setLostReason(deal.lost_reason ?? "");
    } else {
      setTitle("");
      setValue("");
      setCurrency(defaultCurrency);
      setContactId(defaultContact?.id ?? "");
      setLostReason("");
      setStageId(defaultStageId || stages[0]?.id || "");
      setAssignedTo("");
      setExpectedCloseDate("");
      setNotes("");
      setStatus("open");
      setTeamNotes([]);
    }
    // Stages are left out on purpose: a new deal keeps what was typed when its pipeline
    // (and so its stage list) changes; the effect below fixes up the stage instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, deal, defaultCurrency, defaultContact?.id]);

  // A new deal's stage follows its pipeline's stage list (NewDealSheet loads it after opening).
  useEffect(() => {
    if (!open || deal || stages.some((s) => s.id === stageId)) return;
    setStageId(defaultStageId && stages.some((s) => s.id === defaultStageId) ? defaultStageId : stages[0]?.id ?? "");
  }, [open, deal, stages, stageId, defaultStageId]);
   

  // Load supporting data once the sheet is open
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const p = await db.from("profiles").select("*").order("full_name");
      if (cancelled) return;
      setProfiles((p.data ?? []) as Profile[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, db]);

  // Contact search waits 300ms after typing.
  useEffect(() => {
    if (!open) return;
    let live = true;
    const timer = setTimeout(() => {
      searchContacts(contactSearch)
        .then((rows) => { if (live) setContactOptions(rows); })
        .catch(() => { if (live) toast.error(ts("contactSearchFailed")); });
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [open, contactSearch, ts]);

  // The chosen contact, which may not be among the search results.
  useEffect(() => {
    if (!open || !contactId) {
      setContact(null);
      return;
    }
    if (contact?.id === contactId) return;
    // A preselected contact (from the chat or a profile) or the deal's own contact needs no lookup.
    const known = (!deal && defaultContact?.id === contactId ? defaultContact : null)
      ?? (deal?.contact && deal.contact.id === contactId ? deal.contact : null);
    if (known) {
      setContact({ id: known.id, name: known.name ?? null, phone: known.phone ?? null });
      return;
    }
    let cancelled = false;
    void db.from("contacts").select("id,name,phone").eq("id", contactId).maybeSingle()
      .then(({ data }) => { if (!cancelled) setContact((data as ContactOption | null) ?? null); });
    return () => {
      cancelled = true;
    };
  }, [open, contactId, contact?.id, db, deal, defaultContact]);

  const chooseContact = (id: string) => {
    setContactId(id);
    setContact(contactOptions.find((c) => c.id === id) ?? null);
    if (deal) void saveField("contact_id", id);
  };

  const loadNotes = useCallback(async (dealId: string) => {
    const res = await authFetch(`/api/deals/${encodeURIComponent(dealId)}/notes`, { cache: "no-store" });
    if (!res.ok) return;
    const body = (await res.json().catch(() => ({}))) as { notes?: DealNote[] };
    setTeamNotes(body.notes ?? []);
  }, []);

  useEffect(() => {
    if (!open || !deal) return;
    void loadNotes(deal.id);
  }, [open, deal, loadNotes]);

  // Fetch linked conversation for the selected contact (newest open one).
  // Clearing on no-selection is sync with prop state; the populated
  // case runs setLinkedConversation inside the async fetch callback.
  useEffect(() => {
    if (!open || !contactId) {
       
      setLinkedConversation(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data } = await db
        .from("conversations")
        .select("*")
        .eq("contact_id", contactId)
        .order("last_message_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cancelled) return;
      setLinkedConversation((data as Conversation | null) ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, contactId, db]);

  const editing = Boolean(deal);

  /** Existing deal: save one field now. Text fields call it on blur, selects on change. */
  async function saveField(field: Field, raw: string) {
    if (!deal || !canWrite) return;
    if (field === "title" && !raw.trim()) {
      setTitle(deal.title);
      toast.error(t("toastRequired"));
      return;
    }
    if (field === "contact_id" && !raw) {
      toast.error(t("toastRequired"));
      return;
    }
    const valueOf: Record<Field, unknown> = {
      title: raw.trim(),
      value: parseFloat(raw) || 0,
      currency: raw,
      contact_id: raw,
      stage_id: raw,
      assigned_to: raw || null,
      expected_close_date: raw || null,
      notes: raw.trim() || null,
    };
    setSavedField("saving");
    const { error } = await db.from("deals").update({ [field]: valueOf[field] }).eq("id", deal.id);
    if (error) {
      setSavedField(null);
      toast.error(ts("saveFailed"));
      return;
    }
    setSavedField("saved");
    onSaved();
  }

  async function handleCreate() {
    if (!title.trim() || !contactId || !stageId) {
      toast.error(t("toastRequired"));
      return;
    }
    setSaving(true);
    const {
      data: { session },
    } = await db.auth.getSession();
    const sessionUser = session?.user;
    if (!sessionUser) {
      toast.error(t("toastNotSignedIn"));
      setSaving(false);
      return;
    }
    if (!accountId) {
      toast.error(t("toastNotLinked"));
      setSaving(false);
      return;
    }
    const { data: created, error } = await db.from("deals").insert({
      title: title.trim(),
      value: parseFloat(value) || 0,
      currency,
      contact_id: contactId,
      pipeline_id: pipelineId,
      stage_id: stageId,
      assigned_to: assignedTo || null,
      notes: notes.trim() || null,
      expected_close_date: expectedCloseDate || null,
      user_id: sessionUser.id,
      account_id: accountId,
      status: "open",
    }).select("id").single();
    setSaving(false);
    if (error || !created) {
      toast.error(t("toastFailedCreate"));
      return;
    }
    toast.success(t("toastCreated"));
    onOpenChange(false);
    onSaved((created as { id: string }).id);
  }

  /** Won, lost (with an optional reason) or reopen. The database sets closed_at and clears the reason when not lost. */
  async function handleStatusChange(next: DealStatus, reason?: string) {
    if (!deal) return;
    setStatusAction(next);
    const lost = next === "lost" ? (reason ?? "").trim().slice(0, LOST_REASON_MAX) || null : null;
    const { error } = await db.from("deals").update({ status: next, lost_reason: lost }).eq("id", deal.id);
    setStatusAction(null);
    if (error) {
      toast.error(t("toastFailedStatus"));
      return;
    }
    setStatus(next);
    setLostReason(lost ?? "");
    setLostOpen(false);
    toast.success(
      next === "won" ? t("toastMarkedWon") : next === "lost" ? t("toastMarkedLost") : t("toastReopened"),
    );
    onSaved();
  }

  async function addNote() {
    if (!deal) return;
    const body = noteDraft.trim();
    if (!body) {
      setNoteError(ts("noteEmpty"));
      return;
    }
    setNoteBusy(true);
    setNoteError("");
    try {
      const res = await authFetch(`/api/deals/${encodeURIComponent(deal.id)}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (!res.ok) {
        toast.error(ts("noteFailed"));
        return;
      }
      const json = (await res.json()) as { note: DealNote };
      setTeamNotes((prev) => [json.note, ...prev]);
      setNoteDraft("");
      toast.success(ts("noteAdded"));
    } catch {
      toast.error(ts("noteFailed"));
    } finally {
      setNoteBusy(false);
    }
  }

  async function deleteNote(note: DealNote) {
    if (!deal) return;
    const res = await authFetch(`/api/deals/${encodeURIComponent(deal.id)}/notes/${encodeURIComponent(note.id)}`, { method: "DELETE" });
    if (!res.ok) {
      toast.error(ts("noteFailed"));
      return;
    }
    setTeamNotes((prev) => prev.filter((n) => n.id !== note.id));
    toast.success(ts("noteDeleted"));
  }

  const readOnly = !canWrite;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="bg-popover border-border text-popover-foreground sm:max-w-lg w-full p-0"
      >
        <div className="flex h-full min-h-0 flex-col">
          <SheetHeader className="border-b border-border/50 p-4 pr-12">
            <SheetTitle className="text-popover-foreground">
              {deal ? t("editDeal") : t("newDeal")}
            </SheetTitle>
            {editing && (
              <SheetDescription className="text-xs" aria-live="polite">
                {savedField === "saving" ? ts("saving") : savedField === "saved" ? ts("saved") : ts("autosaveHint")}
              </SheetDescription>
            )}
          </SheetHeader>

          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {editing && status !== "open" && (
              <div className={`rounded-xl px-3 py-2 text-sm ${status === "won" ? "bg-emerald-500/10" : "bg-destructive/10"}`}>
                <p className="font-medium">{status === "won" ? ts("closedWon") : ts("closedLost")}</p>
                {status === "lost" && lostReason && (
                  <p className="mt-0.5 break-words text-muted-foreground">{ts("lostReasonShown", { reason: lostReason })}</p>
                )}
              </div>
            )}
            <div className="grid gap-2">
              <Label htmlFor="deal-title" className="text-muted-foreground">{t("title")}</Label>
              <Input
                id="deal-title"
                value={title}
                readOnly={readOnly}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={() => editing && deal && title.trim() !== deal.title && void saveField("title", title)}
                placeholder={t("titlePlaceholder")}
                className="border-border bg-card text-foreground"
              />
            </div>

            <div className="grid grid-cols-[minmax(0,1fr)_110px] gap-3">
              <div className="grid gap-2">
                <Label htmlFor="deal-value" className="text-muted-foreground">{t("value")}</Label>
                <div className="relative">
                  <DollarSign className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="deal-value"
                    type="number"
                    min={0}
                    value={value}
                    readOnly={readOnly}
                    onChange={(e) => setValue(e.target.value)}
                    onBlur={() => editing && deal && (parseFloat(value) || 0) !== Number(deal.value || 0) && void saveField("value", value)}
                    placeholder="0"
                    className="border-border bg-card pl-7 text-foreground"
                  />
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="deal-currency" className="text-muted-foreground">{t("currency")}</Label>
                <select
                  id="deal-currency"
                  value={currency}
                  disabled={readOnly}
                  onChange={(e) => { setCurrency(e.target.value); if (editing) void saveField("currency", e.target.value); }}
                  className={selectClass}
                >
                  {CURRENCIES.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.code}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {!editing && pipelineChoice && pipelineChoice.pipelines.length > 1 && (
              <div className="grid gap-2">
                <Label htmlFor="deal-pipeline" className="text-muted-foreground">{ts("pipeline")}</Label>
                <select
                  id="deal-pipeline"
                  value={pipelineId}
                  onChange={(e) => pipelineChoice.onChange(e.target.value)}
                  className={selectClass}
                >
                  {pipelineChoice.pipelines.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="deal-stage" className="text-muted-foreground">{t("stage")}</Label>
                <select
                  id="deal-stage"
                  value={stageId}
                  disabled={readOnly}
                  onChange={(e) => { setStageId(e.target.value); if (editing) void saveField("stage_id", e.target.value); }}
                  className={selectClass}
                >
                  {stages.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="deal-owner" className="text-muted-foreground">{t("assignedTo")}</Label>
                <select
                  id="deal-owner"
                  value={assignedTo}
                  disabled={readOnly}
                  onChange={(e) => { setAssignedTo(e.target.value); if (editing) void saveField("assigned_to", e.target.value); }}
                  className={selectClass}
                >
                  <option value="">{t("unassigned")}</option>
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.full_name || p.email}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="deal-close" className="text-muted-foreground">{t("expectedCloseDate")}</Label>
              <Input
                id="deal-close"
                type="date"
                value={expectedCloseDate}
                readOnly={readOnly}
                onChange={(e) => { setExpectedCloseDate(e.target.value); if (editing) void saveField("expected_close_date", e.target.value); }}
                className="border-border bg-card text-foreground"
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="deal-contact" className="text-muted-foreground">{t("contact")}</Label>
              {!readOnly && (
                <Input
                  type="search"
                  value={contactSearch}
                  onChange={(e) => setContactSearch(e.target.value)}
                  placeholder={ts("contactSearchPlaceholder")}
                  aria-label={ts("contactSearchPlaceholder")}
                  maxLength={80}
                  className="border-border bg-card text-foreground"
                />
              )}
              <select
                id="deal-contact"
                value={contactId}
                disabled={readOnly}
                onChange={(e) => chooseContact(e.target.value)}
                className={selectClass}
              >
                <option value="">{t("selectContact")}</option>
                {contact && !contactOptions.some((c) => c.id === contact.id) && (
                  <option value={contact.id}>{contact.name || contact.phone}</option>
                )}
                {contactOptions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name && c.phone ? `${c.name} · ${c.phone}` : c.name || c.phone}
                  </option>
                ))}
              </select>
              {contact && (
                <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border p-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold" aria-hidden>
                    {(contact.name || contact.phone || "?").charAt(0).toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{contact.name || contact.phone}</p>
                    {contact.phone && <p className="truncate text-xs text-muted-foreground">{contact.phone}</p>}
                  </div>
                  <div className="flex gap-1.5">
                    <Link href={`/contacts?contact=${encodeURIComponent(contact.id)}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                      <User className="h-3.5 w-3.5" /> {ts("contactButton")}
                    </Link>
                    {linkedConversation && (
                      <Link href={`/inbox?c=${encodeURIComponent(linkedConversation.id)}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                        <MessageSquare className="h-3.5 w-3.5" /> {ts("chatButton")}
                      </Link>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="grid gap-2">
              <Label htmlFor="deal-summary" className="text-muted-foreground">{ts("summary")}</Label>
              <Textarea
                id="deal-summary"
                value={notes}
                readOnly={readOnly}
                onChange={(e) => setNotes(e.target.value)}
                onBlur={() => editing && deal && notes.trim() !== (deal.notes ?? "").trim() && void saveField("notes", notes)}
                placeholder={t("notesPlaceholder")}
                className="min-h-[72px] border-border bg-card text-foreground"
              />
            </div>

            {deal && (
              <section className="space-y-2" aria-labelledby="deal-team-notes">
                <h3 id="deal-team-notes" className="text-[13px] font-semibold text-muted-foreground">{ts("teamNotes")}</h3>
                {teamNotes.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{ts("noNotes")}</p>
                ) : (
                  <ul className="space-y-2">
                    {teamNotes.map((n) => (
                      <li key={n.id} className="relative rounded-xl bg-amber-500/10 py-2 pr-9 pl-3 text-sm">
                        <p className="whitespace-pre-wrap break-words">{n.body}</p>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {n.author_name || ts("teamMember")} · {format.dateTime(new Date(n.created_at), { dateStyle: "medium", timeStyle: "short" })}
                        </p>
                        {canWrite && (n.created_by === user?.id || isAdmin) && (
                          <Button type="button" variant="ghost" size="icon-xs" className="absolute top-1.5 right-1.5"
                            aria-label={ts("deleteNote")} onClick={() => void deleteNote(n)}>
                            <X className="h-3 w-3" />
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {canWrite && (
                  <div className="space-y-2">
                    <Label htmlFor="deal-new-note" className="sr-only">{ts("notePlaceholder")}</Label>
                    <Textarea
                      id="deal-new-note"
                      rows={2}
                      maxLength={2000}
                      value={noteDraft}
                      aria-invalid={noteError ? true : undefined}
                      onChange={(e) => setNoteDraft(e.target.value)}
                      placeholder={ts("notePlaceholder")}
                      className="border-border bg-card text-foreground"
                    />
                    {noteError && <p className="text-xs font-medium text-destructive">{noteError}</p>}
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" size="sm" variant="outline" disabled={noteBusy} onClick={() => void addNote()}>
                        {noteBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} {ts("addNote")}
                      </Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => setLinkOpen(true)}>
                        <Link2 className="h-3.5 w-3.5" /> {ts("paymentLink")}
                      </Button>
                    </div>
                  </div>
                )}
              </section>
            )}
          </div>

          <div className="border-t border-border bg-popover p-4">
            {editing && deal ? (
              <div className="flex flex-wrap items-center gap-2">
                {canWrite && onDelete && (
                  <Button type="button" variant="ghost" className="text-destructive" onClick={() => onDelete(deal)}>
                    <Trash2 className="h-4 w-4" /> {ts("delete")}
                  </Button>
                )}
                <span className="flex-1" />
                {canWrite && status !== "open" && (
                  <Button type="button" variant="ghost" disabled={!!statusAction} onClick={() => void handleStatusChange("open")}>
                    {t("reopenDeal")}
                  </Button>
                )}
                {canWrite && status !== "lost" && (
                  <Button type="button" variant="outline" disabled={!!statusAction} onClick={() => { setLostDraft(""); setLostOpen(true); }}>
                    {statusAction === "lost" ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />} {ts("markLost")}
                  </Button>
                )}
                {canWrite && status !== "won" && (
                  <Button type="button" disabled={!!statusAction} onClick={() => void handleStatusChange("won")}>
                    {statusAction === "won" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} {ts("markWon")}
                  </Button>
                )}
              </div>
            ) : (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  className="flex-1 border-border bg-transparent text-muted-foreground hover:bg-muted"
                >
                  {t("cancel")}
                </Button>
                <Button
                  onClick={() => void handleCreate()}
                  disabled={saving || !title.trim() || !contactId || !stageId}
                  className="flex-1"
                >
                  {saving ? t("saving") : t("createDeal")}
                </Button>
              </div>
            )}
          </div>
        </div>
      </SheetContent>
      {deal && (
        <ConfirmDialog
          open={lostOpen}
          onOpenChange={setLostOpen}
          title={ts("lostTitle")}
          destructive
          confirmLabel={ts("markLost")}
          onConfirm={() => handleStatusChange("lost", lostDraft)}
          body={
            <div className="grid gap-2">
              <p>{ts("lostBody")}</p>
              <Label htmlFor="deal-lost-reason" className="text-foreground">{ts("lostReason")}</Label>
              <Input
                id="deal-lost-reason"
                value={lostDraft}
                maxLength={LOST_REASON_MAX}
                onChange={(e) => setLostDraft(e.target.value)}
                placeholder={ts("lostReasonPlaceholder")}
              />
            </div>
          }
        />
      )}
      {deal && (
        <CreatePaymentLinkDialog
          open={linkOpen}
          onOpenChange={setLinkOpen}
          initialAmount={String(Number(value || deal.value || 0) || "")}
          initialCurrency={currency || deal.currency}
          initialDescription={title || deal.title}
          contactId={contactId || undefined}
          conversationId={linkedConversation?.id}
        />
      )}
    </Sheet>
  );
}
