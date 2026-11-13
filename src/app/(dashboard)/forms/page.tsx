"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { toast } from "sonner";
import { ClipboardList, Copy, Loader2, Pencil, Plus, Search, Trash2 } from "lucide-react";

import { useCan } from "@/hooks/use-can";
import { Button } from "@/components/ui/button";
import { GatedButton } from "@/components/ui/gated-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FormStatusBadge } from "@/components/forms/form-status-badge";
import { CampaignEmpty, CampaignHeader, SearchField } from "@/components/broadcasts/campaign-ui";
import {
  createForm,
  deleteForm,
  duplicateForm,
  listForms,
  type FormListItem,
} from "@/components/forms/form-api";
import { singleFlight } from "@/components/forms/form-editing";
import { FORM_CATEGORIES, type FormCategory } from "@/lib/whatsapp/forms/types";

/**
 * WhatsApp Forms list. Every member can browse forms and their responses;
 * creating, duplicating and deleting is for admins (the API and RLS enforce
 * the same rule).
 */
export default function FormsPage() {
  const router = useRouter();
  const t = useTranslations("Forms.list");
  const tc = useTranslations("Campaigns");
  const tCat = useTranslations("Forms.categories");
  const tGate = useTranslations("GatedButton");
  const format = useFormatter();
  const canManage = useCan("edit-settings");

  const [forms, setForms] = useState<FormListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [category, setCategory] = useState<FormCategory>("LEAD_GENERATION");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<FormListItem | null>(null);
  const [query, setQuery] = useState("");
  const term = query.trim().toLowerCase();
  const visible = term ? forms.filter((f) => f.name.toLowerCase().includes(term)) : forms;
  const published = forms.filter((f) => f.status === "published").length;

  useEffect(() => {
    let cancelled = false;
    listForms()
      .then((rows) => !cancelled && setForms(rows))
      .catch(() => !cancelled && toast.error(t("loadError")))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [t]);

  // A double Enter fires twice before `creating` disables anything; the
  // second POST would hit the unique name and flash a false "name taken".
  const [createOnce] = useState(() => singleFlight((run: () => Promise<void>) => run()));

  function handleCreate() {
    return createOnce(createNow);
  }

  async function createNow() {
    if (!name.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const result = await createForm({ name: name.trim(), category });
      if (!result.ok) {
        setCreateError(result.errors[0]?.message ?? result.error ?? t("createError"));
        return;
      }
      setCreateOpen(false);
      router.push(`/forms/${result.form.id}`);
    } catch {
      setCreateError(t("createError"));
    } finally {
      setCreating(false);
    }
  }

  async function handleDuplicate(form: FormListItem) {
    setBusyId(form.id);
    try {
      const result = await duplicateForm(form.id);
      if (!result.ok) throw new Error(result.error ?? t("duplicateError"));
      toast.success(t("duplicateSuccess", { name: result.form.name }));
      router.push(`/forms/${result.form.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("duplicateError"));
    } finally {
      setBusyId(null);
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    const target = deleting;
    setBusyId(target.id);
    try {
      if (!(await deleteForm(target.id))) throw new Error();
      setForms((prev) => prev.filter((f) => f.id !== target.id));
      toast.success(t("deleteSuccess"));
      setDeleting(null);
    } catch {
      toast.error(t("deleteError"));
    } finally {
      setBusyId(null);
    }
  }

  function openCreate() {
    setName("");
    setCategory("LEAD_GENERATION");
    setCreateError(null);
    setCreateOpen(true);
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label={t("loading")} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <CampaignHeader
        title={tc("title")}
        description={tc("blurbs.forms")}
        actions={
          <GatedButton canAct={canManage} gateReason={tGate("reasons.manageForms")} onClick={openCreate} className="h-9 px-4">
            <Plus className="h-4 w-4" />
            {t("newForm")}
          </GatedButton>
        }
      />

      {forms.length > 0 && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">{tc("forms.summary", { count: forms.length, published })}</p>
          <SearchField ariaLabel={tc("forms.search")} placeholder={tc("forms.search")} value={query} onChange={setQuery} />
        </div>
      )}

      {forms.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-border bg-card px-6 py-12 text-center">
          <div className="flex size-13 items-center justify-center rounded-2xl bg-primary/10 text-primary" aria-hidden>
            <ClipboardList className="h-6 w-6" />
          </div>
          <h2 className="mt-3 text-[15px] font-semibold text-foreground">{t("emptyTitle")}</h2>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">{t("emptyDesc")}</p>
          <GatedButton canAct={canManage} gateReason={tGate("reasons.manageForms")} onClick={openCreate} variant="outline" className="mt-4">
            <Plus className="h-4 w-4" />
            {t("createFirst")}
          </GatedButton>
        </div>
      ) : visible.length === 0 ? (
        <CampaignEmpty
          icon={Search}
          title={tc("forms.noMatches")}
          description={tc("noMatchesHint")}
          action={<Button variant="outline" onClick={() => setQuery("")}>{tc("clearFilters")}</Button>}
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <Table>
            <TableHeader className="bg-muted">
              <TableRow className="border-border hover:bg-transparent">
                <TableHead className="h-9 px-4 text-xs font-semibold text-muted-foreground">{t("colName")}</TableHead>
                <TableHead className="hidden h-9 px-3 text-xs font-semibold text-muted-foreground md:table-cell">{t("colCategory")}</TableHead>
                <TableHead className="h-9 px-3 text-xs font-semibold text-muted-foreground">{t("colStatus")}</TableHead>
                <TableHead className="hidden h-9 px-3 text-right text-xs font-semibold text-muted-foreground sm:table-cell">{t("colResponses")}</TableHead>
                <TableHead className="hidden h-9 px-3 text-xs font-semibold text-muted-foreground lg:table-cell">{t("colUpdated")}</TableHead>
                <TableHead className="h-9 px-3 pr-4 text-right">
                  <span className="sr-only">{t("colActions")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((form) => (
                <TableRow key={form.id} className="border-border/70 transition-colors duration-150 hover:bg-muted/60">
                  <TableCell className="max-w-[18rem] px-4 py-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-primary/10 text-primary" aria-hidden>
                        <ClipboardList className="size-[18px]" />
                      </span>
                      <button
                        type="button"
                        onClick={() => router.push(`/forms/${form.id}`)}
                        className="min-w-0 truncate text-left font-semibold text-foreground transition-colors duration-150 hover:text-primary"
                      >
                        {form.name}
                      </button>
                    </div>
                  </TableCell>
                  <TableCell className="hidden px-3 text-muted-foreground md:table-cell">{tCat(form.category)}</TableCell>
                  <TableCell className="px-3">
                    <FormStatusBadge status={form.status} />
                  </TableCell>
                  <TableCell className="hidden px-3 text-right font-semibold tabular-nums sm:table-cell">
                    {form.response_count ?? 0}
                  </TableCell>
                  <TableCell className="hidden whitespace-nowrap px-3 text-muted-foreground lg:table-cell">
                    {format.dateTime(new Date(form.updated_at), { dateStyle: "medium" })}
                  </TableCell>
                  <TableCell className="px-3 pr-4">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("openNamed", { name: form.name })}
                        onClick={() => router.push(`/forms/${form.id}`)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <GatedButton
                        variant="ghost"
                        size="icon-sm"
                        canAct={canManage}
                        gateReason={tGate("reasons.manageForms")}
                        aria-label={t("duplicateNamed", { name: form.name })}
                        disabled={busyId === form.id}
                        onClick={() => handleDuplicate(form)}
                      >
                        {busyId === form.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Copy className="h-3.5 w-3.5" />}
                      </GatedButton>
                      <GatedButton
                        variant="ghost"
                        size="icon-sm"
                        canAct={canManage}
                        gateReason={tGate("reasons.manageForms")}
                        aria-label={t("deleteNamed", { name: form.name })}
                        className="text-destructive hover:bg-destructive/10"
                        onClick={() => setDeleting(form)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </GatedButton>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="bg-popover text-popover-foreground sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("createTitle")}</DialogTitle>
            <DialogDescription className="text-muted-foreground">{t("createDesc")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="form-create-name">{t("nameLabel")}</Label>
              <Input
                id="form-create-name"
                value={name}
                maxLength={200}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("namePlaceholder")}
                className="bg-muted"
                readOnly={creating}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !creating) void handleCreate();
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="form-create-category">{t("categoryLabel")}</Label>
              <select
                id="form-create-category"
                value={category}
                onChange={(e) => setCategory(e.target.value as FormCategory)}
                className="h-9 w-full rounded-lg border border-border bg-card px-2.5 text-sm text-foreground"
              >
                {FORM_CATEGORIES.map((c) => (
                  <option key={c} value={c}>{tCat(c)}</option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">{t("categoryHint")}</p>
            </div>
            {createError && <p role="alert" className="text-sm text-destructive">{createError}</p>}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)} disabled={creating}>
              {t("cancel")}
            </Button>
            <Button onClick={handleCreate} disabled={!name.trim() || creating}>
              {creating && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent className="bg-popover text-popover-foreground sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("deleteTitle")}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t("deleteDesc", { name: deleting?.name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)} disabled={busyId !== null}>
              {t("cancel")}
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={busyId !== null}>
              {busyId !== null && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("deleteConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
