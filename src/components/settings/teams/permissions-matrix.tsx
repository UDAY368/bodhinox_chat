"use client";

/**
 * Settings → Team members: feature permissions. A grid of roles x features.
 * A feature can only be turned off for a role that has it by default; it can
 * never be turned on above the role's built-in level. Owners always keep
 * everything; only an owner can change the admin column
 * (GET/PUT /api/account/permissions).
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { authFetch } from "@/lib/auth/client";
import type { AccountRole } from "@/lib/auth/roles";
import { hasMinRole } from "@/lib/auth/roles";

interface PermissionsView {
  permissions: { key: string; minimum_role: AccountRole }[];
  roles: AccountRole[];
  matrix: Record<AccountRole, Record<string, boolean>>;
  editable_roles: AccountRole[];
}

const ENDPOINT = "/api/account/permissions";
/** Message keys are flat ("campaigns_send"): next-intl reads a dot as nesting. */
const labelKey = (permission: string) => permission.replace(".", "_");

export function PermissionsMatrix({ canEdit }: { canEdit: boolean }) {
  const t = useTranslations("Settings.permissions");
  const tRoles = useTranslations("Settings.roles");
  const [view, setView] = useState<PermissionsView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await authFetch(ENDPOINT, { cache: "no-store" });
      if (!res.ok) throw new Error();
      setView((await res.json()) as PermissionsView);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    if (canEdit) void load();
  }, [canEdit, load]);

  if (!canEdit) return null;

  const change = async (role: AccountRole, permission: string, allowed: boolean) => {
    setBusy(`${role}:${permission}`);
    try {
      const res = await authFetch(ENDPOINT, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ role, permission, allowed }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : t("saveFailed"));
      setView(body as PermissionsView);
      toast.success(t("saved"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("saveFailed"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">{t("title")}</CardTitle>
        <CardDescription className="text-muted-foreground">{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {loadFailed ? (
          <p className="text-xs text-destructive">{t("loadFailed")}</p>
        ) : !view ? (
          <Loader2 className="size-4 animate-spin text-primary" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[32rem] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-2 pr-3 font-medium">{t("feature")}</th>
                  {view.roles.map((role) => (
                    <th key={role} scope="col" className="px-2 py-2 text-center font-medium">{tRoles(role)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {view.permissions.map(({ key, minimum_role }) => (
                  <tr key={key} className="border-b border-border last:border-0">
                    <th scope="row" className="py-2 pr-3 text-left font-normal text-foreground">
                      {t(`features.${labelKey(key)}`)}
                    </th>
                    {view.roles.map((role) => {
                      const ceiling = hasMinRole(role, minimum_role);
                      const editable = ceiling && view.editable_roles.includes(role);
                      return (
                        <td key={role} className="px-2 py-2 text-center">
                          {ceiling ? (
                            <Switch
                              checked={view.matrix[role]?.[key] ?? false}
                              disabled={!editable || busy !== null}
                              onCheckedChange={(on) => change(role, key, on)}
                              aria-label={t("toggle", { feature: t(`features.${labelKey(key)}`), role: tRoles(role) })}
                            />
                          ) : (
                            <span className="text-xs text-muted-foreground" title={t("aboveRole")}>{t("notAvailable")}</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-xs text-muted-foreground">{t("footnote")}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
