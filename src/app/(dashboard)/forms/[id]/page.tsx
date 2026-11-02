"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { useCan } from "@/hooks/use-can";
import { buttonVariants } from "@/components/ui/button";
import { FormBuilder } from "@/components/forms/form-builder";
import { getForm, loadEncryptionStatus } from "@/components/forms/form-api";
import type { WhatsAppForm } from "@/lib/whatsapp/forms/types";

interface Loaded {
  id: string;
  form: WhatsAppForm | null;
  encryptionConfigured: boolean;
}

/**
 * Form builder shell. Loads the form and the account's encryption-key
 * status, then hands both to <FormBuilder>. A form from another account
 * 404s at the API (RLS) and lands on the not-found state.
 */
export default function FormEditorPage() {
  const params = useParams<{ id: string }>();
  const t = useTranslations("Forms.edit");
  const canManage = useCan("edit-settings");
  // Tagged with the id it was loaded for, so a route change to another form
  // (e.g. after "Duplicate to edit") shows the spinner instead of stale data.
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    if (!params.id) return;
    const id = params.id;
    let cancelled = false;
    Promise.all([getForm(id), loadEncryptionStatus()])
      .then(([form, encryption]) => {
        if (!cancelled) setLoaded({ id, form, encryptionConfigured: encryption.configured });
      })
      .catch(() => {
        if (cancelled) return;
        toast.error(t("loadError"));
        setLoaded({ id, form: null, encryptionConfigured: false });
      });
    return () => {
      cancelled = true;
    };
  }, [params.id, t]);

  if (!loaded || loaded.id !== params.id) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label={t("loading")} />
      </div>
    );
  }

  if (!loaded.form) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-muted-foreground">{t("notFound")}</p>
        <Link href="/forms" className={buttonVariants({ variant: "outline", size: "sm" })}>
          {t("backToList")}
        </Link>
      </div>
    );
  }

  return (
    <FormBuilder
      key={loaded.form.id}
      initialForm={loaded.form}
      canManage={canManage}
      encryptionConfigured={loaded.encryptionConfigured}
    />
  );
}
