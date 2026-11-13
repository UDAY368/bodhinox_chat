'use client';

import {
  Copy,
  ExternalLink,
  FileText,
  Film,
  Gift,
  ImageIcon,
  MapPin,
  Phone,
  Reply,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { TemplateButton } from '@/types';
import { cn } from '@/lib/utils';
import { previewSegments } from './template-studio-helpers';
import type { TemplateDraftInput } from './types';

/** Rendered as the code in the authentication preview; never sent. */
const SAMPLE_AUTH_CODE = '123456';

function VarText({
  text,
  samples,
}: {
  text: string | undefined;
  samples?: readonly string[];
}) {
  return (
    <>
      {previewSegments(text, samples).map((seg, i) =>
        seg.kind === 'text' ? (
          <span key={i}>{seg.value}</span>
        ) : seg.sample ? (
          <span key={i} className="font-medium text-primary">
            {seg.sample}
          </span>
        ) : (
          <span
            key={i}
            className="mx-0.5 rounded bg-primary/15 px-1 font-mono text-[0.7rem] text-primary"
          >
            {`{{${seg.index}}}`}
          </span>
        )
      )}
    </>
  );
}

function MediaPlaceholder({
  type,
  url,
  className,
}: {
  type: 'image' | 'video' | 'document' | 'location';
  url?: string;
  className?: string;
}) {
  const t = useTranslations('Templates.studio.preview');
  const Icon =
    type === 'image'
      ? ImageIcon
      : type === 'video'
        ? Film
        : type === 'document'
          ? FileText
          : MapPin;
  // Only the file name of a supplied URL is shown: previews never load
  // remote media, so a draft cannot trigger requests to arbitrary hosts.
  const fileName = url ? url.split(/[?#]/)[0].split('/').pop() : '';
  return (
    <div
      className={cn(
        'flex h-28 flex-col items-center justify-center gap-1 rounded-md bg-muted text-muted-foreground',
        className
      )}
    >
      <Icon className="size-6" aria-hidden />
      <span className="text-[0.7rem]">{t(`media.${type}`)}</span>
      {fileName && (
        <span className="max-w-full truncate px-2 text-[0.65rem]">{fileName}</span>
      )}
    </div>
  );
}

function ButtonRow({ button }: { button: TemplateButton }) {
  const Icon =
    button.type === 'URL'
      ? ExternalLink
      : button.type === 'PHONE_NUMBER'
        ? Phone
        : button.type === 'COPY_CODE'
          ? Copy
          : Reply;
  return (
    <div className="flex items-center justify-center gap-1.5 border-t border-border/60 py-1.5 text-xs font-semibold text-primary">
      <Icon className="size-3.5" aria-hidden />
      <span className="truncate">{button.text}</span>
    </div>
  );
}

/**
 * WhatsApp-style bubble preview of a draft template, for every template
 * kind. Variables show their sample value when one is set, otherwise a
 * {{n}} chip. Purely presentational: no fetches, no remote media.
 */
export function TemplatePreview({ template }: { template: TemplateDraftInput }) {
  const t = useTranslations('Templates.studio.preview');
  const kind = template.template_kind ?? 'standard';
  const bodySamples = template.sample_values?.body;

  if (kind === 'authentication') {
    const auth = template.auth_options;
    return (
      <div className="rounded-xl bg-muted p-3" aria-label={t('label')}>
        <div className="max-w-[18rem] overflow-hidden rounded-[4px_14px_14px_14px] bg-card text-sm shadow-sm">
          <div className="space-y-1 px-3 pt-2 pb-1.5">
            <p>
              {t('authBody', { code: SAMPLE_AUTH_CODE })}
              {auth?.add_security_recommendation && ` ${t('authSecurity')}`}
            </p>
            {auth?.code_expiration_minutes ? (
              <p className="text-xs text-muted-foreground">
                {t('authExpiry', { minutes: auth.code_expiration_minutes })}
              </p>
            ) : null}
          </div>
          <ButtonRow
            button={{
              type: 'COPY_CODE',
              text: auth?.button_text || t('copyCode'),
              example: SAMPLE_AUTH_CODE,
            }}
          />
        </div>
        <p className="mt-2 text-[0.7rem] text-muted-foreground">{t('authNote')}</p>
      </div>
    );
  }

  const header = (() => {
    const type = template.header_type;
    if (!type) return null;
    if (type === 'text') {
      return template.header_content ? (
        <p className="px-3 pt-2 font-semibold">
          <VarText
            text={template.header_content}
            samples={template.sample_values?.header}
          />
        </p>
      ) : null;
    }
    return (
      <div className="p-1">
        <MediaPlaceholder type={type} url={template.header_media_url} />
      </div>
    );
  })();

  return (
    <div className="rounded-xl bg-muted p-3" aria-label={t('label')}>
      <div className="max-w-[18rem] overflow-hidden rounded-[4px_14px_14px_14px] bg-card text-sm shadow-sm">
        {header}
        {kind === 'limited_time_offer' && template.lto && (
          <div className="mx-1 mt-1 flex items-center gap-2 rounded-md bg-muted px-2 py-1.5">
            <Gift className="size-4 shrink-0 text-primary" aria-hidden />
            <div className="min-w-0">
              <p className="truncate text-xs font-semibold">
                {template.lto.text || t('ltoPlaceholder')}
              </p>
              {template.lto.has_expiration && (
                <p className="text-[0.7rem] text-muted-foreground">{t('ltoExpires')}</p>
              )}
            </div>
          </div>
        )}
        <p className="px-3 pt-2 pb-1.5 whitespace-pre-wrap">
          {template.body_text ? (
            <VarText text={template.body_text} samples={bodySamples} />
          ) : (
            <span className="text-muted-foreground">{t('emptyBody')}</span>
          )}
        </p>
        {template.footer_text && (
          <p className="px-3 pb-1.5 text-xs text-muted-foreground">
            {template.footer_text}
          </p>
        )}
        {(template.buttons ?? []).map((b, i) => (
          <ButtonRow key={i} button={b} />
        ))}
      </div>
      {kind === 'carousel' && (
        <div
          className="mt-2 flex snap-x gap-2 overflow-x-auto pb-1"
          role="list"
          aria-label={t('cards')}
        >
          {(template.cards ?? []).map((card, i) => (
            <div
              key={i}
              role="listitem"
              aria-label={t('cardN', { n: i + 1 })}
              className="w-44 shrink-0 snap-start overflow-hidden rounded-lg bg-card text-sm shadow-sm"
            >
              <div className="p-1">
                <MediaPlaceholder
                  type={card.header_type}
                  url={card.header_media_url}
                  className="h-24"
                />
              </div>
              <p className="px-2 pb-1.5 text-xs whitespace-pre-wrap">
                <VarText text={card.body_text} samples={card.sample_values?.body} />
              </p>
              {card.buttons.map((b, j) => (
                <ButtonRow key={j} button={b} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
