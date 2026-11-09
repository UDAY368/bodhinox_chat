"use client";

/**
 * Media library: files agents uploaded once to reuse in the inbox. The
 * picker lists them newest first with a kind filter and search, uploads
 * new files through /api/media/library, and hands the chosen one back
 * with its private proxy URL. `MediaLibraryBrowser` is the same grid in
 * manage mode (delete, no pick) for Settings. A delete of a file that a
 * recent message, template or flow still uses only hides it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, Film, Loader2, Music, Search, Trash2, Upload } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { authFetch } from "@/lib/auth/client";
import { cn } from "@/lib/utils";

export type MediaKind = "image" | "video" | "audio" | "document";
export interface PickedMedia {
  id: string;
  url: string;
  kind: MediaKind;
  filename: string;
}
export interface LibraryItem extends PickedMedia {
  content_type: string;
  byte_size: number;
  uploaded_by: string | null;
  created_at: string;
  can_delete: boolean;
}
export interface StorageUsage {
  used_bytes: number;
  library_bytes: number;
  library_count: number;
  limit_bytes: number | null;
}
interface LibraryPage {
  items: LibraryItem[];
  next_cursor: string | null;
  can_upload: boolean;
  usage?: StorageUsage;
}

const ENDPOINT = "/api/media/library";
const KINDS: (MediaKind | "all")[] = ["all", "image", "video", "audio", "document"];
const ACCEPT = "image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,video/3gpp,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,text/plain";

/** Bytes as the largest whole unit, e.g. "4.2 MB", in the viewer's locale. */
export function useFormatBytes() {
  const format = useFormatter();
  return useCallback((bytes: number) => {
    const units = ["byte", "kilobyte", "megabyte", "gigabyte"] as const;
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
    return format.number(value, { style: "unit", unit: units[unit], unitDisplay: "short", maximumFractionDigits: unit === 0 ? 0 : 1 });
  }, [format]);
}

function Thumb({ item }: { item: LibraryItem }) {
  if (item.kind === "image")
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={item.url} alt="" loading="lazy" className="size-full object-cover" />;
  const Icon = item.kind === "video" ? Film : item.kind === "audio" ? Music : FileText;
  return <Icon className="size-8 text-muted-foreground" aria-hidden />;
}

export function MediaLibraryBrowser({ mode, onPick, onUsage, initialKind = "all" }: {
  mode: "pick" | "manage";
  onPick?: (media: PickedMedia) => void;
  onUsage?: (usage: StorageUsage) => void;
  /** The kind filter to start on (e.g. "image" when only an image can be used). */
  initialKind?: MediaKind | "all";
}) {
  const t = useTranslations("MediaLibrary");
  const formatBytes = useFormatBytes();
  const [kind, setKind] = useState<MediaKind | "all">(initialKind);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [canUpload, setCanUpload] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const request = useRef(0);

  useEffect(() => {
    const id = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(id);
  }, [search]);

  const load = useCallback(async (after: string | null) => {
    const ticket = ++request.current;
    setLoading(true);
    setFailed(false);
    const params = new URLSearchParams();
    if (kind !== "all") params.set("kind", kind);
    if (query) params.set("q", query);
    if (after) params.set("cursor", after);
    try {
      const res = await authFetch(`${ENDPOINT}?${params}`, { cache: "no-store" });
      if (!res.ok) throw new Error();
      const page = (await res.json()) as LibraryPage;
      if (ticket !== request.current) return;
      setItems((prev) => (after ? [...prev, ...page.items] : page.items));
      setCursor(page.next_cursor);
      setCanUpload(page.can_upload);
      if (page.usage) onUsage?.(page.usage);
    } catch {
      if (ticket === request.current) setFailed(true);
    } finally {
      if (ticket === request.current) setLoading(false);
    }
  }, [kind, query, onUsage]);

  useEffect(() => { void load(null); }, [load]);

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const form = new FormData();
      form.set("file", file);
      const res = await authFetch(ENDPOINT, { method: "POST", body: form });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(res.status === 413 || json.code === "invalid_upload" ? t("uploadRejected") : t("uploadFailed"));
        return;
      }
      toast.success(t("uploaded"));
      await load(null);
    } catch {
      toast.error(t("uploadFailed"));
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const remove = async (item: LibraryItem) => {
    if (!window.confirm(t("deleteConfirm", { name: item.filename }))) return;
    setDeleting(item.id);
    try {
      const res = await authFetch(`${ENDPOINT}/${item.id}`, { method: "DELETE" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(res.status === 403 ? t("deleteForbidden") : t("deleteFailed"));
        return;
      }
      toast.success(json.outcome === "hidden" ? t("hidden") : t("deleted"));
      await load(null);
    } catch {
      toast.error(t("deleteFailed"));
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-40 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("search")} aria-label={t("search")} maxLength={100} className="pl-8" />
        </div>
        {canUpload && (
          <>
            <input ref={fileInput} type="file" accept={ACCEPT} className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
            <Button type="button" variant="outline" size="sm" disabled={uploading} onClick={() => fileInput.current?.click()}>
              {uploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
              {t("upload")}
            </Button>
          </>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("filter")}>
        {KINDS.map((k) => (
          <Button key={k} type="button" size="sm" variant={kind === k ? "secondary" : "ghost"} aria-pressed={kind === k} onClick={() => setKind(k)}>
            {t(`kinds.${k}`)}
          </Button>
        ))}
      </div>

      <div className="min-h-48 overflow-y-auto">
        {failed ? (
          <p className="py-10 text-center text-sm text-destructive">{t("loadFailed")}</p>
        ) : !loading && items.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">{query || kind !== "all" ? t("noMatches") : t("empty")}</p>
        ) : (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
            {items.map((item) => (
              <li key={item.id} className="group relative overflow-hidden rounded-md border bg-card">
                <button
                  type="button"
                  disabled={mode !== "pick"}
                  onClick={() => onPick?.({ id: item.id, url: item.url, kind: item.kind, filename: item.filename })}
                  className={cn("flex w-full flex-col text-left", mode === "pick" && "cursor-pointer hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none")}
                  aria-label={mode === "pick" ? t("pick", { name: item.filename }) : item.filename}
                >
                  <span className="flex aspect-square w-full items-center justify-center overflow-hidden bg-muted"><Thumb item={item} /></span>
                  <span className="block truncate px-2 pt-1.5 text-xs font-medium">{item.filename}</span>
                  <span className="block px-2 pb-1.5 text-xs text-muted-foreground">{formatBytes(item.byte_size)}</span>
                </button>
                {mode === "manage" && item.can_delete && (
                  <Button
                    type="button"
                    size="icon"
                    variant="secondary"
                    className="absolute top-1.5 right-1.5 size-7"
                    disabled={deleting === item.id}
                    onClick={() => void remove(item)}
                    aria-label={t("delete", { name: item.filename })}
                  >
                    {deleting === item.id ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {loading && <div className="flex justify-center py-4"><Loader2 className="size-5 animate-spin text-muted-foreground" aria-label={t("loading")} /></div>}
        {!loading && cursor && !failed && (
          <div className="flex justify-center pt-3">
            <Button type="button" variant="outline" size="sm" onClick={() => void load(cursor)}>{t("loadMore")}</Button>
          </div>
        )}
      </div>
    </div>
  );
}

export function MediaPicker({ open, onOpenChange, onPick, initialKind }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (media: PickedMedia) => void;
  initialKind?: MediaKind | "all";
}) {
  const t = useTranslations("MediaLibrary");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("pickerTitle")}</DialogTitle>
          <DialogDescription>{t("pickerDescription")}</DialogDescription>
        </DialogHeader>
        {open && (
          <MediaLibraryBrowser
            mode="pick"
            initialKind={initialKind}
            onPick={(media) => { onPick(media); onOpenChange(false); }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
