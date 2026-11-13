"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useLocale } from "next-intl";

import { useAuth } from "@/hooks/use-auth";
import { useBrowserNotifications } from "@/hooks/use-browser-notifications";
import { authFetch } from "@/lib/auth/client";
import { syncLocale } from "@/lib/i18n/locale-client";
import { QUIET_HOURS_EVENT, setQuietHours } from "@/lib/notifications/quiet-hours-store";

/**
 * Headless. Mount ONCE per signed-in dashboard tab (the dashboard
 * shell, below the auth gate) so desktop notifications for new customer
 * messages fire on every dashboard page, not just the inbox. It also loads
 * the member's quiet hours (which hold those alerts back) and keeps the
 * interface language in step with the member's or workspace's choice.
 */
export function BrowserNotificationsListener() {
  useBrowserNotifications();
  const { accountId } = useAuth();
  const router = useRouter();
  const locale = useLocale();

  useEffect(() => {
    if (!accountId) return;
    let live = true;
    void authFetch("/api/notifications/preferences", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok || !live) return;
        const body = (await response.json()) as { quiet_hours?: Parameters<typeof setQuietHours>[0] };
        setQuietHours(body.quiet_hours ?? null);
      })
      .catch(() => undefined);
    void syncLocale().then((state) => {
      // Reload messages only when the shown language is not the chosen one.
      if (live && state && state.effective !== locale) router.refresh();
    });
    const onChange = (event: Event) => setQuietHours((event as CustomEvent).detail ?? null);
    window.addEventListener(QUIET_HOURS_EVENT, onChange);
    return () => {
      live = false;
      window.removeEventListener(QUIET_HOURS_EVENT, onChange);
    };
  }, [accountId, router, locale]);

  return null;
}
