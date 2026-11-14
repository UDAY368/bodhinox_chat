'use client';

// "A/B variant": a second ad, with its own image and text, in the ad set of an
// ad already created from Bodhinox. Meta shares the ad set's budget between
// the two and favours the one that performs better.

import { useRef, useState } from 'react';
import { ImagePlus, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { authFetch } from '@/lib/auth/client';
import type { AdDraftDto } from '@/lib/meta-ads/create';

export function AdVariantDialog({ source, onClose, onCreated, replace = false }: {
  source: AdDraftDto;
  /** An edit of the running ad: the new version replaces it (the old one is paused once the new one exists). */
  replace?: boolean;
  onClose: () => void;
  onCreated: (draft: AdDraftDto) => void;
}) {
  const t = useTranslations('Ads.variant');
  const [name, setName] = useState(`${source.name} · ${replace ? 'v2' : 'B'}`.slice(0, 200));
  const [primaryText, setPrimaryText] = useState('');
  const [headline, setHeadline] = useState('');
  const [image, setImage] = useState<{ hash: string; url: string | null; preview: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const upload = async (file: File) => {
    if (!/^image\/(jpeg|png)$/.test(file.type) || file.size > 8 * 1024 * 1024) { toast.error(t('imageRules')); return; }
    setUploading(true);
    try {
      const form = new FormData();
      form.set('file', file);
      form.set('adAccountId', source.adAccountId);
      const res = await authFetch('/api/meta-ads/images', { method: 'POST', body: form });
      const body = (await res.json().catch(() => ({}))) as { hash?: string; url?: string | null };
      if (!res.ok || !body.hash) throw new Error();
      setImage({ hash: body.hash, url: body.url ?? null, preview: URL.createObjectURL(file) });
    } catch {
      toast.error(t('failed'));
    } finally {
      setUploading(false);
    }
  };

  const submit = async () => {
    if (!image || !primaryText.trim()) return;
    setBusy(true);
    try {
      const res = await authFetch('/api/meta-ads/drafts', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'variant', sourceId: source.id, name: name.trim() || null, primaryText: primaryText.trim(),
          headline: headline.trim() || null, imageHash: image.hash, imageUrl: image.url, replace,
        }),
      });
      if (!res.ok) throw new Error();
      toast.success(t('created'));
      onCreated(((await res.json()) as { draft: AdDraftDto }).draft);
    } catch {
      toast.error(t('failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <DialogContent className="sm:max-w-xl" data-testid="ad-variant-dialog">
        <DialogHeader>
          <DialogTitle>{t(replace ? 'editTitle' : 'title')}</DialogTitle>
          <DialogDescription>{t(replace ? 'editDescription' : 'description', { name: source.name })}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="variant-name">{t('name')}</Label>
              <Input id="variant-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="variant-text">{t('primaryText')}</Label>
              <Textarea id="variant-text" rows={4} maxLength={2000} value={primaryText} onChange={(e) => setPrimaryText(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="variant-headline">{t('headline')}</Label>
              <Input id="variant-headline" maxLength={255} value={headline} onChange={(e) => setHeadline(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1">
            <Label>{t('image')}</Label>
            <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading}
              aria-label={image ? t('replaceImage') : t('uploadImage')}
              className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-xl border border-dashed border-border bg-muted/40 text-muted-foreground hover:bg-muted">
              {uploading ? <Loader2 className="size-5 animate-spin" />
                // A local preview of the chosen file (blob: URL).
                // eslint-disable-next-line @next/next/no-img-element
                : image ? <img src={image.preview} alt="" className="size-full object-cover" />
                : <span className="flex flex-col items-center gap-1 text-xs"><ImagePlus className="size-5" />{t('uploadImage')}</span>}
            </button>
            <input ref={fileRef} type="file" accept="image/jpeg,image/png" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{t('help')}</p>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>{t('cancel')}</Button>
          <Button type="button" onClick={() => void submit()} disabled={busy || uploading || !image || !primaryText.trim()}>
            {busy && <Loader2 className="size-4 animate-spin" />} {t(replace ? 'editCreate' : 'create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
