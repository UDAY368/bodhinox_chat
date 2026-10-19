'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import {
  uploadAccountMedia,
  MEDIA_MAX_BYTES_BY_KIND,
} from '@/lib/storage/upload-media';
import type { InteractiveMedia } from '@/lib/whatsapp/interactive';

export function InteractiveMediaEditor({
  value,
  onChange,
}: {
  value?: InteractiveMedia;
  onChange: (media?: InteractiveMedia) => void;
}) {
  const t = useTranslations('Interactive');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    []
  );
  const kind = value?.type ?? 'text';

  async function upload(file?: File) {
    if (!file || !value || value.type === 'location') return;
    const current = ++generation.current;
    const type = value.type;
    setError('');
    if (file.size > MEDIA_MAX_BYTES_BY_KIND[type]) {
      setError(
        t('mediaTooLarge', {
          size: MEDIA_MAX_BYTES_BY_KIND[type] / 1024 / 1024,
        })
      );
      return;
    }
    if (
      (type === 'image' && !['image/jpeg', 'image/png'].includes(file.type)) ||
      (type === 'video' && !['video/mp4', 'video/3gpp'].includes(file.type))
    ) {
      setError(t('mediaUnsupported'));
      return;
    }
    setBusy(true);
    try {
      const result = await uploadAccountMedia('flow-media', file);
      if (generation.current === current)
        onChange({
          type,
          url: result.publicUrl,
          ...(type === 'document' ? { filename: file.name } : {}),
        });
    } catch (err) {
      if (generation.current === current)
        setError(err instanceof Error ? err.message : t('uploadFailed'));
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }

  return (
    <div className="border-border flex flex-col gap-2 rounded-md border p-2">
      <label className="text-muted-foreground flex flex-col gap-1 text-xs">
        {t('media')}
        <select
          aria-label={t('media')}
          value={kind}
          className="border-input bg-muted text-foreground h-9 rounded-md border px-2 text-sm"
          onChange={(e) => {
            generation.current++;
            setBusy(false);
            setError('');
            const type = e.target.value as InteractiveMedia['type'] | 'text';
            onChange(
              type === 'text'
                ? undefined
                : type === 'location'
                  ? { type, latitude: Number.NaN, longitude: Number.NaN }
                  : { type, url: '' }
            );
          }}
        >
          <option value="text">{t('mediaText')}</option>
          <option value="image">{t('mediaImage')}</option>
          <option value="video">{t('mediaVideo')}</option>
          <option value="location">{t('mediaLocation')}</option>
          <option value="document">{t('mediaFile')}</option>
        </select>
      </label>
      {value?.type === 'location' ? (
        <>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-muted-foreground text-xs">
              {t('latitude')}
              <Input
                aria-label={t('latitude')}
                type="number"
                step="any"
                min={-90}
                max={90}
                value={Number.isNaN(value.latitude) ? '' : value.latitude}
                onChange={(e) =>
                  onChange({ ...value, latitude: e.target.valueAsNumber })
                }
              />
            </label>
            <label className="text-muted-foreground text-xs">
              {t('longitude')}
              <Input
                aria-label={t('longitude')}
                type="number"
                step="any"
                min={-180}
                max={180}
                value={Number.isNaN(value.longitude) ? '' : value.longitude}
                onChange={(e) =>
                  onChange({ ...value, longitude: e.target.valueAsNumber })
                }
              />
            </label>
          </div>
          <Input
            aria-label={t('locationName')}
            placeholder={t('locationName')}
            value={value.name ?? ''}
            onChange={(e) => onChange({ ...value, name: e.target.value })}
          />
          <Input
            aria-label={t('locationAddress')}
            placeholder={t('locationAddress')}
            value={value.address ?? ''}
            onChange={(e) => onChange({ ...value, address: e.target.value })}
          />
        </>
      ) : value ? (
        <>
          <Input
            aria-label={t('mediaUrl')}
            placeholder={t('mediaUrl')}
            value={value.url}
            disabled={busy}
            onChange={(e) => onChange({ ...value, url: e.target.value })}
          />
          {value.type === 'document' && (
            <Input
              aria-label={t('filename')}
              placeholder={t('filename')}
              value={value.filename ?? ''}
              disabled={busy}
              onChange={(e) => onChange({ ...value, filename: e.target.value })}
            />
          )}
          <label className="text-muted-foreground flex flex-col gap-1 text-xs">
            {busy ? t('uploading') : t('uploadMedia')}
            <input
              aria-label={t('uploadMedia')}
              type="file"
              disabled={busy}
              accept={
                value.type === 'image'
                  ? 'image/jpeg,image/png'
                  : value.type === 'video'
                    ? 'video/mp4,video/3gpp'
                    : undefined
              }
              onChange={(e) => {
                void upload(e.target.files?.[0]);
                e.target.value = '';
              }}
              className="max-w-full min-w-0 text-xs"
            />
          </label>
        </>
      ) : null}
      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
