'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/data/client';
import { Contact, CustomField, MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ArrowLeft, ArrowRight, Eye, ImageIcon, Loader2, MapPin, TicketPercent } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { trackedButtonIndex, validTrackedUrl } from '@/lib/broadcasts/tracking';
import {
  COUPON_CODE_MAX_LENGTH,
  cardVariableKey,
  parseLocation,
  templateSendNeeds,
  type CampaignSendExtras,
} from '@/lib/whatsapp/template-send-params';

type VariableType = 'static' | 'field' | 'custom_field' | 'csv_column';

interface VariableMapping {
  type: VariableType;
  value: string;
}

interface Step3Props {
  template: MessageTemplate;
  variables: Record<string, VariableMapping>;
  onUpdate: (variables: Record<string, VariableMapping>) => void;
  /** Media URL for an IMAGE/VIDEO/DOCUMENT header, when the template has one. */
  headerMediaUrl: string;
  onHeaderMediaUrlChange: (url: string) => void;
  /** Columns of an uploaded CSV audience; each row fills its own value. Empty otherwise. */
  csvColumns?: string[];
  /** First CSV row's values, for the preview. */
  csvSample?: Record<string, string>;
  /** Destination for a click-tracked link button (only asked for trackable templates). */
  trackedUrl?: string;
  onTrackedUrlChange?: (url: string) => void;
  /** Location, offer end and coupon code: one value for every recipient. */
  sendExtras?: CampaignSendExtras;
  onSendExtrasChange?: (extras: CampaignSendExtras) => void;
  onNext: () => void;
  onBack: () => void;
}

const MEDIA_HEADER_TYPES = ['image', 'video', 'document'] as const;
type MediaHeaderType = (typeof MEDIA_HEADER_TYPES)[number];

function isMediaHeaderType(value: unknown): value is MediaHeaderType {
  return MEDIA_HEADER_TYPES.includes(value as MediaHeaderType);
}

function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

const contactFields = [
  { value: 'name', labelKey: 'name' },
  { value: 'phone', labelKey: 'phone' },
  { value: 'email', labelKey: 'email' },
];

const SAMPLE_CONTACT: Contact = {
  id: 'sample',
  user_id: '',
  account_id: '',
  name: 'John Doe',
  phone: '+1234567890',
  email: 'john@example.com',
  company: 'Acme Corp',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

export function Step3Personalize({
  template,
  variables,
  onUpdate,
  headerMediaUrl,
  onHeaderMediaUrlChange,
  csvColumns = [],
  csvSample,
  trackedUrl = '',
  onTrackedUrlChange,
  sendExtras = {},
  onSendExtrasChange,
  onNext,
  onBack,
}: Step3Props) {
  // The tracking button must point at this app; the origin is read after mount.
  const [origin, setOrigin] = useState('');
  useEffect(() => setOrigin(window.location.origin), []);
  const tracked = origin ? trackedButtonIndex(template, origin) >= 0 : false;
  const trackedInvalid = tracked && !validTrackedUrl(trackedUrl.trim());
  const t = useTranslations('Broadcasts.wizard');
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [loadingFields, setLoadingFields] = useState(true);
  const [firstContact, setFirstContact] = useState<Contact | null>(null);
  const [firstContactCustomValues, setFirstContactCustomValues] = useState<
    Map<string, string>
  >(new Map());
  const [loadingPreview, setLoadingPreview] = useState(true);

  // Load user's custom fields + a representative contact for the
  // live preview. Fall back to sample data if no contacts exist yet.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const db = createClient();
      const [fieldsRes, contactRes] = await Promise.all([
        db.from('custom_fields').select('*').order('field_name'),
        db
          .from('contacts')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      if (cancelled) return;

      setCustomFields(fieldsRes.data ?? []);
      setLoadingFields(false);

      const contact = contactRes.data ?? null;
      setFirstContact(contact);

      if (contact) {
        const { data: customVals } = await db
          .from('contact_custom_values')
          .select('custom_field_id, value')
          .eq('contact_id', contact.id);
        if (!cancelled) {
          const map = new Map<string, string>();
          for (const row of customVals ?? []) {
            map.set(row.custom_field_id, row.value ?? '');
          }
          setFirstContactCustomValues(map);
        }
      }
      setLoadingPreview(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const needs = useMemo(() => templateSendNeeds(template), [template]);
  const placeholders = useMemo(() => needs.bodyVars.map((n) => `{{${n}}}`), [needs]);
  // Every mapped slot: body placeholders, then each carousel card's
  // (keys "c<card>_<n>", frozen per recipient after the body values).
  const slots = useMemo(
    () => [
      ...needs.bodyVars.map((n) => ({ key: String(n), label: `{{${n}}}` })),
      ...needs.cards.flatMap((card) =>
        card.bodyVars.map((n) => ({
          key: cardVariableKey(card.index, n),
          label: t('personalize.cardVariable', { n: card.index + 1, var: `{{${n}}}` }),
        })),
      ),
    ],
    [needs, t],
  );

  // Typed text is kept here; the parent only ever holds valid values.
  const [locationDraft, setLocationDraft] = useState(() => ({
    latitude: sendExtras.location ? String(sendExtras.location.latitude) : '',
    longitude: sendExtras.location ? String(sendExtras.location.longitude) : '',
    name: sendExtras.location?.name ?? '',
    address: sendExtras.location?.address ?? '',
  }));
  const [offerEnds, setOfferEnds] = useState(() => {
    const ms = sendExtras.offerExpirationTimeMs;
    if (!ms) return '';
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });

  function updateExtras(patch: Partial<CampaignSendExtras>) {
    const next: CampaignSendExtras = { ...sendExtras, ...patch };
    for (const k of Object.keys(next) as (keyof CampaignSendExtras)[]) {
      if (next[k] === undefined) delete next[k];
    }
    onSendExtrasChange?.(next);
  }

  function changeLocation(patch: Partial<typeof locationDraft>) {
    const draft = { ...locationDraft, ...patch };
    setLocationDraft(draft);
    const parsed =
      draft.latitude.trim() && draft.longitude.trim() ? parseLocation(draft) : null;
    updateExtras({ location: parsed?.ok ? parsed.value : undefined });
  }

  function changeOfferEnds(value: string) {
    setOfferEnds(value);
    const ms = value ? new Date(value).getTime() : NaN;
    updateExtras({ offerExpirationTimeMs: Number.isFinite(ms) ? ms : undefined });
  }

  const locationError = needs.location && !sendExtras.location;
  // The server checks the end against the send (or schedule) time again.
  const offerPast = !!sendExtras.offerExpirationTimeMs && sendExtras.offerExpirationTimeMs <= Date.now();
  const offerError = needs.offerExpiration && (!sendExtras.offerExpirationTimeMs || offerPast);

  // Templates with an IMAGE/VIDEO/DOCUMENT header need a media URL at
  // send time — Meta requires the media component on every delivery and
  // rejects the broadcast without it. The field is hidden for text-only
  // headers.
  const mediaHeaderType = isMediaHeaderType(template.header_type)
    ? template.header_type
    : null;

  // Seed the field with the template's stored sample URL the first time
  // we land on a media-header template, so the common "reuse the
  // approved media" case needs no typing. Only seeds when empty to avoid
  // clobbering a URL the user already edited.
  useEffect(() => {
    if (mediaHeaderType && !headerMediaUrl && template.header_media_url) {
      onHeaderMediaUrlChange(template.header_media_url);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaHeaderType, template.header_media_url]);

  const headerMediaError = useMemo<'missing' | 'invalid' | null>(() => {
    if (!mediaHeaderType) return null;
    const value = headerMediaUrl.trim();
    if (!value) return 'missing';
    if (!isValidHttpUrl(value)) return 'invalid';
    return null;
  }, [mediaHeaderType, headerMediaUrl]);

  /**
   * A placeholder is "unmapped" if the user hasn't picked either a
   * static value or a field/custom-field source. Blocks Next until
   * every placeholder has something — otherwise the broadcast would
   * ship with empty strings and confuse recipients.
   */
  const unmappedKeys = useMemo(() => {
    const missing: string[] = [];
    for (const { key, label } of slots) {
      const mapping = variables[key];
      // A CSV-column mapping is stale once the audience is no longer that CSV.
      if (!mapping || !mapping.value?.trim() || (mapping.type === 'csv_column' && !csvColumns.includes(mapping.value))) {
        missing.push(label);
      }
    }
    return missing;
  }, [slots, variables, csvColumns]);

  function updateVariable(key: string, patch: Partial<VariableMapping>) {
    const current = variables[key] ?? { type: 'static' as VariableType, value: '' };
    onUpdate({
      ...variables,
      [key]: { ...current, ...patch },
    });
  }

  /**
   * Substitute placeholders using the first real contact where
   * possible. Placeholders keyed by "{{N}}" map to variable key "N".
   */
  const previewText = useMemo(() => {
    const contact = firstContact ?? {
      ...SAMPLE_CONTACT,
      name: t('personalize.sampleName'),
      company: t('personalize.sampleCompany'),
    };
    const customValues = firstContact
      ? firstContactCustomValues
      : new Map<string, string>();

    let text = template.body_text;
    for (const placeholder of placeholders) {
      const key = placeholder.replace(/^\{\{|\}\}$/g, '');
      const mapping = variables[key];
      let replacement = placeholder;

      if (mapping) {
        if (mapping.type === 'static' && mapping.value) {
          replacement = mapping.value;
        } else if (mapping.type === 'field' && mapping.value) {
          const fieldMap: Record<string, string | undefined> = {
            name: contact.name,
            phone: contact.phone,
            email: contact.email,
            company: contact.company,
          };
          replacement = fieldMap[mapping.value] ?? placeholder;
        } else if (mapping.type === 'custom_field' && mapping.value) {
          replacement = customValues.get(mapping.value) || placeholder;
        } else if (mapping.type === 'csv_column' && mapping.value) {
          replacement = csvSample?.[mapping.value] || placeholder;
        }
      }
      text = text.replaceAll(placeholder, replacement);
    }
    return text;
  }, [
    template.body_text,
    variables,
    placeholders,
    firstContact,
    firstContactCustomValues,
    csvSample,
    t,
  ]);

  const previewLabel = firstContact
    ? firstContact.name || firstContact.phone
    : t('personalize.previewSample');

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold text-foreground">{t('personalize.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('personalize.subtitle')}
        </p>
      </div>

      {mediaHeaderType && (
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="mb-3 flex items-center gap-2">
            <ImageIcon className="h-4 w-4 text-primary" />
            <p className="text-sm font-medium text-foreground">{t('personalize.headerImage')}</p>
            <span className="inline-flex items-center rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
              {mediaHeaderType}
            </span>
          </div>
          <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
            {t('personalize.imageUrl')}
          </label>
          <Input
            type="url"
            value={headerMediaUrl}
            onChange={(e) => onHeaderMediaUrlChange(e.target.value)}
            placeholder={t('personalize.imageUrlPlaceholder')}
            className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
          />
          <p className="mt-1.5 text-xs text-muted-foreground">
            {t('personalize.headerImageDesc')}
          </p>
          {mediaHeaderType === 'image' &&
            headerMediaError === null &&
            headerMediaUrl.trim() && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={headerMediaUrl.trim()}
                alt={t('personalize.headerPreviewAlt')}
                className="mt-3 max-h-40 rounded-lg border border-border object-contain"
              />
            )}
          {headerMediaError && (
            <p className="mt-1.5 text-xs text-amber-700 dark:text-amber-400">
              {headerMediaError === 'missing'
                ? t('personalize.mediaUrlRequired')
                : t('personalize.mediaUrlInvalid')}
            </p>
          )}
        </div>
      )}

      {needs.location && (
        <div className="space-y-3 rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2">
            <MapPin className="h-4 w-4 text-primary" />
            <p className="text-sm font-medium text-foreground">{t('personalize.locationTitle')}</p>
          </div>
          <p className="text-xs text-muted-foreground">{t('personalize.locationDesc')}</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="campaign-lat" className="mb-1.5 block text-xs font-medium text-muted-foreground">{t('personalize.latitude')}</label>
              <Input id="campaign-lat" inputMode="decimal" value={locationDraft.latitude} onChange={(e) => changeLocation({ latitude: e.target.value })} placeholder="37.4847" className="border-border bg-muted text-foreground placeholder:text-muted-foreground" />
            </div>
            <div>
              <label htmlFor="campaign-lng" className="mb-1.5 block text-xs font-medium text-muted-foreground">{t('personalize.longitude')}</label>
              <Input id="campaign-lng" inputMode="decimal" value={locationDraft.longitude} onChange={(e) => changeLocation({ longitude: e.target.value })} placeholder="-122.1484" className="border-border bg-muted text-foreground placeholder:text-muted-foreground" />
            </div>
            <div>
              <label htmlFor="campaign-loc-name" className="mb-1.5 block text-xs font-medium text-muted-foreground">{t('personalize.locationName')}</label>
              <Input id="campaign-loc-name" value={locationDraft.name} onChange={(e) => changeLocation({ name: e.target.value })} className="border-border bg-muted text-foreground placeholder:text-muted-foreground" />
            </div>
            <div>
              <label htmlFor="campaign-loc-address" className="mb-1.5 block text-xs font-medium text-muted-foreground">{t('personalize.locationAddress')}</label>
              <Input id="campaign-loc-address" value={locationDraft.address} onChange={(e) => changeLocation({ address: e.target.value })} className="border-border bg-muted text-foreground placeholder:text-muted-foreground" />
            </div>
          </div>
          {locationError && (
            <p className="text-xs text-amber-700 dark:text-amber-400">{t('personalize.locationRequired')}</p>
          )}
        </div>
      )}

      {(needs.offerExpiration || needs.couponButtons.length > 0) && (
        <div className="space-y-3 rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2">
            <TicketPercent className="h-4 w-4 text-primary" />
            <p className="text-sm font-medium text-foreground">{t('personalize.offerTitle')}</p>
          </div>
          {needs.offerExpiration && (
            <div>
              <label htmlFor="campaign-offer-ends" className="mb-1.5 block text-xs font-medium text-muted-foreground">{t('personalize.offerEnds')}</label>
              <Input id="campaign-offer-ends" type="datetime-local" value={offerEnds} onChange={(e) => changeOfferEnds(e.target.value)} className="border-border bg-muted text-foreground" />
              <p className="mt-1.5 text-xs text-muted-foreground">{t('personalize.offerEndsDesc')}</p>
              {offerError && (
                <p className="mt-1.5 text-xs text-amber-700 dark:text-amber-400">
                  {offerPast ? t('personalize.offerEndsPast') : t('personalize.offerEndsRequired')}
                </p>
              )}
            </div>
          )}
          {needs.couponButtons.map((b) => (
            <div key={b.index}>
              <label htmlFor="campaign-coupon" className="mb-1.5 block text-xs font-medium text-muted-foreground">{t('personalize.couponCode', { text: b.text })}</label>
              <Input
                id="campaign-coupon"
                value={sendExtras.couponCode ?? ''}
                maxLength={COUPON_CODE_MAX_LENGTH}
                onChange={(e) => updateExtras({ couponCode: e.target.value.trim() || undefined })}
                placeholder={b.example}
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
              />
              <p className="mt-1.5 text-xs text-muted-foreground">{t('personalize.couponCodeDesc')}</p>
            </div>
          ))}
        </div>
      )}

      {slots.length === 0 && !mediaHeaderType ? (
        <div className="rounded-xl border border-border bg-card p-6 text-center">
          <p className="text-sm text-muted-foreground">
            {t('personalize.noPreview')}
          </p>
        </div>
      ) : slots.length === 0 ? null : (
        <div className="space-y-4">
          {slots.map(({ key, label }) => {
            const mapping = variables[key] ?? { type: 'static', value: '' };

            return (
              <div
                key={key}
                className="rounded-xl border border-border bg-card p-4"
              >
                <div className="mb-3 flex items-center gap-2">
                  <span className="inline-flex items-center rounded-md bg-primary/10 px-2 py-0.5 text-xs font-mono font-medium text-primary">
                    {label}
                  </span>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                      {t('personalize.type')}
                    </label>
                    <Select
                      value={mapping.type}
                      onValueChange={(val) =>
                        updateVariable(key, {
                          type: val as VariableType,
                          value: '',
                        })
                      }
                    >
                      <SelectTrigger className="w-full border-border bg-muted text-foreground">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="border-border bg-popover">
                        <SelectItem value="static">{t('personalize.typeStatic')}</SelectItem>
                        <SelectItem value="field">{t('personalize.typeContact')}</SelectItem>
                        <SelectItem value="custom_field">
                          {t('personalize.typeCustom')}
                        </SelectItem>
                        {csvColumns.length > 0 && (
                          <SelectItem value="csv_column">{t('personalize.typeCsv')}</SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                      {mapping.type === 'static' ? t('personalize.staticValue') : t('personalize.contactField')}
                    </label>
                    {mapping.type === 'static' ? (
                      <Input
                        value={mapping.value}
                        onChange={(e) =>
                          updateVariable(key, { value: e.target.value })
                        }
                        placeholder={t('personalize.enterValue')}
                        className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                      />
                    ) : mapping.type === 'field' ? (
                      <Select
                        value={mapping.value || undefined}
                        onValueChange={(val) =>
                          updateVariable(key, { value: val || '' })
                        }
                      >
                        <SelectTrigger className="w-full border-border bg-muted text-foreground">
                          <SelectValue placeholder={t('personalize.selectContactField')} />
                        </SelectTrigger>
                        <SelectContent className="border-border bg-popover">
                          {contactFields.map((field) => (
                            <SelectItem key={field.value} value={field.value}>
                              {t(`personalize.fieldMap.${field.labelKey}`)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : mapping.type === 'csv_column' ? (
                      <Select
                        value={mapping.value || undefined}
                        onValueChange={(val) => updateVariable(key, { value: val || '' })}
                      >
                        <SelectTrigger className="w-full border-border bg-muted text-foreground">
                          <SelectValue placeholder={t('personalize.selectCsvColumn')} />
                        </SelectTrigger>
                        <SelectContent className="border-border bg-popover">
                          {csvColumns.map((column) => (
                            <SelectItem key={column} value={column}>{column}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Select
                        value={mapping.value || undefined}
                        onValueChange={(val) =>
                          updateVariable(key, { value: val || '' })
                        }
                      >
                        <SelectTrigger className="w-full border-border bg-muted text-foreground">
                          <SelectValue
                            placeholder={
                              loadingFields
                                ? t('personalize.loadingFields')
                                : customFields.length === 0
                                  ? t('personalize.noCustomFields')
                                  : t('personalize.selectCustomField')
                            }
                          />
                        </SelectTrigger>
                        <SelectContent className="border-border bg-popover">
                          {customFields.map((f) => (
                            <SelectItem key={f.id} value={f.id}>
                              {f.field_name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Live Preview — rendered as a WhatsApp-style bubble so the user
          sees approximately what the recipient will see. */}
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="mb-3 flex items-center gap-2">
          <Eye className="h-4 w-4 text-primary" />
          <p className="text-sm font-medium text-foreground">{t('personalize.preview')}</p>
          <span className="text-xs text-muted-foreground">({previewLabel})</span>
          {loadingPreview && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
          )}
        </div>
        <div className="rounded-xl bg-muted p-3">
          <div className="w-fit max-w-[90%] rounded-[4px_14px_14px_14px] bg-card px-3 py-2 shadow-sm">
            <p className="whitespace-pre-wrap break-words text-sm text-foreground">
              {previewText}
            </p>
          </div>
        </div>
      </div>

      {tracked && (
        <div className="space-y-1.5 rounded-xl border border-border bg-card p-4">
          <label htmlFor="tracked-url" className="block text-sm font-medium text-foreground">{t('personalize.trackedUrl')}</label>
          <Input
            id="tracked-url"
            type="url"
            value={trackedUrl}
            onChange={(e) => onTrackedUrlChange?.(e.target.value)}
            placeholder="https://example.com/offer"
            className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
          />
          <p className="text-xs text-muted-foreground">
            {trackedUrl.trim() && trackedInvalid ? t('personalize.trackedUrlInvalid') : t('personalize.trackedUrlHint')}
          </p>
        </div>
      )}

      {unmappedKeys.length > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          {t.rich('personalize.unmappedWarning', {
            keys: unmappedKeys.join(', '),
            mono: (chunks) => <span className="font-mono font-semibold">{chunks}</span>,
          })}
        </div>
      )}

      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          className="text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('back')}
        </Button>
        <Button
          onClick={onNext}
          disabled={unmappedKeys.length > 0 || headerMediaError !== null || trackedInvalid || locationError || offerError}
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {t('next')}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
