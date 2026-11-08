'use client';

import { useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Loader2, Plus, Upload, X } from 'lucide-react';
import { authFetch } from '@/lib/auth/client';
import {
  uploadAccountMedia,
  MEDIA_MAX_BYTES_BY_KIND,
} from '@/lib/storage/upload-media';
import {
  MEDIA_HEADER_SPECS,
  isMediaHeaderKind,
  type MediaHeaderKind,
} from '@/lib/whatsapp/media-header-types';
import {
  extractVariableIndices,
  TEMPLATE_KINDS,
  TEMPLATE_LIMITS,
} from '@/lib/whatsapp/template-validators';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { MessageTemplate, TemplateButton, TemplateKind } from '@/types';
import { TemplateLanguageSelect } from './template-language-select';
import { TemplatePreview } from './template-preview';
import { usePublishedForms } from '@/components/flows/forms/use-pickers';
import { metaScreenId } from '@/lib/whatsapp/forms/definition';
import {
  BUTTON_TYPES_BY_KIND,
  CARD_BUTTON_TYPES,
  CATEGORIES_BY_KIND,
  HEADER_FORMATS_BY_KIND,
  addCard,
  addCardButton,
  canRemoveCard,
  emptyButton,
  hasLibraryPlaceholder,
  maxButtonsFor,
  patchButton,
  previewFromForm,
  removeCard,
  removeCardButton,
  resizeSamples,
  setCardButtonType,
  templatePayloadFromForm,
  withTemplateKind,
  type ButtonPatch,
  type CardForm,
  type HeaderFormat,
  type TemplateFormData,
} from './template-manager-helpers';

const inputCls =
  'bg-muted border-border text-foreground placeholder:text-muted-foreground';
const itemCls = 'text-popover-foreground focus:bg-muted focus:text-popover-foreground';

export interface TemplateEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Starting values; the parent remounts the dialog (via `key`) per open. */
  initial: TemplateFormData;
  /** A submitted template changed through PATCH; null otherwise. */
  editingId: string | null;
  /** A local draft row that Save draft updates and Submit submits by id. */
  draftId: string | null;
  /** Refetch the list; resolves to the fresh rows. */
  onRefresh: () => Promise<MessageTemplate[]>;
}

/**
 * Create / edit dialog for every template kind, with a live preview.
 * Save draft stores the template locally (POST /draft); Submit sends it
 * to Meta (POST /submit, by id for a saved draft) or, for an already
 * submitted template, edits it (PATCH /[id]). Nothing is submitted
 * without the user pressing Submit.
 */
export function TemplateEditorDialog({
  open,
  onOpenChange,
  initial,
  editingId,
  draftId: initialDraftId,
  onRefresh,
}: TemplateEditorDialogProps) {
  const t = useTranslations('Settings.templates');
  const categoryLabel = (category: string) =>
    t.has(`categoryLabels.${category}`) ? t(`categoryLabels.${category}`) : category;

  const [form, setForm] = useState<TemplateFormData>(initial);
  const [draftId, setDraftId] = useState<string | null>(initialDraftId);
  const [busy, setBusy] = useState<'submit' | 'draft' | null>(null);
  // Which media slot is uploading: 'header' or a card index.
  const [uploading, setUploading] = useState<'header' | number | null>(null);
  const headerFileRef = useRef<HTMLInputElement>(null);

  const kind = form.template_kind;
  const isEdit = editingId !== null;

  // Sample rows follow the {{n}} variables actually typed.
  const bodyVarCount = useMemo(
    () => extractVariableIndices(form.body_text).length,
    [form.body_text],
  );
  const headerVarCount =
    form.header_format === 'text' ? extractVariableIndices(form.header_content).length : 0;
  const bodySamples = resizeSamples(form.body_samples, bodyVarCount);

  const preview = useMemo(() => previewFromForm(form), [form]);

  function patch(p: Partial<TemplateFormData>) {
    setForm((prev) => ({ ...prev, ...p }));
  }

  function patchCard(index: number, p: Partial<CardForm>) {
    setForm((prev) => ({
      ...prev,
      cards: prev.cards.map((c, i) => (i === index ? { ...c, ...p } : c)),
    }));
  }

  // Per-kind copy for the file picker, as explicit key maps so the
  // catalogue scanner can see every key.
  const uploadLabelKey = {
    image: 'uploadImage',
    video: 'uploadVideo',
    document: 'uploadDocument',
  } as const;
  const uploadHintKey = {
    image: 'uploadHint',
    video: 'uploadHintVideo',
    document: 'uploadHintDocument',
  } as const;
  const invalidTypeKey = {
    image: 'toastInvalidImage',
    video: 'toastInvalidVideo',
    document: 'toastInvalidDocument',
  } as const;

  /**
   * Upload a header (or carousel card) file to the account-scoped
   * chat-media bucket and return its public URL. The submit route turns
   * that URL into a Meta Resumable-Upload handle.
   */
  async function uploadMedia(
    file: File,
    mediaKind: MediaHeaderKind,
    slot: 'header' | number,
  ): Promise<string | null> {
    if (!MEDIA_HEADER_SPECS[mediaKind].mimeTypes.includes(file.type)) {
      toast.error(t(invalidTypeKey[mediaKind]));
      return null;
    }
    // The chat-media bucket's ceiling, which is below Meta's document cap.
    const maxBytes = MEDIA_MAX_BYTES_BY_KIND[mediaKind];
    if (file.size > maxBytes) {
      toast.error(
        t('toastMediaTooLarge', {
          size: (file.size / 1024 / 1024).toFixed(1),
          max: Math.round(maxBytes / 1024 / 1024),
        }),
      );
      return null;
    }
    setUploading(slot);
    try {
      const { publicUrl } = await uploadAccountMedia('chat-media', file);
      toast.success(t('toastUploadSuccess'));
      return publicUrl;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('toastUploadFailed'));
      return null;
    } finally {
      setUploading(null);
    }
  }

  async function saveDraft() {
    setBusy('draft');
    try {
      const res = await authFetch('/api/whatsapp/templates/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...templatePayloadFromForm(form),
          ...(draftId ? { id: draftId } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || t('draftSaveFailedHttp', { status: res.status }));
      }
      if (data?.template?.id) setDraftId(data.template.id);
      toast.success(t('toastDraftSaved'));
      await onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('toastSubmitFailed'));
    } finally {
      setBusy(null);
    }
  }

  async function submit() {
    setBusy('submit');
    const payload = templatePayloadFromForm(form);
    try {
      const url = isEdit
        ? `/api/whatsapp/templates/${editingId}`
        : '/api/whatsapp/templates/submit';
      const res = await authFetch(url, {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, ...(!isEdit && draftId ? { id: draftId } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // A failed Meta submit is kept as a draft row; pick it up so the
        // next Save draft / Submit updates that row instead of clashing.
        if (!isEdit && !draftId) {
          const rows = await onRefresh().catch(() => []);
          const kept = rows.find(
            (r) =>
              r.name === payload.name &&
              r.language === payload.language &&
              !r.meta_template_id,
          );
          if (kept) setDraftId(kept.id);
        }
        throw new Error(
          data?.error ||
            t(isEdit ? 'editFailedHttp' : 'submitFailedHttp', { status: res.status }),
        );
      }
      // Refresh first, then close, so reopening never shows a stale list.
      await onRefresh();
      toast.success(
        data.dry_run
          ? isEdit
            ? t('toastSaveEditDry')
            : t('toastSaveNewDry')
          : isEdit
            ? t('toastSubmitEditSuccess')
            : t('toastSubmitNewSuccess'),
      );
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('toastSubmitFailed'));
    } finally {
      setBusy(null);
    }
  }

  const headerMediaKind: MediaHeaderKind | null = isMediaHeaderKind(form.header_format)
    ? form.header_format
    : null;
  const headerFormats = HEADER_FORMATS_BY_KIND[kind];
  const categories = CATEGORIES_BY_KIND[kind].includes(form.category)
    ? CATEGORIES_BY_KIND[kind]
    : [...CATEGORIES_BY_KIND[kind], form.category];
  const maxButtons = maxButtonsFor(kind);
  const headerLabel: Record<HeaderFormat, string> = {
    none: t('headerNone'),
    text: t('headerText'),
    image: t('headerImage'),
    video: t('headerVideo'),
    document: t('headerDocument'),
    location: t('headerLocation'),
  };
  const kindLabel: Record<TemplateKind, string> = {
    standard: t('kinds.standard'),
    carousel: t('kinds.carousel'),
    authentication: t('kinds.authentication'),
    limited_time_offer: t('kinds.limited_time_offer'),
  };
  const kindHint: Record<TemplateKind, string> = {
    standard: t('kindHints.standard'),
    carousel: t('kindHints.carousel'),
    authentication: t('kindHints.authentication'),
    limited_time_offer: t('kindHints.limited_time_offer'),
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover border-border sm:max-w-5xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {isEdit ? t('dialogEditTitle') : draftId ? t('dialogDraftTitle') : t('dialogNewTitle')}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {isEdit ? t('dialogEditDesc') : t('dialogNewDesc')}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="space-y-4 py-2 min-w-0">
            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('templateKind')}</Label>
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t('templateKind')}>
                {TEMPLATE_KINDS.map((k) => (
                  <Button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={kind === k}
                    size="sm"
                    variant={kind === k ? 'default' : 'outline'}
                    disabled={isEdit && kind !== k}
                    onClick={() => setForm((prev) => withTemplateKind(prev, k))}
                    className="h-8 text-xs"
                  >
                    {kindLabel[k]}
                  </Button>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">
                {isEdit ? t('kindFixed') : kindHint[kind]}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="template-name" className="text-muted-foreground">
                {t('templateName')}
              </Label>
              <Input
                id="template-name"
                placeholder={t('namePlaceholder')}
                value={form.name}
                onChange={(e) => patch({ name: e.target.value })}
                disabled={isEdit}
                className={`${inputCls} disabled:opacity-60 disabled:cursor-not-allowed`}
              />
              <p className="text-[11px] text-muted-foreground">
                {isEdit ? t('nameFixed') : t('nameHint')}
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label className="text-muted-foreground">{t('category')}</Label>
                <Select
                  value={form.category}
                  onValueChange={(val) => {
                    if (val) patch({ category: val as MessageTemplate['category'] });
                  }}
                  disabled={categories.length < 2}
                >
                  <SelectTrigger className="w-full bg-muted border-border text-foreground">
                    <SelectValue>{categoryLabel(form.category)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent className="bg-popover border-border">
                    {categories.map((cat) => (
                      <SelectItem key={cat} value={cat} className={itemCls}>
                        {categoryLabel(cat)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="template-language" className="text-muted-foreground">
                  {t('language')}
                </Label>
                {isEdit ? (
                  <Input
                    id="template-language"
                    value={form.language}
                    disabled
                    className={`${inputCls} disabled:opacity-60 disabled:cursor-not-allowed`}
                  />
                ) : (
                  <TemplateLanguageSelect
                    id="template-language"
                    value={form.language}
                    onChange={(code) => patch({ language: code })}
                  />
                )}
                {isEdit && <p className="text-[11px] text-muted-foreground">{t('langFixed')}</p>}
              </div>
            </div>

            {kind === 'authentication' ? (
              <AuthFields form={form} patch={patch} />
            ) : (
              <>
                {kind === 'limited_time_offer' && <LtoFields form={form} patch={patch} />}

                {headerFormats.length > 1 && (
                  <div className="space-y-2">
                    <Label className="text-muted-foreground">{t('header')}</Label>
                    <Select
                      value={form.header_format}
                      onValueChange={(val) =>
                        // Header values survive format switches; the payload
                        // builder only reads the active format's field.
                        patch({ header_format: (val || 'none') as HeaderFormat })
                      }
                    >
                      <SelectTrigger className="w-full bg-muted border-border text-foreground">
                        <SelectValue>{headerLabel[form.header_format]}</SelectValue>
                      </SelectTrigger>
                      <SelectContent className="bg-popover border-border">
                        {headerFormats.map((type) => (
                          <SelectItem key={type} value={type} className={itemCls}>
                            {headerLabel[type]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    {form.header_format === 'text' && (
                      <div className="space-y-2 mt-2">
                        <Input
                          id="template-header-text"
                          aria-label={t('headerTextLabel')}
                          placeholder={t.raw('headerTextPlaceholder')}
                          value={form.header_content}
                          onChange={(e) => patch({ header_content: e.target.value })}
                          maxLength={TEMPLATE_LIMITS.headerTextMaxLength}
                          className={inputCls}
                        />
                        {headerVarCount > 0 && (
                          <Input
                            id="template-header-sample"
                            aria-label={t('headerSampleAria')}
                            placeholder={t.raw('headerSamplePlaceholder')}
                            value={form.header_sample}
                            onChange={(e) => patch({ header_sample: e.target.value })}
                            className={inputCls}
                          />
                        )}
                      </div>
                    )}

                    {form.header_format === 'location' && (
                      <p className="text-[11px] text-muted-foreground">{t('locationHint')}</p>
                    )}

                    {headerMediaKind && (
                      <div className="space-y-2 mt-2">
                        <div className="flex items-center gap-2">
                          <input
                            ref={headerFileRef}
                            type="file"
                            accept={MEDIA_HEADER_SPECS[headerMediaKind].mimeTypes.join(',')}
                            className="hidden"
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              e.target.value = '';
                              if (!f) return;
                              void uploadMedia(f, headerMediaKind, 'header').then((url) => {
                                if (url) patch({ header_media_url: url });
                              });
                            }}
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={uploading !== null}
                            onClick={() => headerFileRef.current?.click()}
                          >
                            {uploading === 'header' ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Upload className="h-3.5 w-3.5" />
                            )}
                            {t(uploadLabelKey[headerMediaKind])}
                          </Button>
                          <span className="text-[11px] text-muted-foreground">
                            {t(uploadHintKey[headerMediaKind])}
                          </span>
                        </div>
                        <Input
                          placeholder={t('mediaUrlPlaceholder', { format: form.header_format })}
                          value={form.header_media_url}
                          onChange={(e) => patch({ header_media_url: e.target.value })}
                          className={inputCls}
                        />
                        {form.header_format === 'image' && form.header_media_url && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={form.header_media_url}
                            alt={t('headerSampleAlt')}
                            className="max-h-28 rounded-md border border-border object-contain"
                          />
                        )}
                        <p className="text-[11px] text-muted-foreground leading-relaxed">
                          {form.header_format === 'image' ? t('imageHint') : t('mediaHint')}
                          {form.header_format === 'video' && t('videoHint')}
                          {form.header_format === 'document' && t('documentHint')}
                        </p>
                      </div>
                    )}
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="template-body" className="text-muted-foreground">
                    {t('bodyText')}
                  </Label>
                  <Textarea
                    id="template-body"
                    placeholder={t.raw('bodyPlaceholder')}
                    value={form.body_text}
                    onChange={(e) => patch({ body_text: e.target.value })}
                    rows={4}
                    maxLength={
                      kind === 'limited_time_offer'
                        ? TEMPLATE_LIMITS.ltoBodyMaxLength
                        : TEMPLATE_LIMITS.bodyMaxLength
                    }
                    className={`${inputCls} resize-none`}
                  />
                  <p className="text-[11px] text-muted-foreground">{t.raw('bodyHint')}</p>
                  <SampleInputs
                    idPrefix="template-body-sample"
                    samples={bodySamples}
                    onChange={(next) => patch({ body_samples: next })}
                  />
                </div>

                {kind === 'standard' && (
                  <div className="space-y-2">
                    <Label htmlFor="template-footer" className="text-muted-foreground">
                      {t('footer')}
                    </Label>
                    <Input
                      id="template-footer"
                      placeholder={t('footerPlaceholder')}
                      value={form.footer_text}
                      onChange={(e) => patch({ footer_text: e.target.value })}
                      maxLength={TEMPLATE_LIMITS.footerMaxLength}
                      className={inputCls}
                    />
                  </div>
                )}

                {maxButtons > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-muted-foreground">{t('buttons')}</Label>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          setForm((prev) => ({
                            ...prev,
                            buttons: [
                              ...prev.buttons,
                              emptyButton(BUTTON_TYPES_BY_KIND[prev.template_kind][0]),
                            ],
                          }))
                        }
                        disabled={form.buttons.length >= maxButtons}
                        className="border-border bg-transparent text-muted-foreground hover:bg-muted h-7 text-xs"
                      >
                        <Plus className="size-3" />
                        {t('addButton')}
                      </Button>
                    </div>
                    {form.buttons.length === 0 ? (
                      <p className="text-[11px] text-muted-foreground">
                        {t('buttonsLimit', { max: maxButtons })}
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {form.buttons.map((btn, i) => (
                          <ButtonFields
                            key={i}
                            button={btn}
                            types={BUTTON_TYPES_BY_KIND[kind]}
                            onType={(type) =>
                              setForm((prev) => ({
                                ...prev,
                                buttons: prev.buttons.map((b, j) =>
                                  j === i ? emptyButton(type) : b,
                                ),
                              }))
                            }
                            onPatch={(p) =>
                              setForm((prev) => ({
                                ...prev,
                                buttons: prev.buttons.map((b, j) =>
                                  j === i ? patchButton(b, p) : b,
                                ),
                              }))
                            }
                            onRemove={() =>
                              setForm((prev) => ({
                                ...prev,
                                buttons: prev.buttons.filter((_, j) => j !== i),
                              }))
                            }
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {kind === 'carousel' && (
                  <CarouselFields
                    form={form}
                    setForm={setForm}
                    patchCard={patchCard}
                    uploading={uploading}
                    uploadMedia={uploadMedia}
                  />
                )}
              </>
            )}
          </div>

          <div className="space-y-2 lg:sticky lg:top-0 lg:self-start">
            <Label className="text-muted-foreground">{t('preview')}</Label>
            <TemplatePreview template={preview} />
          </div>
        </div>

        <DialogFooter className="bg-popover border-border">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {t('cancel')}
          </Button>
          {!isEdit && (
            <Button
              variant="outline"
              onClick={saveDraft}
              disabled={busy !== null || uploading !== null}
            >
              {busy === 'draft' && <Loader2 className="size-4 animate-spin" />}
              {busy === 'draft' ? t('savingDraft') : t('saveDraft')}
            </Button>
          )}
          <Button
            onClick={submit}
            disabled={busy !== null || uploading !== null}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {busy === 'submit' ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {isEdit ? t('saving') : t('submitting')}
              </>
            ) : isEdit ? (
              t('saveResubmit')
            ) : (
              t('submitApproval')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SampleInputs({
  idPrefix,
  samples,
  onChange,
}: {
  idPrefix: string;
  samples: string[];
  onChange: (next: string[]) => void;
}) {
  const t = useTranslations('Settings.templates');
  if (samples.length === 0) return null;
  return (
    <div className="space-y-1.5 pt-1">
      <Label className="text-[11px] text-muted-foreground">{t('sampleValues')}</Label>
      {samples.map((val, i) => (
        <Input
          key={i}
          id={`${idPrefix}-${i}`}
          aria-label={t('sampleAria', { var: `{{${i + 1}}}` })}
          placeholder={t('samplePlaceholder', { var: `{{${i + 1}}}` })}
          value={val}
          onChange={(e) => {
            const next = [...samples];
            next[i] = e.target.value;
            onChange(next);
          }}
          className={inputCls}
        />
      ))}
    </div>
  );
}

/** One button: type, label and the type's own value fields. */
function ButtonFields({
  button,
  types,
  onType,
  onPatch,
  onRemove,
  typeLocked = false,
}: {
  button: TemplateButton;
  types: readonly TemplateButton['type'][];
  onType: (type: TemplateButton['type']) => void;
  onPatch: (patch: ButtonPatch) => void;
  onRemove?: () => void;
  typeLocked?: boolean;
}) {
  const t = useTranslations('Settings.templates');
  const typeLabel: Record<TemplateButton['type'], string> = {
    QUICK_REPLY: t('btnQuickReply'),
    URL: t('btnUrl'),
    PHONE_NUMBER: t('btnPhone'),
    COPY_CODE: t('btnCopyCode'),
    FLOW: t('btnFlow'),
  };
  const small = `${inputCls} h-8 text-xs`;
  return (
    <div className="space-y-2 rounded border border-border bg-muted/50 p-2">
      <div className="flex items-center gap-2">
        <Select
          value={button.type}
          disabled={typeLocked}
          onValueChange={(val) => {
            // @base-ui Select fires onValueChange(null) on deselect.
            if (val) onType(val as TemplateButton['type']);
          }}
        >
          <SelectTrigger className="w-40 bg-muted border-border text-foreground h-8 text-xs">
            <SelectValue>{typeLabel[button.type]}</SelectValue>
          </SelectTrigger>
          <SelectContent className="bg-popover border-border">
            {types.map((type) => (
              <SelectItem key={type} value={type} className={itemCls}>
                {typeLabel[type]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          aria-label={t('btnLabelPlaceholder')}
          placeholder={t('btnLabelPlaceholder')}
          value={button.text}
          maxLength={TEMPLATE_LIMITS.buttonTextMaxLength}
          onChange={(e) => onPatch({ text: e.target.value })}
          className={`flex-1 ${small}`}
        />
        {onRemove && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onRemove}
            aria-label={t('removeButton')}
            className="text-muted-foreground hover:text-red-400 hover:bg-red-950/30 size-7"
          >
            <X className="size-3.5" />
          </Button>
        )}
      </div>
      {button.type === 'URL' && (
        <div className="space-y-1 pl-1">
          <Input
            placeholder={t.raw('urlPlaceholder')}
            value={button.url}
            onChange={(e) => onPatch({ url: e.target.value })}
            className={small}
          />
          {extractVariableIndices(button.url).length > 0 && (
            <Input
              placeholder={t.raw('urlSamplePlaceholder')}
              value={button.example ?? ''}
              onChange={(e) => onPatch({ example: e.target.value })}
              className={small}
            />
          )}
        </div>
      )}
      {button.type === 'PHONE_NUMBER' && (
        <Input
          placeholder={t('phonePlaceholder')}
          value={button.phone_number}
          onChange={(e) => onPatch({ phone_number: e.target.value })}
          className={small}
        />
      )}
      {hasLibraryPlaceholder(button) && (
        <p role="alert" className="pl-1 text-[11px] text-amber-600 dark:text-amber-400">
          {button.type === 'URL' ? t('placeholderUrlWarning') : t('placeholderPhoneWarning')}
        </p>
      )}
      {button.type === 'COPY_CODE' && (
        <Input
          placeholder={t('codePlaceholder')}
          value={button.example}
          onChange={(e) => onPatch({ example: e.target.value })}
          className={small}
        />
      )}
      {button.type === 'FLOW' && <FlowButtonForm flowId={button.flow_id} onPatch={onPatch} />}
    </div>
  );
}

/**
 * FLOW button: pick a published form. The button stores the form's Meta
 * flow id and first screen, read from the form when it is picked.
 */
function FlowButtonForm({ flowId, onPatch }: { flowId: string; onPatch: (patch: ButtonPatch) => void }) {
  const t = useTranslations('Settings.templates');
  const forms = usePublishedForms();
  const [picked, setPicked] = useState('');
  const [loading, setLoading] = useState(false);
  const pick = async (id: string) => {
    setPicked(id);
    setLoading(true);
    try {
      const res = await authFetch(`/api/whatsapp/forms/${id}`, { cache: 'no-store' });
      const form = res.ok ? ((await res.json()) as { form?: { meta_flow_id?: string | null; definition?: { screens?: Array<{ id?: string }> } } }).form : undefined;
      if (!form?.meta_flow_id) {
        toast.error(t('flowFormUnavailable'));
        return;
      }
      onPatch({ flow_id: form.meta_flow_id, navigate_screen: form.definition?.screens?.[0]?.id ? metaScreenId(form.definition.screens[0].id) : '' });
    } catch {
      toast.error(t('flowFormUnavailable'));
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="space-y-1 pl-1">
      <Select value={picked} onValueChange={(v) => { if (v) void pick(v); }}>
        <SelectTrigger aria-label={t('flowFormLabel')} className="h-8 border-border bg-muted text-xs text-foreground">
          <SelectValue placeholder={flowId ? t('flowFormPicked') : t('flowFormPick')} />
        </SelectTrigger>
        <SelectContent className="bg-popover border-border">
          {forms.map((f) => (
            <SelectItem key={f.id} value={f.id} className={itemCls}>{f.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-[11px] text-muted-foreground">
        {loading ? t('flowFormLoading') : forms.length ? t('flowFormHelp') : t('flowFormNone')}
      </p>
    </div>
  );
}

function AuthFields({
  form,
  patch,
}: {
  form: TemplateFormData;
  patch: (p: Partial<TemplateFormData>) => void;
}) {
  const t = useTranslations('Settings.templates');
  return (
    <div className="space-y-4 rounded border border-border p-3">
      <p className="text-[11px] text-muted-foreground">{t('auth.bodyNote')}</p>
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="template-auth-security" className="text-muted-foreground">
          {t('auth.security')}
        </Label>
        <Switch
          id="template-auth-security"
          checked={form.auth_security}
          onCheckedChange={(v) => patch({ auth_security: Boolean(v) })}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="template-auth-expiry" className="text-muted-foreground">
          {t('auth.expiry')}
        </Label>
        <Input
          id="template-auth-expiry"
          type="number"
          inputMode="numeric"
          min={TEMPLATE_LIMITS.authMinExpiryMinutes}
          max={TEMPLATE_LIMITS.authMaxExpiryMinutes}
          value={form.auth_expiry}
          onChange={(e) => patch({ auth_expiry: e.target.value })}
          className={inputCls}
        />
        <p className="text-[11px] text-muted-foreground">
          {t('auth.expiryHint', {
            min: TEMPLATE_LIMITS.authMinExpiryMinutes,
            max: TEMPLATE_LIMITS.authMaxExpiryMinutes,
          })}
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="template-auth-button" className="text-muted-foreground">
          {t('auth.buttonText')}
        </Label>
        <Input
          id="template-auth-button"
          placeholder={t('auth.buttonTextPlaceholder')}
          value={form.auth_button_text}
          maxLength={TEMPLATE_LIMITS.buttonTextMaxLength}
          onChange={(e) => patch({ auth_button_text: e.target.value })}
          className={inputCls}
        />
      </div>
    </div>
  );
}

function LtoFields({
  form,
  patch,
}: {
  form: TemplateFormData;
  patch: (p: Partial<TemplateFormData>) => void;
}) {
  const t = useTranslations('Settings.templates');
  return (
    <div className="space-y-3 rounded border border-border p-3">
      <div className="space-y-2">
        <Label htmlFor="template-lto-text" className="text-muted-foreground">
          {t('lto.text')}
        </Label>
        <Input
          id="template-lto-text"
          placeholder={t('lto.textPlaceholder')}
          value={form.lto_text}
          maxLength={TEMPLATE_LIMITS.ltoTextMaxLength}
          onChange={(e) => patch({ lto_text: e.target.value })}
          className={inputCls}
        />
      </div>
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="template-lto-expiry" className="text-muted-foreground">
          {t('lto.hasExpiration')}
        </Label>
        <Switch
          id="template-lto-expiry"
          checked={form.lto_has_expiration}
          onCheckedChange={(v) => patch({ lto_has_expiration: Boolean(v) })}
        />
      </div>
      <p className="text-[11px] text-muted-foreground">{t('lto.hint')}</p>
    </div>
  );
}

function CarouselFields({
  form,
  setForm,
  patchCard,
  uploading,
  uploadMedia,
}: {
  form: TemplateFormData;
  setForm: Dispatch<SetStateAction<TemplateFormData>>;
  patchCard: (index: number, p: Partial<CardForm>) => void;
  uploading: 'header' | number | null;
  uploadMedia: (file: File, kind: MediaHeaderKind, slot: number) => Promise<string | null>;
}) {
  const t = useTranslations('Settings.templates');
  const cardFileRef = useRef<HTMLInputElement>(null);
  const [uploadTarget, setUploadTarget] = useState<number | null>(null);
  const slots = form.cards[0]?.buttons ?? [];
  const format = form.card_format;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label className="text-muted-foreground">
          {t('cards.title', { count: form.cards.length, max: TEMPLATE_LIMITS.carouselMaxCards })}
        </Label>
        <div className="flex items-center gap-2">
          <Select
            value={format}
            onValueChange={(val) => {
              if (val === 'image' || val === 'video') {
                setForm((prev) => ({ ...prev, card_format: val }));
              }
            }}
          >
            <SelectTrigger
              aria-label={t('cards.mediaType')}
              className="w-32 bg-muted border-border text-foreground h-8 text-xs"
            >
              <SelectValue>{format === 'image' ? t('headerImage') : t('headerVideo')}</SelectValue>
            </SelectTrigger>
            <SelectContent className="bg-popover border-border">
              <SelectItem value="image" className={itemCls}>
                {t('headerImage')}
              </SelectItem>
              <SelectItem value="video" className={itemCls}>
                {t('headerVideo')}
              </SelectItem>
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            disabled={form.cards.length >= TEMPLATE_LIMITS.carouselMaxCards}
            onClick={() => setForm((prev) => ({ ...prev, cards: addCard(prev.cards) }))}
          >
            <Plus className="size-3" />
            {t('cards.add')}
          </Button>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">{t('cards.hint')}</p>

      <input
        ref={cardFileRef}
        type="file"
        accept={MEDIA_HEADER_SPECS[format].mimeTypes.join(',')}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          const target = uploadTarget;
          e.target.value = '';
          if (!f || target === null) return;
          void uploadMedia(f, format, target).then((url) => {
            if (url) patchCard(target, { header_media_url: url, header_handle: undefined });
          });
        }}
      />

      {/* Button slots are shared: adding, removing or retyping one changes
          every card so the carousel's buttons line up as Meta requires. */}
      <div className="space-y-2 rounded border border-border p-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">{t('cards.buttonSlots')}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={slots.length >= TEMPLATE_LIMITS.cardMaxButtons}
            onClick={() => setForm((prev) => ({ ...prev, cards: addCardButton(prev.cards) }))}
          >
            <Plus className="size-3" />
            {t('addButton')}
          </Button>
        </div>
        {slots.map((b, slot) => (
          <div key={slot} className="flex items-center gap-2">
            <Select
              value={b.type}
              onValueChange={(val) => {
                if (val) {
                  setForm((prev) => ({
                    ...prev,
                    cards: setCardButtonType(prev.cards, slot, val as TemplateButton['type']),
                  }));
                }
              }}
            >
              <SelectTrigger
                aria-label={t('cards.slotType', { n: slot + 1 })}
                className="w-40 bg-muted border-border text-foreground h-8 text-xs"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-popover border-border">
                {CARD_BUTTON_TYPES.map((type) => (
                  <SelectItem key={type} value={type} className={itemCls}>
                    {type === 'QUICK_REPLY'
                      ? t('btnQuickReply')
                      : type === 'URL'
                        ? t('btnUrl')
                        : t('btnPhone')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="flex-1 text-[11px] text-muted-foreground">
              {t('cards.slotN', { n: slot + 1 })}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('removeButton')}
              disabled={slots.length <= TEMPLATE_LIMITS.cardMinButtons}
              onClick={() =>
                setForm((prev) => ({ ...prev, cards: removeCardButton(prev.cards, slot) }))
              }
              className="text-muted-foreground hover:text-red-400 hover:bg-red-950/30 size-7"
            >
              <X className="size-3.5" />
            </Button>
          </div>
        ))}
      </div>

      {form.cards.map((card, i) => {
        const samples = resizeSamples(
          card.body_samples,
          extractVariableIndices(card.body_text).length,
        );
        return (
          <div key={i} className="space-y-2 rounded border border-border bg-muted/30 p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{t('cards.cardN', { n: i + 1 })}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t('cards.remove', { n: i + 1 })}
                disabled={!canRemoveCard(form.cards.length, uploading)}
                onClick={() => setForm((prev) => ({ ...prev, cards: removeCard(prev.cards, i) }))}
                className="text-muted-foreground hover:text-red-400 hover:bg-red-950/30 size-7"
              >
                <X className="size-3.5" />
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={uploading !== null}
                onClick={() => {
                  setUploadTarget(i);
                  cardFileRef.current?.click();
                }}
              >
                {uploading === i ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Upload className="h-3.5 w-3.5" />
                )}
                {format === 'image' ? t('uploadImage') : t('uploadVideo')}
              </Button>
              <Input
                aria-label={t('cards.mediaUrl', { n: i + 1 })}
                placeholder={t('mediaUrlPlaceholder', { format })}
                value={card.header_media_url}
                onChange={(e) =>
                  patchCard(i, { header_media_url: e.target.value, header_handle: undefined })
                }
                className={`flex-1 ${inputCls} h-8 text-xs`}
              />
            </div>
            <Textarea
              aria-label={t('cards.body', { n: i + 1 })}
              placeholder={t.raw('bodyPlaceholder')}
              value={card.body_text}
              maxLength={TEMPLATE_LIMITS.cardBodyMaxLength}
              rows={2}
              onChange={(e) => patchCard(i, { body_text: e.target.value })}
              className={`${inputCls} resize-none`}
            />
            <SampleInputs
              idPrefix={`template-card-${i}-sample`}
              samples={samples}
              onChange={(next) => patchCard(i, { body_samples: next })}
            />
            {card.buttons.map((b, slot) => (
              <ButtonFields
                key={slot}
                button={b}
                types={CARD_BUTTON_TYPES}
                typeLocked
                onType={() => undefined}
                onPatch={(p) =>
                  patchCard(i, {
                    buttons: card.buttons.map((x, j) => (j === slot ? patchButton(x, p) : x)),
                  })
                }
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}
