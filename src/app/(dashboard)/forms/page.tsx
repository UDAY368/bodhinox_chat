"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { toast } from "sonner";
import { ClipboardList, Copy, Loader2, Pencil, Plus, Trash2 } from "lucide-react";

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
    <div className="space-y-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">{t("title")}</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t("description")}</p>
        </div>
        <GatedButton canAct={canManage} gateReason={tGate("reasons.manageForms")} onClick={openCreate}>
          <Plus className="h-4 w-4" />
          {t("newForm")}
        </GatedButton>
      </header>

      {forms.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-card/50 px-6 py-16 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted">
            <ClipboardList className="h-6 w-6 text-muted-foreground" />
          </div>
          <h2 className="mt-4 text-base font-medium text-foreground">{t("emptyTitle")}</h2>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">{t("emptyDesc")}</p>
          <GatedButton canAct={canManage} gateReason={tGate("reasons.manageForms")} onClick={openCreate} className="mt-5">
            <Plus className="h-4 w-4" />
            {t("createFirst")}
          </GatedButton>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("colName")}</TableHead>
                <TableHead>{t("colCategory")}</TableHead>
                <TableHead>{t("colStatus")}</TableHead>
                <TableHead className="text-right">{t("colResponses")}</TableHead>
                <TableHead>{t("colUpdated")}</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">{t("colActions")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {forms.map((form) => (
                <TableRow key={form.id}>
                  <TableCell className="max-w-[16rem]">
                    <button
                      type="button"
                      onClick={() => router.push(`/forms/${form.id}`)}
                      className="truncate text-left font-medium text-foreground hover:underline"
                    >
                      {form.name}
                    </button>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{tCat(form.category)}</TableCell>
                  <TableCell>
                    <FormStatusBadge status={form.status} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {form.response_count ?? 0}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {format.dateTime(new Date(form.updated_at), { dateStyle: "medium" })}
                  </TableCell>
                  <TableCell>
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
                className="h-9 w-full rounded-md border border-border bg-muted px-2 text-sm text-foreground"
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
