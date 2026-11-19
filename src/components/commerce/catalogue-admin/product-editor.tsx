"use client";

/**
 * One catalogue product on its own page (deep links to /commerce/catalogue/<id>):
 * the same one-page form as the sheet on the catalogue list, with one Save.
 * Going back with unsaved changes asks first.
 */
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ProductForm } from "./product-form";

export function ProductEditor({ id }: { id: string }) {
  const t = useTranslations("Commerce.catalogue.editor");
  const tf = useTranslations("Commerce.catalogue.form");
  const router = useRouter();
  const [dirty, setDirty] = useState(false);
  const [asking, setAsking] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <Link href="/commerce/catalogue" className="inline-flex min-h-11 items-center gap-1 text-sm text-muted-foreground hover:text-foreground sm:min-h-0"
        onClick={(e) => { if (dirty) { e.preventDefault(); setAsking(true); } }}>
        <ArrowLeft className="h-4 w-4" />{t("back")}
      </Link>
      <div className="flex flex-col rounded-xl border border-border bg-card">
        <ProductForm id={id} onDirtyChange={setDirty} />
      </div>
      <Dialog open={asking} onOpenChange={setAsking}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{tf("discardTitle")}</DialogTitle>
            <DialogDescription>{tf("discardBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAsking(false)}>{tf("keepEditing")}</Button>
            <Button variant="destructive" onClick={() => { setAsking(false); setDirty(false); router.push("/commerce/catalogue"); }}>{tf("discard")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
