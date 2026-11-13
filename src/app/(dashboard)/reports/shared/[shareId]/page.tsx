"use client";

/**
 * A report shared inside the workspace. The link holds only the share id;
 * downloading it (GET /api/reports/shared/[shareId]) needs a live session in
 * the share's workspace at the share's minimum role, before it expires or is
 * revoked. Every refusal is the same "not available" answer, which may mean
 * the share belongs to another workspace: switching workspace and opening the
 * link again is the remedy offered. What the share is and until when it
 * opens is read first (GET .../info), which counts no open.
 */

import { use, useEffect, useState } from "react";
import { Download, FileText, Loader2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { authFetch } from "@/lib/auth/client";
import { isReportFileResponse, needsSignIn } from "@/lib/analytics/report-download";

const FILENAME = /filename="([^"]+)"/;

type ShareInfo = { kind: string; format: "csv" | "pdf"; expiresAt: string };

export default function SharedReportPage({ params }: { params: Promise<{ shareId: string }> }) {
  const { shareId } = use(params);
  const t = useTranslations("Analytics.reports.shared");
  const tReports = useTranslations("Analytics.reports");
  const format = useFormatter();
  const router = useRouter();
  const [state, setState] = useState<"idle" | "loading" | "done" | "unavailable" | "failed">("idle");
  const [info, setInfo] = useState<ShareInfo | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    authFetch(`/api/reports/shared/${encodeURIComponent(shareId)}/info`, { cache: "no-store", signal: controller.signal })
      .then(async (res) => {
        if (res.ok) setInfo(((await res.json()) as { share: ShareInfo }).share);
        else if (res.status === 404) setState("unavailable");
      })
      .catch(() => {
        // The download button still works; the details are optional.
      });
    return () => controller.abort();
  }, [shareId]);

  const download = async () => {
    setState("loading");
    try {
      const res = await authFetch(`/api/reports/shared/${encodeURIComponent(shareId)}`, { cache: "no-store" });
      if (res.status === 404 || res.status === 403) {
        setState("unavailable");
        return;
      }
      // authFetch already tried a token refresh: the session is gone. Never
      // save what a followed redirect returned (the sign-in page).
      if (needsSignIn(res)) {
        router.push(`/login?next=${encodeURIComponent(`/reports/shared/${shareId}`)}`);
        setState("idle");
        return;
      }
      if (!isReportFileResponse(res)) throw new Error();
      const blob = await res.blob();
      const name = FILENAME.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "report";
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setState("done");
    } catch {
      setState("failed");
    }
  };

  return (
    <div className="mx-auto w-full max-w-xl space-y-6 pt-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <span className="flex size-9 items-center justify-center rounded-[10px] bg-primary/10 text-primary"><FileText className="size-4" aria-hidden /></span>
            {t("title")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">{t("description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {info && (
            <p className="text-sm text-foreground" data-testid="shared-report-info">
              {t("details", {
                kind: tReports(`kinds.${info.kind}`),
                format: info.format.toUpperCase(),
                expires: format.dateTime(new Date(info.expiresAt), { dateStyle: "medium", timeStyle: "short" }),
              })}
            </p>
          )}
          <Button type="button" onClick={download} disabled={state === "loading"}>
            {state === "loading" ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
            {t("download")}
          </Button>
          {state === "done" && <p className="text-xs text-muted-foreground" role="status">{t("downloaded")}</p>}
          {state === "unavailable" && (
            <p className="text-sm text-destructive" role="alert">{t("unavailable")}</p>
          )}
          {state === "failed" && <p className="text-sm text-destructive" role="alert">{t("failed")}</p>}
          <p className="text-xs text-muted-foreground">{t("privacy")}</p>
        </CardContent>
      </Card>
    </div>
  );
}
