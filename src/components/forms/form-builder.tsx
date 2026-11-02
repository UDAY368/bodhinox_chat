"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Calendar,
  CheckSquare,
  ChevronDown,
  CircleDot,
  Copy,
  ExternalLink,
  Hash,
  Heading,
  Loader2,
  Lock,
  Mail,
  Pilcrow,
  Phone,
  Plus,
  Save,
  Send,
  SquareCheck,
  TextCursorInput,
  Trash2,
  type LucideIcon,
  AlignLeft,
} from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { GatedButton } from "@/components/ui/gated-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { useCustomFields } from "@/components/flows/forms/use-pickers";
import { FORM_LIMITS, validateFormDefinition } from "@/lib/whatsapp/forms/definition";
import {
  FORM_CATEGORIES,
  FORM_FIELD_TYPES,
  type FormCategory,
  type FormDefinition,
  type FormField,
  type FormFieldType,
  type FormScreen,
  type WhatsAppForm,
} from "@/lib/whatsapp/forms/types";
import { duplicateForm, getForm, publishForm, saveForm, type FormApiError } from "./form-api";
import {
  canAddScreen,
  dropIndexedErrors,
  errorsByPath,
  errorsUnder,
  isLockedStatus,
  metaErrorMessages,
  moveItem,
  newField,
  newScreen,
  unplacedErrors,
  withoutMetaErrors,
} from "./form-editing";
import { FieldEditor, FieldErrors } from "./field-editor";
import { FormPreview } from "./form-preview";
import { FormResponses } from "./form-responses";
import { FormStatusBadge } from "./form-status-badge";

const FIELD_ICONS: Record<FormFieldType, LucideIcon> = {
  heading: Heading,
  paragraph: Pilcrow,
  short_text: TextCursorInput,
  long_text: AlignLeft,
  email: Mail,
  phone: Phone,
  number: Hash,
  date: Calendar,
  dropdown: ChevronDown,
  radio: CircleDot,
  checkboxes: CheckSquare,
  opt_in: SquareCheck,
};

const selectClass = "h-9 rounded-md border border-border bg-muted px-2 text-sm text-foreground disabled:opacity-60";

interface Draft {
  name: string;
  category: FormCategory;
  definition: FormDefinition;
  uses_endpoint: boolean;
}

const draftOf = (form: WhatsAppForm): Draft => ({
  name: form.name,
  category: form.category,
  definition: form.definition,
  uses_endpoint: form.uses_endpoint,
});

export function FormBuilder({
  initialForm,
  canManage,
  encryptionConfigured,
}: {
  initialForm: WhatsAppForm;
  canManage: boolean;
  encryptionConfigured: boolean;
}) {
  const router = useRouter();
  const t = useTranslations("Forms.builder");
  const tType = useTranslations("Forms.fieldTypes");
  const tCat = useTranslations("Forms.categories");
  const tGate = useTranslations("GatedButton");
  const customFields = useCustomFields();

  const [form, setForm] = useState(initialForm);
  const [draft, setDraft] = useState<Draft>(() => draftOf(initialForm));
  const [screenIndex, setScreenIndex] = useState(0);
  const [errors, setErrors] = useState<FormApiError[]>([]);
  const [busy, setBusy] = useState<"save" | "publish" | "duplicate" | null>(null);
  const [tab, setTab] = useState<"build" | "responses">("build");

  const locked = isLockedStatus(form.status);
  const readOnly = locked || !canManage;
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(draftOf(form)), [draft, form]);
  const errorMap = useMemo(() => errorsByPath(errors), [errors]);
  const screens = draft.definition.screens;
  const current = Math.min(screenIndex, screens.length - 1);
  const screen = screens[current];
  const metaErrors = metaErrorMessages(form.validation_errors);
  const looseErrors = unplacedErrors(errors);

  // Same guard as the flow editor: catches reloads and closed tabs, not
  // client-side route changes.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  function setDefinition(update: (definition: FormDefinition) => FormDefinition) {
    setDraft((d) => ({ ...d, definition: update(d.definition) }));
  }

  function updateScreen(index: number, patch: Partial<FormScreen>) {
    setDefinition((def) => ({ ...def, screens: def.screens.map((s, i) => (i === index ? { ...s, ...patch } : s)) }));
  }

  function updateField(fieldIndex: number, field: FormField) {
    updateScreen(current, { fields: screen.fields.map((f, i) => (i === fieldIndex ? field : f)) });
  }

  function addField(type: FormFieldType) {
    const field = newField(draft.definition, type, {
      label: tType(type),
      option: (n) => t("optionN", { n }),
    });
    updateScreen(current, { fields: [...screen.fields, field] });
  }

  function addScreen() {
    const next = newScreen(draft.definition, { title: t("newScreenTitle"), button: t("newScreenButton") });
    setDefinition((def) => ({ ...def, screens: [...def.screens, next] }));
    setScreenIndex(screens.length);
  }

  function removeScreen(index: number) {
    setDefinition((def) => ({ ...def, screens: def.screens.filter((_, i) => i !== index) }));
    setErrors(dropIndexedErrors);
    setScreenIndex((i) => Math.max(0, i >= index ? i - 1 : i));
  }

  function moveScreen(index: number, delta: -1 | 1) {
    setDefinition((def) => ({ ...def, screens: moveItem(def.screens, index, index + delta) }));
    setErrors(dropIndexedErrors);
    setScreenIndex(index + delta);
  }

  /** Validates locally, then PUTs. Resolves true when the server accepted it. */
  async function save(): Promise<boolean> {
    const local = validateFormDefinition(draft.definition);
    const nameError = draft.name.trim() ? [] : [{ path: "name", message: t("nameRequired") }];
    if (!local.ok || nameError.length) {
      setErrors([...nameError, ...(local.ok ? [] : local.errors)]);
      toast.error(t("fixErrors"));
      return false;
    }
    const result = await saveForm(form.id, { ...draft, name: draft.name.trim(), definition: local.definition });
    if (!result.ok) {
      setErrors(result.errors.length ? result.errors : [{ message: result.error ?? t("saveError") }]);
      toast.error(result.status === 422 ? t("fixErrors") : (result.error ?? t("saveError")));
      return false;
    }
    setErrors([]);
    setForm(result.form);
    setDraft(draftOf(result.form));
    return true;
  }

  async function handleSave() {
    setBusy("save");
    try {
      if (await save()) toast.success(t("saved"));
    } catch {
      toast.error(t("saveError"));
    } finally {
      setBusy(null);
    }
  }

  async function handlePublish() {
    setBusy("publish");
    try {
      if (dirty && !(await save())) return;
      const result = await publishForm(form.id);
      if (!result.ok) {
        setErrors(result.errors.length ? result.errors : [{ message: result.error ?? t("publishError") }]);
        toast.error(t("publishFailed"));
        // A 422 from Meta also stored status=error and its validation errors on
        // the row; refresh the form so the badge and Meta errors match. The
        // draft is left alone so unsaved edits survive.
        if (result.status === 422) {
          const fresh = await getForm(form.id).catch(() => null);
          if (fresh) {
            setForm(fresh);
            setErrors((current) => withoutMetaErrors(current, fresh.validation_errors));
          }
        }
        return;
      }
      setErrors([]);
      setForm(result.form);
      setDraft(draftOf(result.form));
      toast.success(t("published"));
    } catch {
      toast.error(t("publishError"));
    } finally {
      setBusy(null);
    }
  }

  async function handleDuplicate() {
    setBusy("duplicate");
    try {
      const result = await duplicateForm(form.id);
      if (!result.ok) throw new Error(result.error ?? t("duplicateError"));
      router.push(`/forms/${result.form.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("duplicateError"));
    } finally {
      setBusy(null);
    }
  }

  if (!screen) return null;
  const screenPath = `screens.${current}`;
  const screenErr = (key: string) => errorMap.get(`${screenPath}.${key}`) ?? [];

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <Link href="/forms" aria-label={t("backToList")} className={buttonVariants({ variant: "ghost", size: "icon-sm" })}>
            <ArrowLeft />
          </Link>
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={draft.name}
                readOnly={readOnly}
                maxLength={200}
                aria-label={t("nameLabel")}
                aria-invalid={(errorMap.get("name") ?? []).length > 0}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                className="h-9 max-w-sm bg-muted text-base font-semibold"
              />
              <FormStatusBadge status={form.status} />
              {dirty && <span className="text-xs text-muted-foreground">{t("unsaved")}</span>}
            </div>
            <FieldErrors id="form-name-error" messages={errorMap.get("name") ?? []} />
            <div className="flex flex-wrap items-center gap-2">
              <Label htmlFor="form-category" className="text-xs text-muted-foreground">{t("category")}</Label>
              <select
                id="form-category"
                value={draft.category}
                disabled={readOnly}
                onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value as FormCategory }))}
                className={selectClass}
              >
                {FORM_CATEGORIES.map((c) => (
                  <option key={c} value={c}>{tCat(c)}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {form.preview_url && (
            <a href={form.preview_url} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "outline", size: "sm" })}>
              <ExternalLink /> {t("metaPreview")}
            </a>
          )}
          {locked ? (
            <GatedButton
              size="sm"
              canAct={canManage}
              gateReason={tGate("reasons.manageForms")}
              disabled={busy !== null}
              onClick={handleDuplicate}
            >
              {busy === "duplicate" ? <Loader2 className="animate-spin" /> : <Copy />}
              {t("duplicateToEdit")}
            </GatedButton>
          ) : (
            <>
              <GatedButton
                variant="outline"
                size="sm"
                canAct={canManage}
                gateReason={tGate("reasons.manageForms")}
                disabled={busy !== null || !dirty}
                onClick={handleSave}
              >
                {busy === "save" ? <Loader2 className="animate-spin" /> : <Save />}
                {t("save")}
              </GatedButton>
              <GatedButton
                size="sm"
                canAct={canManage}
                gateReason={tGate("reasons.manageForms")}
                disabled={busy !== null}
                onClick={handlePublish}
              >
                {busy === "publish" ? <Loader2 className="animate-spin" /> : <Send />}
                {t("publish")}
              </GatedButton>
            </>
          )}
        </div>
      </header>

      {locked && (
        <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
          <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>{t("lockedNotice")}</p>
        </div>
      )}
      {!locked && !canManage && (
        <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
          <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>{t("readOnlyNotice")}</p>
        </div>
      )}
      {(looseErrors.length > 0 || metaErrors.length > 0) && (
        <div role="alert" className="space-y-1 rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <p className="flex items-center gap-2 font-medium">
            <AlertTriangle className="h-4 w-4" aria-hidden /> {metaErrors.length > 0 ? t("metaErrorsTitle") : t("errorsTitle")}
          </p>
          <ul className="list-disc space-y-0.5 pl-6">
            {[...looseErrors, ...metaErrors].map((message, i) => <li key={i}>{message}</li>)}
          </ul>
        </div>
      )}

      <Tabs value={tab} onValueChange={(v) => setTab(v as "build" | "responses")}>
        <TabsList className="w-fit">
          <TabsTrigger value="build" className="px-3">{t("tabBuild")}</TabsTrigger>
          <TabsTrigger value="responses" className="px-3">{t("tabResponses")}</TabsTrigger>
        </TabsList>

        <TabsContent value="build" className="mt-4">
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
            <div className="space-y-4">
              <section aria-label={t("screens")} className="space-y-2">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-foreground">{t("screensCount", { count: screens.length, max: FORM_LIMITS.maxScreens })}</h2>
                  {!readOnly && (
                    <Button variant="outline" size="sm" onClick={addScreen} disabled={!canAddScreen(draft.definition)}>
                      <Plus /> {t("addScreen")}
                    </Button>
                  )}
                </div>
                <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label={t("screens")}>
                  {screens.map((s, i) => {
                    const hasErrors = errorsUnder(errorMap, `screens.${i}`).length > 0;
                    return (
                      <button
                        key={`${s.id}-${i}`}
                        type="button"
                        role="tab"
                        aria-selected={i === current}
                        onClick={() => setScreenIndex(i)}
                        className={cn(
                          "flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5 text-left text-xs",
                          i === current ? "border-primary bg-primary/10 text-foreground" : "border-border bg-card text-muted-foreground hover:bg-muted",
                          hasErrors && "border-destructive/60",
                        )}
                      >
                        <span className="font-mono text-[10px] opacity-70">{i + 1}</span>
                        <span className="max-w-[10rem] truncate">{s.title || t("untitledScreen")}</span>
                        {hasErrors && <AlertTriangle className="h-3 w-3 text-destructive" aria-label={t("hasErrors")} />}
                      </button>
                    );
                  })}
                </div>
              </section>

              <section aria-label={t("screenSettings")} className="space-y-3 rounded-lg border border-border bg-card p-4">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-foreground">{t("screenN", { n: current + 1 })}</h3>
                  {!readOnly && (
                    <div className="flex gap-0.5">
                      <Button variant="ghost" size="icon-xs" aria-label={t("moveScreenUp")} disabled={current === 0} onClick={() => moveScreen(current, -1)}>
                        <ArrowUp />
                      </Button>
                      <Button variant="ghost" size="icon-xs" aria-label={t("moveScreenDown")} disabled={current === screens.length - 1} onClick={() => moveScreen(current, 1)}>
                        <ArrowDown />
                      </Button>
                      <Button variant="ghost" size="icon-xs" aria-label={t("removeScreen")} disabled={screens.length <= 1} onClick={() => removeScreen(current)} className="text-destructive">
                        <Trash2 />
                      </Button>
                    </div>
                  )}
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="screen-title">{t("screenTitle")}</Label>
                    <Input
                      id="screen-title"
                      value={screen.title}
                      readOnly={readOnly}
                      maxLength={FORM_LIMITS.screenTitleMax}
                      aria-invalid={screenErr("title").length > 0}
                      aria-describedby={screenErr("title").length ? "screen-title-error" : undefined}
                      onChange={(e) => updateScreen(current, { title: e.target.value })}
                      className="bg-muted"
                    />
                    <FieldErrors id="screen-title-error" messages={screenErr("title")} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="screen-button">{current === screens.length - 1 ? t("submitLabel") : t("nextLabel")}</Label>
                    <Input
                      id="screen-button"
                      value={screen.button_label}
                      readOnly={readOnly}
                      maxLength={FORM_LIMITS.buttonLabelMax}
                      aria-invalid={screenErr("button_label").length > 0}
                      aria-describedby={screenErr("button_label").length ? "screen-button-error" : undefined}
                      onChange={(e) => updateScreen(current, { button_label: e.target.value })}
                      className="bg-muted"
                    />
                    <FieldErrors id="screen-button-error" messages={screenErr("button_label")} />
                  </div>
                </div>
                <FieldErrors id="screen-errors" messages={[...screenErr("id"), ...screenErr("fields")]} />
              </section>

              <section aria-label={t("fields")} className="space-y-3">
                {screen.fields.length === 0 && (
                  <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">{t("noFields")}</p>
                )}
                {screen.fields.map((field, i) => (
                  <FieldEditor
                    key={`${current}-${i}`}
                    field={field}
                    path={`${screenPath}.fields.${i}`}
                    errors={errorMap}
                    readOnly={readOnly}
                    customFields={customFields}
                    isFirst={i === 0}
                    isLast={i === screen.fields.length - 1}
                    onChange={(next) => updateField(i, next)}
                    onRemove={() => {
                      updateScreen(current, { fields: screen.fields.filter((_, j) => j !== i) });
                      setErrors(dropIndexedErrors);
                    }}
                    onMove={(delta) => {
                      updateScreen(current, { fields: moveItem(screen.fields, i, i + delta) });
                      setErrors(dropIndexedErrors);
                    }}
                  />
                ))}
              </section>

              {!readOnly && (
                <section aria-label={t("palette")} className="space-y-2">
                  <h3 className="text-sm font-semibold text-foreground">{t("addField")}</h3>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
                    {FORM_FIELD_TYPES.map((type) => {
                      const Icon = FIELD_ICONS[type];
                      return (
                        <Button
                          key={type}
                          variant="outline"
                          size="sm"
                          className="justify-start"
                          disabled={screen.fields.length >= FORM_LIMITS.maxFieldsPerScreen}
                          onClick={() => addField(type)}
                        >
                          <Icon /> {tType(type)}
                        </Button>
                      );
                    })}
                  </div>
                </section>
              )}

              <section aria-label={t("settings")} className="space-y-4 rounded-lg border border-border bg-card p-4">
                <div className="space-y-1.5">
                  <Label htmlFor="form-success">{t("successMessage")}</Label>
                  <Textarea
                    id="form-success"
                    value={draft.definition.success_message ?? ""}
                    readOnly={readOnly}
                    maxLength={FORM_LIMITS.successMessageMax}
                    placeholder={t("successPlaceholder")}
                    aria-describedby="form-success-hint"
                    onChange={(e) => setDefinition((def) => {
                      const next = { ...def };
                      if (e.target.value) next.success_message = e.target.value;
                      else delete next.success_message;
                      return next;
                    })}
                    className="min-h-20 bg-muted"
                  />
                  <p id="form-success-hint" className="text-xs text-muted-foreground">{t("successHint")}</p>
                  <FieldErrors id="form-success-error" messages={errorMap.get("success_message") ?? []} />
                </div>
                <div className="flex items-start gap-3">
                  <Switch
                    id="form-endpoint"
                    checked={draft.uses_endpoint}
                    disabled={readOnly || (!encryptionConfigured && !draft.uses_endpoint)}
                    aria-describedby="form-endpoint-hint"
                    onCheckedChange={(checked) => setDraft((d) => ({ ...d, uses_endpoint: checked }))}
                    className="mt-0.5"
                  />
                  <div className="space-y-0.5">
                    <Label htmlFor="form-endpoint">{t("usesEndpoint")}</Label>
                    <p id="form-endpoint-hint" className="text-xs text-muted-foreground">
                      {encryptionConfigured ? t("usesEndpointHint") : t("usesEndpointNoKey")}
                    </p>
                  </div>
                </div>
              </section>
            </div>

            <aside aria-label={t("previewTitle")} className="space-y-2 lg:sticky lg:top-4 lg:self-start">
              <h2 className="text-sm font-semibold text-foreground">{t("previewTitle")}</h2>
              <FormPreview
                definition={draft.definition}
                screenIndex={current}
                onScreenChange={setScreenIndex}
                formName={draft.name}
              />
            </aside>
          </div>
        </TabsContent>

        <TabsContent value="responses" className="mt-4">
          {tab === "responses" && (
            <FormResponses formId={form.id} definition={form.definition} canExport={canManage} />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
