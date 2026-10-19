'use client';

import {
  List,
  Reply,
  ExternalLink,
  FileText,
  MapPin,
  Workflow,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type {
  InteractiveMessagePayload,
  InteractiveMedia,
} from '@/lib/whatsapp/interactive';

/**
 * WhatsApp-style read-only render of an interactive message. Used both
 * in the builder's live preview and by the inbox message bubble so a
 * sent buttons/list message shows the same way it does on the phone.
 *
 * Purely presentational — the buttons/rows are not clickable here (the
 * customer taps them on their own device). Kept namespace-free so it can
 * be dropped into the composer, the automation builder, and the
 * quick-replies manager without namespace coupling: the three fallback
 * labels shown for empty fields default to plain English, and a host
 * that has a translator can pass its own via `labels`.
 */
export interface InteractivePreviewLabels {
  /** Shown in place of an empty body. */
  body?: string;
  /** Shown in place of an untitled reply button. */
  button?: string;
  /** Shown in place of an empty list button label. */
  menu?: string;
  link?: string;
  automation?: string;
  flow?: string;
  location?: string;
  file?: string;
  image?: string;
  video?: string;
}

export function InteractivePreview({
  payload,
  className,
  labels,
  targetNames,
  showPrelude = true,
}: {
  payload: InteractiveMessagePayload;
  className?: string;
  labels?: InteractivePreviewLabels;
  targetNames?: Record<string, string>;
  /** Hide attachments already rendered as separate rows in the inbox. */
  showPrelude?: boolean;
}) {
  const bodyLabel = labels?.body ?? 'Message body…';
  const buttonLabel = labels?.button ?? 'Button';
  const menuLabel = labels?.menu ?? 'Menu';
  const separateMedia =
    payload.media &&
    (payload.kind === 'list' || payload.media.type === 'location');
  return (
    <div className="flex w-full max-w-[260px] flex-col gap-2">
      {showPrelude && separateMedia && (
        <MediaPreview media={payload.media!} labels={labels} />
      )}
      <div
        className={cn(
          'bg-card text-foreground ring-border w-full max-w-[260px] overflow-hidden rounded-lg shadow-sm ring-1',
          className
        )}
      >
        {payload.media && !separateMedia && (
          <MediaPreview media={payload.media} labels={labels} />
        )}
        <div className="px-3 py-2">
          {payload.header && (!payload.media || separateMedia) ? (
            <p className="mb-1 text-sm font-semibold break-words">
              {payload.header}
            </p>
          ) : null}
          <p className="text-sm break-words whitespace-pre-wrap">
            {payload.body || (
              <span className="text-muted-foreground">{bodyLabel}</span>
            )}
          </p>
          {payload.footer ? (
            <p className="text-muted-foreground mt-1 text-[11px] break-words">
              {payload.footer}
            </p>
          ) : null}
        </div>

        {payload.kind === 'buttons' ? (
          <div className="border-border flex flex-col border-t">
            {payload.buttons.map((b, i) => (
              <button
                key={b.id || i}
                type="button"
                disabled
                className="border-border text-primary flex items-center justify-center gap-1.5 border-t py-2 text-sm font-medium first:border-t-0"
              >
                {b.action?.type === 'url' ? (
                  <ExternalLink className="h-3.5 w-3.5" />
                ) : b.action ? (
                  <Workflow className="h-3.5 w-3.5" />
                ) : (
                  <Reply className="h-3.5 w-3.5" />
                )}
                <span className="truncate">{b.title || buttonLabel}</span>
                {b.action && (
                  <span className="text-muted-foreground truncate text-[10px] font-normal">
                    {b.action.type === 'url'
                      ? (labels?.link ?? 'Open link')
                      : (targetNames?.[
                          `${b.action.type}:${b.action.targetId}`
                        ] ??
                        (b.action.type === 'flow'
                          ? (labels?.flow ?? 'Flow')
                          : (labels?.automation ?? 'Automation')))}
                  </span>
                )}
              </button>
            ))}
          </div>
        ) : (
          <button
            type="button"
            disabled
            className="border-border text-primary flex w-full items-center justify-center gap-1.5 border-t py-2 text-sm font-medium"
          >
            <List className="h-3.5 w-3.5" />
            <span className="truncate">
              {payload.button_label || menuLabel}
            </span>
          </button>
        )}
      </div>
    </div>
  );
}

function MediaPreview({
  media,
  labels,
}: {
  media: InteractiveMedia;
  labels?: InteractivePreviewLabels;
}) {
  if (media.type === 'location')
    return (
      <div className="border-border bg-card rounded-lg border p-3 text-sm">
        <div className="bg-muted mb-2 flex h-20 items-center justify-center rounded">
          <MapPin className="text-primary h-7 w-7" />
        </div>
        <p className="font-medium break-words">
          {media.name || labels?.location || 'Location'}
        </p>
        {media.address && (
          <p className="text-muted-foreground text-xs break-words">
            {media.address}
          </p>
        )}
        {Number.isFinite(media.latitude) &&
          Number.isFinite(media.longitude) && (
            <p className="text-muted-foreground text-xs">
              {media.latitude}, {media.longitude}
            </p>
          )}
      </div>
    );
  if (media.type === 'image')
    return media.url ? (
      // eslint-disable-next-line @next/next/no-img-element -- Private storage URLs are served through the authenticated object route.
      <img
        src={media.url}
        alt={labels?.image ?? 'Image attachment'}
        className="max-h-44 w-full rounded-t-lg object-contain"
      />
    ) : (
      <p className="text-muted-foreground p-3 text-xs">
        {labels?.image ?? 'Image attachment'}
      </p>
    );
  if (media.type === 'video')
    return media.url ? (
      <video
        src={media.url}
        controls
        preload="metadata"
        aria-label={labels?.video ?? 'Video attachment'}
        className="max-h-44 w-full rounded-t-lg"
      />
    ) : (
      <p className="text-muted-foreground p-3 text-xs">
        {labels?.video ?? 'Video attachment'}
      </p>
    );
  return (
    <div className="border-border bg-muted/50 flex items-center gap-2 rounded-lg border p-3 text-sm">
      <FileText className="h-5 w-5 shrink-0" />
      <span className="break-all">
        {media.filename || labels?.file || 'File attachment'}
      </span>
    </div>
  );
}
