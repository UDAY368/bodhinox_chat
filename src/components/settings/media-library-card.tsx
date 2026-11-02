"use client";

/**
 * Settings → Media library: how much storage the workspace's files use and
 * a "Manage" dialog to upload or delete library files. No plan sets a
 * storage cap yet, so the meter shows usage alone unless the server
 * reports a limit. Agents delete their own uploads; admins delete any.
 */

import { useCallback, useEffect, useState } from "react";
import { FolderOpen, HardDrive } from "lucide-react";
import { useTranslations } from "next-intl";

import { MediaLibraryBrowser, useFormatBytes, type StorageUsage } from "@/components/inbox/media-library/media-picker";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { authFetch } from "@/lib/auth/client";

export function MediaLibraryCard({ className }: { className?: string }) {
  const t = useTranslations("MediaLibrary");
  const formatBytes = useFormatBytes();
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let live = true;
    authFetch("/api/media/library?limit=1", { cache: "no-store" })
      .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then((json: { usage?: StorageUsage }) => { if (live && json.usage) setUsage(json.usage); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);

  const onUsage = useCallback((next: StorageUsage) => setUsage(next), []);
  const percent = usage?.limit_bytes ? Math.min(100, Math.round((usage.used_bytes / usage.limit_bytes) * 100)) : null;

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><HardDrive className="size-4" aria-hidden />{t("settingsTitle")}</CardTitle>
        <CardDescription>{t("settingsDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {failed ? (
          <p className="text-sm text-destructive">{t("usageFailed")}</p>
        ) : !usage ? (
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        ) : (
          <div className="space-y-2">
            <p className="text-sm font-medium">
              {usage.limit_bytes
                ? t("usedOfLimit", { used: formatBytes(usage.used_bytes), limit: formatBytes(usage.limit_bytes) })
                : t("used", { used: formatBytes(usage.used_bytes) })}
            </p>
            {percent !== null && (
              <div
                className="h-2 w-full overflow-hidden rounded-full bg-muted"
                role="meter"
                aria-label={t("meterLabel")}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
              >
                <div className={percent >= 90 ? "h-full bg-destructive" : "h-full bg-primary"} style={{ width: `${percent}%` }} />
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              {t("libraryCount", { count: usage.library_count, size: formatBytes(usage.library_bytes) })}
            </p>
          </div>
        )}
        <Button type="button" variant="outline" onClick={() => setOpen(true)}>
          <FolderOpen className="size-4" aria-hidden />
          {t("manage")}
        </Button>
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t("manageTitle")}</DialogTitle>
            <DialogDescription>{t("manageDescription", { days: 30 })}</DialogDescription>
          </DialogHeader>
          {open && <MediaLibraryBrowser mode="manage" onUsage={onUsage} />}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
