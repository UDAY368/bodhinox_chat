"use client";

import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { FormStatus } from "@/lib/whatsapp/forms/types";

const STATUS_COLORS: Record<FormStatus, string> = {
  draft: "border-border bg-muted text-muted-foreground",
  published: "border-emerald-600/40 bg-emerald-500/10 text-emerald-500",
  deprecated: "border-border bg-muted/50 text-muted-foreground",
  blocked: "border-red-500/40 bg-red-500/10 text-red-500",
  throttled: "border-amber-500/40 bg-amber-500/10 text-amber-500",
  error: "border-red-500/40 bg-red-500/10 text-red-500",
};

export function FormStatusBadge({ status, className }: { status: FormStatus; className?: string }) {
  const t = useTranslations("Forms.status");
  return (
    <Badge variant="outline" className={cn("shrink-0 text-[10px]", STATUS_COLORS[status], className)}>
      {t(status)}
    </Badge>
  );
}
