"use client";

import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { FormStatus } from "@/lib/whatsapp/forms/types";

const STATUS_COLORS: Record<FormStatus, string> = {
  draft: "bg-muted text-muted-foreground",
  published: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400",
  deprecated: "bg-muted text-muted-foreground",
  blocked: "bg-red-500/12 text-red-600 dark:text-red-400",
  throttled: "bg-amber-500/12 text-amber-700 dark:text-amber-400",
  error: "bg-red-500/12 text-red-600 dark:text-red-400",
};

export function FormStatusBadge({ status, className }: { status: FormStatus; className?: string }) {
  const t = useTranslations("Forms.status");
  return (
    <Badge variant="outline" className={cn("shrink-0 rounded-full border-transparent px-2.5 text-xs font-medium", STATUS_COLORS[status], className)}>
      {t(status)}
    </Badge>
  );
}
