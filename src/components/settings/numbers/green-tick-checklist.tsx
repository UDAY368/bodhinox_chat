/**
 * Settings → WhatsApp numbers: what Meta looks for before it grants the green
 * tick (Official Business Account). Static guidance only: there is no API to
 * apply, so every step links to where it is done in Meta's own tools.
 *
 * `nameStatus` (whatsapp_config.name_status from the health sync) marks the
 * display-name step done or rejected when known; everything else is guidance.
 */

import { CheckCircle2, Circle, ExternalLink, XCircle } from "lucide-react";
import { useTranslations } from "next-intl";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type StepKey = "businessVerification" | "displayName" | "twoStep" | "notability" | "request";

const STEPS: { key: StepKey; href: string }[] = [
  { key: "businessVerification", href: "https://business.facebook.com/settings/security" },
  { key: "displayName", href: "https://business.facebook.com/wa/manage/phone-numbers/" },
  { key: "twoStep", href: "https://business.facebook.com/wa/manage/phone-numbers/" },
  { key: "notability", href: "https://developers.facebook.com/docs/whatsapp/overview/business-accounts" },
  { key: "request", href: "https://business.facebook.com/wa/manage/phone-numbers/" },
];

const APPROVED_NAMES = new Set(["APPROVED", "AVAILABLE_WITHOUT_REVIEW"]);
const REJECTED_NAMES = new Set(["DECLINED", "REJECTED"]);

export function GreenTickChecklist({ nameStatus }: { nameStatus?: string | null }) {
  const t = useTranslations("Settings.greenTick");
  const name = nameStatus?.toUpperCase() ?? null;
  const state = (key: StepKey): "done" | "rejected" | "todo" =>
    key !== "displayName" || !name ? "todo" : APPROVED_NAMES.has(name) ? "done" : REJECTED_NAMES.has(name) ? "rejected" : "todo";

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="space-y-4">
          {STEPS.map(({ key, href }) => {
            const status = state(key);
            const Icon = status === "done" ? CheckCircle2 : status === "rejected" ? XCircle : Circle;
            return (
              <li key={key} className="flex gap-3">
                <Icon
                  aria-hidden
                  className={`mt-0.5 size-5 shrink-0 ${status === "done" ? "text-emerald-600" : status === "rejected" ? "text-destructive" : "text-muted-foreground"}`}
                />
                <div className="min-w-0 space-y-1">
                  <p className="text-sm font-medium text-foreground">
                    {t(`steps.${key}.title`)}
                    {status !== "todo" && <span className="sr-only"> ({t(`status.${status}`)})</span>}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {status === "rejected" ? t("steps.displayName.rejected") : t(`steps.${key}.body`)}
                  </p>
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                  >
                    {t(`steps.${key}.link`)}
                    <ExternalLink aria-hidden className="size-3.5" />
                    <span className="sr-only">{t("opensInNewTab")}</span>
                  </a>
                </div>
              </li>
            );
          })}
        </ol>
        <p className="mt-4 text-xs text-muted-foreground">{t("footnote")}</p>
      </CardContent>
    </Card>
  );
}
