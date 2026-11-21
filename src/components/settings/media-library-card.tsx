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
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { authFetch } from "@/lib/auth/client";
import { GroupedListRow } from "@/components/ui/grouped-list";
import { cn } from "@/lib/utils";
import { SETTINGS_ROW_HAIRLINE, SettingsGroup } from "./settings-row";

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
    <SettingsGroup
      className={className}
      title={<><HardDrive className="size-4" aria-hidden />{t("settingsTitle")}</>}
      footer={t("settingsDescription")}
      action={
        <Button type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={() => setOpen(true)}>
          <FolderOpen className="size-4" aria-hidden />
          {t("manage")}
        </Button>
      }
    >
      {failed ? (
        <div className={cn(SETTINGS_ROW_HAIRLINE, "flex min-h-11 items-center px-4 py-3 text-sm text-destructive")}>{t("usageFailed")}</div>
      ) : !usage ? (
        <div className={cn(SETTINGS_ROW_HAIRLINE, "space-y-2 px-4 py-3")} aria-busy="true" aria-label={t("loading")}>
          <div className="h-4 w-1/3 animate-pulse rounded bg-muted" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
        </div>
      ) : (
        <>
          <GroupedListRow
            title={usage.limit_bytes
              ? t("usedOfLimit", { used: formatBytes(usage.used_bytes), limit: formatBytes(usage.limit_bytes) })
              : t("used", { used: formatBytes(usage.used_bytes) })}
            subtitle={t("libraryCount", { count: usage.library_count, size: formatBytes(usage.library_bytes) })}
          />
          {percent !== null && (
            <div className={cn(SETTINGS_ROW_HAIRLINE, "px-4 py-3")}>
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
            </div>
          )}
        </>
      )}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent size="lg" className="w-full gap-4 overflow-y-auto p-4">
          <SheetHeader className="p-0 pr-8">
            <SheetTitle>{t("manageTitle")}</SheetTitle>
            <SheetDescription>{t("manageDescription", { days: 30 })}</SheetDescription>
          </SheetHeader>
          {open && <MediaLibraryBrowser mode="manage" onUsage={onUsage} />}
        </SheetContent>
      </Sheet>
    </SettingsGroup>
  );
}
