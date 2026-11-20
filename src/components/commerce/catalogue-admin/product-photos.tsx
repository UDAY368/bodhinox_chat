"use client";

/**
 * Product photos in the product form: drop files, pick them, or take one with
 * the phone camera. Each file uploads to the media library the moment it is
 * added (the same path as the media picker); the product links the photos on
 * Save. Drag to reorder, or use the arrow buttons (keyboard and touch). The
 * first photo is the cover. Up to ten.
 */
import { useRef, useState } from "react";
import { Camera, ChevronLeft, ChevronRight, ImagePlus, Library, Link2, Loader2, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MediaPicker } from "@/components/inbox/media-library/media-picker";
import { uploadPhoto } from "./catalogue-api";
import type { FormImage } from "./product-form-state";

const MAX = 10;
const LINK = /^https:\/\/\S{3,2040}$/;

export function ProductPhotos({ images, onChange, readOnly }: {
  images: FormImage[]; onChange: (next: (list: FormImage[]) => FormImage[]) => void; readOnly: boolean;
}) {
  const t = useTranslations("Commerce.catalogue.form.photos");
  const [uploading, setUploading] = useState(0);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [url, setUrl] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const room = MAX - images.length - uploading;

  const addFiles = async (files: File[]) => {
    const list = files.filter((f) => f.type.startsWith("image/")).slice(0, Math.max(room, 0));
    if (files.length && !list.length) { toast.error(room <= 0 ? t("full") : t("imageOnly")); return; }
    setUploading((n) => n + list.length);
    await Promise.all(list.map(async (file) => {
      const r = await uploadPhoto(file);
      setUploading((n) => n - 1);
      if (!r.ok) { toast.error(r.status === 413 || r.code === "invalid_upload" ? t("rejected") : t("failed")); return; }
      onChange((imgs) => (imgs.length >= MAX ? imgs : [...imgs, { media_id: r.data.id, display: r.data.url }]));
    }));
  };

  const addLink = () => {
    const value = url.trim();
    if (!LINK.test(value) || room <= 0) return;
    onChange((imgs) => [...imgs, { url: value, display: value }]);
    setUrl("");
    setLinkOpen(false);
  };

  const move = (from: number, to: number) => onChange((imgs) => {
    if (to < 0 || to >= imgs.length || from === to) return imgs;
    const next = [...imgs];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return next;
  });

  return (
    <div
      className={`space-y-3 rounded-xl border border-dashed p-3 ${dropActive ? "border-primary bg-primary/5" : "border-border"}`}
      onDragOver={(e) => { if (!readOnly && e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDropActive(true); } }}
      onDragLeave={() => setDropActive(false)}
      onDrop={(e) => {
        setDropActive(false);
        if (readOnly || !e.dataTransfer.files.length) return;
        e.preventDefault();
        void addFiles(Array.from(e.dataTransfer.files));
      }}>
      <ul className="flex flex-wrap gap-3" aria-label={t("title")}>
        {images.map((img, i) => (
          <li key={"media_id" in img ? img.media_id : `${img.url}-${i}`}
            draggable={!readOnly}
            onDragStart={() => setDragFrom(i)}
            onDragOver={(e) => { if (dragFrom !== null) e.preventDefault(); }}
            onDrop={(e) => { if (dragFrom === null) return; e.preventDefault(); e.stopPropagation(); move(dragFrom, i); setDragFrom(null); }}
            onDragEnd={() => setDragFrom(null)}
            className={`group relative h-24 w-24 overflow-hidden rounded-lg border border-border bg-muted ${dragFrom === i ? "opacity-50" : ""}`}>
            {img.display
              // eslint-disable-next-line @next/next/no-img-element -- seller-provided https or library images
              ? <img src={img.display} alt="" className="size-full object-cover" referrerPolicy="no-referrer" loading="lazy" />
              : <span className="block size-full" />}
            {i === 0 && <span className="absolute left-1 top-1 rounded bg-background/90 px-1.5 py-0.5 text-[11px] font-medium text-foreground">{t("cover")}</span>}
            {!readOnly && (
              <span className="absolute inset-x-0 bottom-0 flex justify-between bg-background/85 p-0.5">
                <Button type="button" size="icon-sm" variant="ghost" aria-label={t("moveEarlier", { n: i + 1 })} disabled={i === 0} onClick={() => move(i, i - 1)}>
                  <ChevronLeft className="size-3.5" />
                </Button>
                <Button type="button" size="icon-sm" variant="ghost" aria-label={t("remove", { n: i + 1 })}
                  onClick={() => onChange((imgs) => imgs.filter((_, j) => j !== i))}>
                  <Trash2 className="size-3.5" />
                </Button>
                <Button type="button" size="icon-sm" variant="ghost" aria-label={t("moveLater", { n: i + 1 })} disabled={i === images.length - 1} onClick={() => move(i, i + 1)}>
                  <ChevronRight className="size-3.5" />
                </Button>
              </span>
            )}
          </li>
        ))}
        {Array.from({ length: uploading }, (_, i) => (
          <li key={`up-${i}`} className="flex h-24 w-24 animate-pulse items-center justify-center rounded-lg bg-muted" aria-label={t("uploading")}>
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </li>
        ))}
      </ul>
      {images.length === 0 && uploading === 0 && <p className="text-sm text-muted-foreground">{t("empty")}</p>}
      {!readOnly && (
        <>
          <div className="flex flex-wrap gap-2">
            <input ref={fileInput} type="file" accept="image/*" multiple className="hidden"
              onChange={(e) => { void addFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
            <input ref={cameraInput} type="file" accept="image/*" capture="environment" className="hidden"
              onChange={(e) => { void addFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
            <Button type="button" variant="outline" className="min-h-11 sm:min-h-9" disabled={room <= 0} onClick={() => fileInput.current?.click()}>
              <ImagePlus className="size-4" />{t("add")}
            </Button>
            <Button type="button" variant="outline" className="min-h-11 sm:hidden" disabled={room <= 0} onClick={() => cameraInput.current?.click()}>
              <Camera className="size-4" />{t("camera")}
            </Button>
            <Button type="button" variant="ghost" className="min-h-11 sm:min-h-9" disabled={room <= 0} onClick={() => setPickerOpen(true)}>
              <Library className="size-4" />{t("library")}
            </Button>
            <Button type="button" variant="ghost" className="min-h-11 sm:min-h-9" disabled={room <= 0} aria-expanded={linkOpen} onClick={() => setLinkOpen((o) => !o)}>
              <Link2 className="size-4" />{t("link")}
            </Button>
          </div>
          {linkOpen && (
            <div className="flex flex-wrap gap-2">
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" aria-label={t("linkLabel")} className="max-w-md"
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addLink(); } }} />
              <Button type="button" variant="outline" disabled={!LINK.test(url.trim())} onClick={addLink}>{t("addLink")}</Button>
            </div>
          )}
          <p className="text-xs text-muted-foreground">{t("hint")}</p>
          <MediaPicker open={pickerOpen} onOpenChange={setPickerOpen} initialKind="image" onPick={(media) => {
            // Only an image can be shown on a product (the server refuses anything else).
            if (media.kind !== "image") { toast.error(t("imageOnly")); return; }
            onChange((imgs) => (imgs.length >= MAX || imgs.some((i) => "media_id" in i && i.media_id === media.id)
              ? imgs : [...imgs, { media_id: media.id, display: media.url }]));
          }} />
        </>
      )}
    </div>
  );
}
